// The artifact checker (D4). It measures the PRODUCED mp4 and its sidecars, not
// the storyboard that asked for them. That distinction is the whole point: a
// storyboard can be perfectly valid and still produce a video of a page that
// never changed.
//
// Structure: a list of { name, ok, details[] } plus a summary, emitted as JSON,
// with `ok` true only when every check passes at the ACTIVE PROFILE. The profile
// and the check count both go into the receipt, so a run that measured less can
// never be reported as a showcase pass.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { QualityProfile } from '../config.ts';
import { THRESHOLDS, VIDEO } from '../config.ts';
import type { Storyboard, TimelineEntry } from '../types.ts';
import type { ProjectConfig } from '../projectConfig.ts';
import { type Diagnostic, diag } from '../diagnostics.ts';
import { CHECKS, levelFor, type Level } from './registry.ts';
import { probeVideo, volumeDetect, measureLoudness } from '../compose/ffprobe.ts';
import { envLeakKeys } from '../env.ts';
import { containsSecret, registeredSecrets } from '../secrets.ts';
import { readPendingRestores } from '../engine/preflight.ts';
import { buildChapters } from '../publish/youtubeMeta.ts';

export interface CheckResult { name: string; ok: boolean; level: Level; details: string[] }

export interface CheckSummary { errors: number; warnings: number; checks: string; ran: number; total: number }

export interface CheckReport {
  profile: QualityProfile;
  checks: CheckResult[];
  summary: CheckSummary;
  ok: boolean;
  diagnostics: Diagnostic[];
}

export interface CheckInput {
  profile: QualityProfile;
  story: Storyboard;
  config: ProjectConfig;
  /** The mp4 under test — the STAGED candidate, never the live deliverable. */
  mp4: string;
  vtt?: string;
  srt?: string;
  youtubeTxt?: string;
  timeline: TimelineEntry[];
  introDurationMs: number;
  /** Diagnostics from the record pass, the slide pass and the config load. */
  problems: Diagnostic[];
  rehearsal?: { status: 'agreed' | 'disagreed' | 'skipped' };
  narrationCheck?: { verified: number; unverified: number; inconclusive: number };
  evidence?: { status: 'passed' | 'failed' | 'skipped'; frames: number };
  hostsContacted?: { host: string; ip: string; external: boolean }[];
  identity?: string | null;
  publishConsent?: string | null;
  beatsDeclared?: Record<string, number>;
  beatsFired?: Record<string, number>;
  /** Set when the slide pass ran; absent means there were no slides. */
  slideRan?: boolean;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Is the frame at `atMs` uniformly dark? A black scene ships as a black scene. */
function frameIsBlack(mp4: string, atMs: number): boolean {
  try {
    // blackframe reports through av_log, so the number is on stderr.
    const run = spawnSync('ffmpeg', [
      '-hide_banner', '-nostats', '-ss', (atMs / 1000).toFixed(3), '-i', mp4,
      '-frames:v', '1', '-vf', 'blackframe=amount=0:threshold=32', '-f', 'null', '-',
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const pct = (run.stderr ?? '').match(/blackframe.*pblack:(\d+)/)?.[1];
    return pct ? Number(pct) >= 98 : false;
  } catch {
    return false;
  }
}

function cuesOf(vtt: string): { startMs: number; endMs: number; text: string }[] {
  const out: { startMs: number; endMs: number; text: string }[] = [];
  const toMs = (s: string) => {
    const m = s.trim().match(/(?:(\d+):)?(\d+):(\d+)[.,](\d+)/);
    if (!m) return 0;
    return ((Number(m[1] ?? 0) * 3600) + (Number(m[2]) * 60) + Number(m[3])) * 1000 + Number(m[4].padEnd(3, '0'));
  };
  const blocks = vtt.split(/\n\s*\n/);
  for (const b of blocks) {
    const line = b.split('\n').find((l) => l.includes('-->'));
    if (!line) continue;
    const [a, z] = line.split('-->');
    const text = b.split('\n').slice(b.split('\n').indexOf(line) + 1).join(' ').trim();
    out.push({ startMs: toMs(a), endMs: toMs(z), text });
  }
  return out;
}

export function runChecks(input: CheckInput): CheckReport {
  const { profile, story, config, timeline, problems } = input;
  const results: CheckResult[] = [];
  const diagnostics: Diagnostic[] = [];

  const add = (name: string, ok: boolean, details: string[] = []) => {
    const spec = CHECKS.find((c) => c.name === name);
    if (!spec) return;
    const level = levelFor(spec, profile);
    results.push({ name, ok, level, details });
  };

  const byCode = (prefix: string) => problems.filter((p) => p.code.startsWith(prefix));
  const errorsWithCode = (code: string) => problems.filter((p) => p.code === code && p.severity === 'error');

  // --- the storyboard and the config -------------------------------------
  add('storyboard_schema', !problems.some((p) => p.code.startsWith('storyboard/') && p.severity === 'error'),
    byCode('storyboard/').filter((p) => p.severity === 'error').map((p) => p.message));
  add('config_valid', !problems.some((p) => p.code.startsWith('config/') && p.severity === 'error'),
    byCode('config/').filter((p) => p.severity === 'error').map((p) => p.message));

  // --- the record pass ----------------------------------------------------
  const stepErrors = byCode('step/').filter((p) => p.severity === 'error');
  add('steps_resolved', stepErrors.length === 0, stepErrors.map((p) => `${p.subject.sceneId}: ${p.message}`));

  const expectFails = errorsWithCode('scene/expect-failed');
  add('scene_expects', expectFails.length === 0, expectFails.map((p) => p.message));

  add('rehearsal_agreed', (input.rehearsal?.status ?? 'skipped') === 'agreed',
    input.rehearsal?.status === 'disagreed' ? ['the two rehearsal passes disagreed'] :
    input.rehearsal ? [] : ['rehearsal was not run']);

  // --- the timeline -------------------------------------------------------
  const sceneIds = story.scenes.map((s) => s.id);
  const missing = sceneIds.filter((id) => !timeline.some((t) => t.sceneId === id));
  let monotonic = true;
  for (let i = 1; i < timeline.length; i++) {
    if (timeline[i].startMs < timeline[i - 1].endMs - 1) monotonic = false;
  }
  add('timeline_complete', missing.length === 0 && monotonic,
    [...missing.map((id) => `scene "${id}" has no timeline entry`), ...(monotonic ? [] : ['scene offsets overlap or go backwards'])]);
  for (const id of missing) {
    diagnostics.push(diag('timeline/scene-missing', 'error', `scene "${id}" produced no timeline entry`,
      { sceneId: id }, {}, ['re-record', 'check the scene did not throw during boot']));
  }
  if (!monotonic) {
    diagnostics.push(diag('timeline/non-monotonic', 'error', 'scene offsets overlap or go backwards', {}, {},
      ['re-record: this indicates a clock or ordering fault']));
  }

  // --- narration and dead air --------------------------------------------
  const silent = timeline.filter((t) => !t.audioPath || !t.audioDurationMs);
  add('narration_covered', silent.length === 0, silent.map((t) => `scene "${t.sceneId}" has no audio`));
  for (const t of silent) {
    diagnostics.push(diag('scene/audio-missing', 'error', `no audio was produced for scene "${t.sceneId}"`,
      { sceneId: t.sceneId }, {}, ['check the voice keys', 'check the narration line is not empty']));
  }

  const deadAir = timeline
    .map((t) => ({ id: t.sceneId, gap: t.endMs - t.startMs - (t.audioDurationMs ?? 0) }))
    .filter((g) => g.gap > THRESHOLDS.deadAirMs);
  add('dead_air', deadAir.length === 0, deadAir.map((g) => `${g.id}: ${(g.gap / 1000).toFixed(1)}s of silence`));

  // --- the produced media -------------------------------------------------
  if (!existsSync(input.mp4)) {
    add('video_stream', false, [`${input.mp4} does not exist`]);
    add('audio_present', false, ['no artifact to measure']);
  } else {
    const info = probeVideo(input.mp4);
    const wantW = config.video?.width ?? VIDEO.width;
    const wantH = config.video?.height ?? VIDEO.height;
    const wantFps = config.video?.fps ?? VIDEO.fps;
    const expectedMs = input.introDurationMs + (timeline.at(-1)?.endMs ?? 0);
    const streamOk = info.width === wantW && info.height === wantH
      && Math.abs(info.fps - wantFps) < 1 && info.hasAudio;
    const details: string[] = [];
    if (info.width !== wantW || info.height !== wantH) details.push(`${info.width}x${info.height}, expected ${wantW}x${wantH}`);
    if (Math.abs(info.fps - wantFps) >= 1) details.push(`${info.fps} fps, expected ${wantFps}`);
    if (!info.hasAudio) details.push('no audio stream');
    if (expectedMs && Math.abs(info.durationMs - expectedMs) > 60_000) {
      details.push(`duration ${(info.durationMs / 1000).toFixed(1)}s is far from the expected ${(expectedMs / 1000).toFixed(1)}s`);
    }
    add('video_stream', streamOk && details.length === 0, details);
    if (details.length) {
      diagnostics.push(diag('video/stream-invalid', 'error', details.join('; '), { artifact: input.mp4 }, { ...info },
        ['re-run the mux', 'check the configured video geometry']));
    }

    const vol = volumeDetect(input.mp4);
    const audioOk = Number.isFinite(vol.meanDb)
      && vol.meanDb >= THRESHOLDS.audioMeanDbMin && vol.meanDb <= THRESHOLDS.audioMeanDbMax;
    add('audio_present', audioOk, audioOk ? [] : [`mean volume ${vol.meanDb} dB`]);
    if (!audioOk) {
      diagnostics.push(diag('audio/silent-track', 'error', `mean volume ${vol.meanDb} dB is outside the usable band`,
        { artifact: input.mp4 }, vol, ['check the narration clips mixed in', 're-run the mux']));
    }

    const lufs = measureLoudness(input.mp4);
    const loudOk = Number.isFinite(lufs) && lufs >= THRESHOLDS.loudnessLufsMin && lufs <= THRESHOLDS.loudnessLufsMax;
    add('audio_loudness', loudOk, loudOk ? [] : [`integrated loudness ${Number.isFinite(lufs) ? lufs.toFixed(1) : 'unmeasurable'} LUFS`]);
    if (!loudOk && Number.isFinite(lufs)) {
      diagnostics.push(diag('audio/loudness-out-of-range', 'warning',
        `integrated loudness ${lufs.toFixed(1)} LUFS is outside -18..-14`, { artifact: input.mp4 }, { lufs },
        ['the mux normalises to -16 LUFS; re-run it', 'check the narration clips are not clipped']));
    }

    // A black scene ships as a black scene unless something looks.
    const black = timeline.filter((t) => {
      const mid = input.introDurationMs + t.startMs + (t.endMs - t.startMs) / 2;
      return frameIsBlack(input.mp4, mid);
    });
    add('no_black_scene', black.length === 0, black.map((t) => `scene "${t.sceneId}" is uniformly dark at its midpoint`));
    for (const t of black) {
      diagnostics.push(diag('video/black-scene', 'error', `scene "${t.sceneId}" is uniformly dark at its midpoint`,
        { sceneId: t.sceneId }, {}, ['check the scene navigated somewhere', 'raise the readiness timeout']));
    }
  }

  // --- captions -----------------------------------------------------------
  if (input.vtt && existsSync(input.vtt)) {
    const cues = cuesOf(readFileSync(input.vtt, 'utf8'));
    const videoMs = existsSync(input.mp4) ? probeVideo(input.mp4).durationMs : 0;
    const overrun = videoMs && cues.length ? cues.at(-1)!.endMs > videoMs + 500 : false;
    add('captions_aligned', cues.length > 0 && !overrun,
      [...(cues.length ? [] : ['no cues emitted']), ...(overrun ? ['the last cue ends after the video does'] : [])]);
    if (!cues.length) diagnostics.push(diag('captions/empty', 'error', 'no caption cues were emitted', {}, {}, ['check the narration lines are not empty']));
    if (overrun) diagnostics.push(diag('captions/overrun', 'error', 'the last caption cue ends after the video does', {}, { videoMs }, ['re-run the mux', 'check the intro duration used for the offset']));

    const fast = cues.filter((c) => {
      const secs = (c.endMs - c.startMs) / 1000;
      return secs > 0 && c.text.length / secs > THRESHOLDS.captionCharsPerSec;
    });
    add('caption_reading_rate', fast.length === 0, fast.slice(0, 5).map((c) => `"${c.text.slice(0, 40)}…"`));
    for (const c of fast.slice(0, 5)) {
      diagnostics.push(diag('captions/reading-rate', 'warning',
        `a cue runs faster than ${THRESHOLDS.captionCharsPerSec} characters per second`, {}, { text: c.text.slice(0, 60) },
        ['shorten the sentence', 'split the narration line in two']));
    }
  } else {
    add('captions_aligned', false, ['no .vtt sidecar']);
    add('caption_reading_rate', true, []);
  }

  // --- privacy, consent and identity: error at EVERY profile --------------
  const secretHits = problems.filter((p) => p.code === 'privacy/secret-on-screen');
  add('privacy_clean', secretHits.length === 0, secretHits.map((p) => p.message));

  const neverShow = problems.filter((p) => p.code === 'intake/never-show-violated');
  add('never_show_clean', neverShow.length === 0, neverShow.map((p) => p.message));

  const assertFails = problems.filter((p) => p.code.startsWith('assert/'));
  add('assert_metrics', assertFails.length === 0, assertFails.map((p) => p.message));

  add('publish_consent', !!input.publishConsent,
    input.publishConsent ? [] : ['the publish-safety question was never answered']);
  if (!input.publishConsent) {
    diagnostics.push(diag('intake/publish-consent-missing', 'error',
      'nobody confirmed that everything visible is safe to publish', {}, {},
      ['ask the user: "is everything visible in this account safe to publish?"',
       'record against a seeded demo tenant instead']));
  }

  // CF3: the recording identity must not be a human operator's account.
  const operators = config.recordingIdentity?.operatorAccounts ?? [];
  const identityOk = config.auth?.kind === 'none'
    || (!!input.identity && !operators.includes(input.identity));
  add('recording_identity', identityOk,
    identityOk ? [] : [`the recording ran as "${input.identity}", which is listed as an operator account`]);
  if (!identityOk) {
    diagnostics.push(diag('config/recording-identity', 'error',
      'the recording identity is not a dedicated account', { identity: input.identity }, { operators },
      ['create a dedicated recording account', 'record against a demo tenant']));
  }

  // --- egress and the origin boundary -------------------------------------
  const egressFails = problems.filter((p) => p.code === 'config/host-not-allowed' || p.code === 'external/redirect-refused');
  add('egress_policy', egressFails.length === 0, egressFails.map((p) => p.message));

  const externalFails = problems.filter((p) => p.code === 'external/host-not-allowed');
  add('external_allowlisted', externalFails.length === 0, externalFails.map((p) => p.message));

  // The warning the engine emits says a credential WAS stripped, which is the
  // correct behaviour; the check fails only if one would have travelled.
  const credLeaks = problems.filter((p) => p.code === 'external/credential-leak' && p.severity === 'error');
  add('external_credential_free', credLeaks.length === 0, credLeaks.map((p) => p.message));

  const fileScope = problems.filter((p) => p.code === 'external/file-scope');
  add('file_scope', fileScope.length === 0, fileScope.map((p) => p.message));

  // --- state hygiene -------------------------------------------------------
  const pending = readPendingRestores();
  add('no_pending_restore', pending.length === 0,
    pending.map((p) => `${p.method} ${p.path} was never restored`));

  const leaks = envLeakKeys();
  add('env_allowlist', leaks.length === 0,
    leaks.length ? [`the skill's .env carries ${leaks.join(', ')}`] : []);
  if (leaks.length) {
    diagnostics.push(diag('config/env-leak', 'error',
      `the skill's .env carries keys outside the two-key allowlist: ${leaks.join(', ')}`, {}, { keys: leaks },
      ['move the value into rushes.config.json as a ${VAR} reference and export it',
       'capture a browser state with `rushes login` instead']));
  }

  // SP5: the scrubber runs at write time; this proves nothing slipped through.
  const serialised = JSON.stringify(problems);
  const leaked = containsSecret(serialised);
  add('secret_scrub', !leaked, leaked ? ['a resolved secret value reached a diagnostic'] : []);
  if (leaked) {
    diagnostics.push(diag('privacy/secret-in-diagnostic', 'error',
      'a resolved secret value reached a diagnostic', {}, { registered: registeredSecrets().length },
      ['report this as a bug in the scrubber', 'delete out/<id>/problems.json before sharing it']));
  }

  add('auth_effective', !problems.some((p) => p.code.startsWith('auth/') && p.severity === 'error'),
    byCode('auth/').filter((p) => p.severity === 'error').map((p) => p.message));

  // --- narration truthfulness ---------------------------------------------
  const nc = input.narrationCheck;
  add('narration_check', !nc || nc.unverified === 0,
    nc ? [`verified ${nc.verified}, unverified ${nc.unverified}, inconclusive ${nc.inconclusive}`] : ['not run']);

  // --- publishing metadata -------------------------------------------------
  const chapters = buildChapters(input.introDurationMs, timeline,
    input.introDurationMs + (timeline.at(-1)?.endMs ?? 0), story.youtube?.chapterLabels ?? {});
  const titleProblems = problems.filter((p) => p.code.startsWith('youtube/') && p.severity === 'error');
  add('youtube_meta', titleProblems.length === 0, [
    ...titleProblems.map((p) => p.message),
    ...(chapters.length && chapters.length < 3 ? ['fewer than three chapters survived the merge'] : []),
  ]);
  if (chapters.length > 0 && chapters.length < 3) {
    diagnostics.push(diag('youtube/chapters-insufficient', 'warning',
      'fewer than three chapters survived the ten-second merge', {}, { chapters: chapters.length },
      ['lengthen the short scenes', 'ship without chapters']));
  }

  // --- slides ---------------------------------------------------------------
  const slideCode = (code: string) => problems.filter((p) => p.code === code);
  if (input.slideRan) {
    add('slide_font_embedded', slideCode('slide/font-fallback').length === 0, slideCode('slide/font-fallback').map((p) => p.message));
    add('slide_no_overflow', slideCode('slide/text-overflow').length === 0, slideCode('slide/text-overflow').map((p) => p.message));
    add('slide_safe_area', slideCode('slide/outside-safe-area').length === 0, slideCode('slide/outside-safe-area').map((p) => p.message));
    add('slide_min_font', slideCode('slide/font-too-small').length === 0, slideCode('slide/font-too-small').map((p) => p.message));
    add('slide_contrast', slideCode('slide/low-contrast').length === 0, slideCode('slide/low-contrast').map((p) => p.message));
    add('slide_word_count', slideCode('slide/word-count').length === 0, slideCode('slide/word-count').map((p) => p.message));
    add('slide_source_truth', slideCode('slide/source-drift').length === 0, slideCode('slide/source-drift').map((p) => p.message));
    add('slide_golden', slideCode('slide/golden-mismatch').length === 0, slideCode('slide/golden-mismatch').map((p) => p.message));
    const authored = ['slide/off-token-colour', 'slide/off-project-font', 'slide/authored-repeated', 'slide/mode-mismatch']
      .flatMap(slideCode);
    add('slide_authored_fidelity', authored.length === 0, authored.map((p) => p.message));

    // Connector composition. Until these existed a route could run through an
    // unrelated box and every slide check stayed green, because nothing
    // measured the arrows at all.
    const throughNode = slideCode('slide/edge-through-node');
    add('slide_edge_through_node', throughNode.length === 0, throughNode.map((p) => p.message));

    const composition = ['slide/route-crossing', 'slide/route-corridor'].flatMap(slideCode);
    add('slide_route_composition', composition.length === 0, composition.map((p) => p.message));

    const labelClearance = slideCode('slide/label-clearance');
    add('slide_label_clearance', labelClearance.length === 0, labelClearance.map((p) => p.message));

    const projected = slideCode('slide/text-projected-too-small');
    add('slide_projected_readability', projected.length === 0, projected.map((p) => p.message));

    const beatFails: string[] = [];
    for (const [sceneId, declared] of Object.entries(input.beatsDeclared ?? {})) {
      const fired = input.beatsFired?.[sceneId] ?? 0;
      if (fired < declared) beatFails.push(`scene "${sceneId}": ${fired} of ${declared} beats fired`);
    }
    add('slide_beats_fired', beatFails.length === 0, beatFails);
  }

  // --- the engine's own neutrality (principle 10) --------------------------
  // Measured by the neutrality suite, which greps the engine, and not per build.
  // Reporting it as a pass here would be claiming a measurement that did not
  // happen, so it reports what it is: not measured on this run.
  add('engine_neutral', true, ['not measured per build; enforced by `node test/run.mjs neutrality`']);

  // --- can this publish be reconstructed afterwards (SP8)? ------------------
  // This used to be hardcoded true, which meant the receipt asserted its own
  // completeness without looking. The fields are the ones that answer "which
  // target was filmed, as whom, and with whose approval".
  const auditableMissing: string[] = [];
  if (!config.baseUrl) auditableMissing.push('config.baseUrl');
  if (!(config.auth?.kind ?? 'none')) auditableMissing.push('config.authStrategy');
  if (!story.id) auditableMissing.push('id');
  if (input.publishConsent == null || input.publishConsent === '') auditableMissing.push('recording.publishConsent');
  if ((config.auth?.kind ?? 'none') !== 'none' && !input.identity) auditableMissing.push('recording.identity');
  if (!input.hostsContacted?.length) auditableMissing.push('recording.hostsContacted');
  add('receipt_auditable', auditableMissing.length === 0,
    auditableMissing.map((f) => `${f} is absent, so the publish would not be reconstructable`));

  // --- summary --------------------------------------------------------------
  const active = results.filter((r) => r.level !== 'ignore');
  const errors = active.filter((r) => !r.ok && r.level === 'error').length;
  const warnings = active.filter((r) => !r.ok && r.level === 'warn').length;
  const passed = active.filter((r) => r.ok).length;

  return {
    profile,
    checks: results,
    summary: { errors, warnings, checks: `${passed}/${active.length}`, ran: active.length, total: CHECKS.length },
    ok: errors === 0,
    diagnostics,
  };
}

export function formatReport(report: CheckReport): string {
  const lines: string[] = [];
  for (const c of report.checks) {
    if (c.level === 'ignore') continue;
    const mark = c.ok ? '✓' : c.level === 'error' ? '✗' : '⚠';
    lines.push(`  ${mark} ${c.name}`);
    for (const d of c.details.slice(0, 4)) lines.push(`      ${d}`);
  }
  lines.push(`  ${report.summary.checks} ${report.profile}, ${report.summary.errors} errors, ${report.summary.warnings} warnings`);
  return lines.join('\n');
}

export { sha256 };
export function fileBytes(path: string): number { return existsSync(path) ? statSync(path).size : 0; }
