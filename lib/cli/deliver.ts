// build and deliver.
//
// `build` runs the whole pipeline into a staging directory and checks the
// result. `deliver` is `build` plus the atomic commit and the receipt. They are
// the same code path with one flag, so a build can never pass a check the
// delivery would have failed.
//
// The order is fixed: voice first (its measured length is the clock), then the
// slide deck, then the recording, then captions, cards, mux, thumbnail, text,
// checks. Nothing is renamed into place until every check has passed.

import { writeFileSync, existsSync, copyFileSync, statSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { QualityProfile } from '../config.ts';
import { TIMING } from '../config.ts';
import { demoPaths, ensureDir, slidePaths } from '../paths.ts';
import { loadConfig } from '../projectConfig.ts';
import { loadStoryboard, storyboardPath } from '../storyboard.ts';
import { Diagnostics, printDiagnostics } from '../diagnostics.ts';
import { synth } from '../compose/tts.ts';
import { record, pacingReport } from '../engine/driver.ts';
import { buildVtt, buildSrt } from '../compose/subtitles.ts';
import { openingHtml, closingHtml, renderCardClip } from '../compose/cards.ts';
import { buildBody, assembleFinal, freezeSpans } from '../compose/mux.ts';
import { renderThumbnail } from '../thumbnail/index.ts';
import { buildYoutubeMeta, buildChapters, metaToTxt } from '../publish/youtubeMeta.ts';
import { buildLinkedinPost } from '../publish/linkedinPost.ts';
import { compileDeck } from '../slides/compile.ts';
import { renderSlides } from '../slides/render.ts';
import { checkSlides, checkGoldens } from '../slides/check.ts';
import { runChecks, formatReport, sha256, fileBytes } from '../check/index.ts';
import { scoreSheet, formatScore } from '../check/quality.ts';
import { openStaging, sweepStaleStaging } from '../check/deliver.ts';
import { writeReceipt, readReceipt, toolCommit, handoffReport, type Receipt } from '../check/receipt.ts';
import { extractEvidence } from '../check/evidence.ts';
import { checkNarration } from '../check/vision.ts';
import { rehearse } from '../check/rehearse.ts';
import { recordBuild } from '../publish/catalogue.ts';
import { memoryFloorDiagnostic, startApp, configSha256 } from '../runner/index.ts';
import { probeVideo } from '../compose/ffprobe.ts';
import { sweep, mb } from '../cleanup.ts';
import { openCommand } from '../platform.ts';
import { readIntroDurationMs, writeIntroDurationMs } from './misc.ts';

export interface DeliverOptions {
  id: string;
  quality: QualityProfile;
  headed: boolean;
  commit: boolean;          // deliver vs build
  rehearseFirst: boolean;
  allowLowMemory: boolean;
  nonInteractive: boolean;
  publishConsent?: string;
}

export async function buildAndDeliver(opts: DeliverOptions): Promise<number> {
  const { id } = opts;
  const problems = new Diagnostics();

  const loaded = loadConfig();
  problems.merge(loaded.diagnostics);
  const config = loaded.config;

  const sb = loadStoryboard(id, config);
  problems.merge(sb.diagnostics);
  const story = sb.story;

  // Schema and lint errors make everything after this meaningless: a step that
  // does not exist cannot be recorded, and a chapter for a scene that is not
  // there cannot be timed. Stop here rather than burning voice credits.
  if (problems.errors.length) {
    process.stderr.write('\nthe storyboard does not validate:\n');
    printDiagnostics(problems.errors);
    process.stderr.write('\nfix these first: `rushes validate ' + id + '`\n');
    return 1;
  }

  const mem = opts.allowLowMemory ? null : memoryFloorDiagnostic();
  if (mem) { printDiagnostics([mem]); return 1; }

  const P = demoPaths(id);
  let rehearsalResult: Awaited<ReturnType<typeof rehearse>> | null = null;
  ensureDir(P.dir);
  ensureDir(P.vttDir);
  ensureDir(P.evidenceDir);
  const swept = sweepStaleStaging(id);
  if (swept) process.stderr.write(`  swept ${swept} stale staging director${swept === 1 ? 'y' : 'ies'}\n`);

  // Optional: start the app. Never without recorded consent for this exact
  // config (SP1).
  let stopApp: (() => Promise<void>) | null = null;
  if (config.runner) {
    const app = await startApp(config.runner, loaded.raw, !opts.nonInteractive);
    problems.merge(app.diagnostics);
    if (app.diagnostics.some((d) => d.severity === 'error')) {
      printDiagnostics(app.diagnostics);
      return 1;
    }
    stopApp = app.stop;
  }

  try {
    if (opts.rehearseFirst) {
      process.stderr.write('\n[0/8] rehearse twice (they must agree)\n');
      const r = await rehearse(story, config);
      problems.merge(r.diagnostics);
      if (r.status === 'disagreed') {
        process.stderr.write('\nthe two rehearsal passes disagreed; not recording:\n');
        printDiagnostics(r.diagnostics.filter((d) => d.code === 'rehearsal/non-deterministic'));
        return 1;
      }
      rehearsalResult = r;
    }

    process.stderr.write('\n[1/8] voice (cached; its length is the clock)\n');
    story.opening.audio = await synth(story.opening.narration, config);
    for (const sc of story.scenes) {
      sc.audio = await synth(sc.narration, config);
      process.stderr.write(`  ♪ ${sc.id}: ${(sc.audio.durationMs / 1000).toFixed(1)}s\n`);
    }
    story.closing.audio = await synth(story.closing.narration, config);

    // The deck is compiled BEFORE recording, because a `slide` step navigates
    // into it and `file://` is confined to its directory.
    const usesSlides = story.scenes.some((s) => s.steps.some((st) => st.do === 'slide'));
    const beatsBySlide: Record<string, number> = {};
    const beatsDeclared: Record<string, number> = {};
    for (const sc of story.scenes) {
      if (!sc.beats?.length) continue;
      beatsDeclared[sc.id] = sc.beats.length;
      const slideStep = sc.steps.find((st) => st.do === 'slide');
      if (slideStep?.slide) beatsBySlide[slideStep.slide] = sc.beats.length;
    }
    let slideRan = false;
    if (usesSlides) {
      process.stderr.write('[2/8] compile the slide deck\n');
      const compiled = compileDeck({ config, beatsBySlide });
      problems.merge(compiled.diagnostics);
      const rendered = await renderSlides({ slides: compiled.slides, outDir: P.slidePreviewDir });
      problems.merge(checkSlides({ rendered, declaredBeats: beatsDeclared, frameWidth: config.video?.width }));
      problems.merge(await checkGoldens(rendered));
      slideRan = true;
      process.stderr.write(`  ${compiled.slides.length} slides -> ${basename(slidePaths().deck)}\n`);
    } else {
      process.stderr.write('[2/8] no slide scenes; skipping the deck\n');
    }

    process.stderr.write('[3/8] record the live UI\n');
    const rec = await record({ story, config, headed: opts.headed });
    problems.merge(rec.problems);
    problems.merge(pacingReport(rec.timeline));

    // Everything from here is built into staging, from the FROZEN storyboard, so
    // a mid-flight edit cannot change what was checked and a failed run cannot
    // replace the last good artifact.
    const staging = openStaging(id, sb.raw);
    let committed = false;
    try {
      process.stderr.write('[4/8] caption sidecars (.vtt + .srt, never burned in)\n');
      const introDurMs = story.opening.audio.durationMs + TIMING.cardPadMs;
      // Recorded now, so `check`, `evidence` and `score` can measure this
      // delivery later without ever calling the voice provider again.
      writeIntroDurationMs(P.timeline, introDurMs);
      const vtt = staging.path(`${id}.vtt`);
      const srt = staging.path(`${id}.srt`);
      writeFileSync(vtt, buildVtt(rec.timeline, introDurMs));
      writeFileSync(srt, buildSrt(rec.timeline, introDurMs));

      process.stderr.write('[5/8] intro + outro cards\n');
      const introMp4 = renderCardClip({
        html: openingHtml(story.opening, config), id, name: 'intro',
        audioPath: story.opening.audio.path, durationMs: story.opening.audio.durationMs, config,
      });
      const outroMp4 = renderCardClip({
        html: closingHtml(story.closing, config), id, name: 'outro',
        audioPath: story.closing.audio!.path, durationMs: story.closing.audio!.durationMs, config,
      });

      process.stderr.write('[6/8] mux the body and assemble\n');
      const frozen = freezeSpans(rec.timeline);
      if (frozen.length) {
        const total = frozen.reduce((n, f) => n + f.holdMs, 0);
        process.stderr.write(`  freezing ${(total / 1000).toFixed(1)}s of idle across ${frozen.length} scene(s)\n`);
      }
      buildBody({
        webm: rec.webm, timeline: rec.timeline, durationMs: rec.durationMs,
        leadTrimMs: rec.leadTrimMs, out: P.bodyMp4, config, freezeDeadAir: true,
      });
      const candidate = staging.path(`${id}.mp4`);
      assembleFinal(introMp4, P.bodyMp4, outroMp4, candidate, config);

      process.stderr.write('[7/8] thumbnail, description and post\n');
      renderThumbnail(story, config, staging.dir);
      const bodyDurMs = rec.durationMs - rec.leadTrimMs;
      const chapters = buildChapters(introDurMs, rec.timeline, introDurMs + bodyDurMs, story.youtube?.chapterLabels ?? {});
      writeFileSync(staging.path(`${id}.youtube.txt`), metaToTxt(buildYoutubeMeta(story, chapters, config)));
      writeFileSync(staging.path(`${id}.linkedin.txt`), buildLinkedinPost(story, config));

      process.stderr.write('[8/8] check the staged artifact\n');
      const report = runChecks({
        profile: opts.quality,
        story, config,
        mp4: candidate,
        vtt, srt,
        timeline: rec.timeline,
        introDurationMs: introDurMs,
        problems: problems.all,
        rehearsal: rehearsalResult ? { status: rehearsalResult.status } : undefined,
        hostsContacted: rec.hostsContacted,
        identity: null,
        publishConsent: opts.publishConsent ?? null,
        beatsDeclared,
        beatsFired: rec.beatsFired,
        slideRan,
      });
      problems.merge(report.diagnostics);

      process.stderr.write('\n' + formatReport(report) + '\n');

      if (!report.ok && opts.commit) {
        process.stderr.write('\nchecks failed: nothing was delivered, and the previous artifact is untouched.\n\n');
        printDiagnostics(problems.errors);
        return 1;
      }

      if (!opts.commit) {
        process.stderr.write(`\nbuilt (not delivered): ${candidate}\n`);
        process.stderr.write('run `rushes deliver ' + id + '` to commit it atomically with a receipt.\n');
        writeFileSync(P.problems, JSON.stringify(problems.toJSON(), null, 2));
        return report.ok ? 0 : 1;
      }

      // Commit. One same-filesystem rename per file; nothing half-written can be
      // the deliverable.
      const storyboardSha = sha256(storyboardPath(id));
      // The captions land in their own subdirectory, so they are copied out
      // BEFORE the commit removes the staging directory.
      copyFileSync(vtt, P.vtt);
      copyFileSync(srt, P.srt);
      staging.commit([candidate, staging.path(`${id}.thumb.png`), staging.path(`${id}.thumb.html`),
        staging.path(`${id}.youtube.txt`), staging.path(`${id}.linkedin.txt`)]);
      committed = true;

      const evidence = extractEvidence(id, P.mp4, rec.timeline, introDurMs);
      problems.merge(evidence.diagnostics);
      const vision = await checkNarration(evidence.files.map((f) => ({
        sceneId: f.sceneId, png: f.png,
        narration: rec.timeline.find((t) => t.sceneId === f.sceneId)?.narration ?? '',
      })));
      problems.merge(vision.diagnostics);

      const info = probeVideo(P.mp4);
      const receipt: Receipt = {
        schemaVersion: 1,
        id,
        profile: opts.quality,
        builtAt: new Date().toISOString(),
        tool: { commit: toolCommit(), version: '1.0.0' },
        config: {
          sha256: configSha256(loaded.raw),
          baseUrl: config.baseUrl,
          resolvedIp: rec.hostsContacted.find((h) => !h.external)?.ip ?? null,
          authStrategy: config.auth?.kind ?? 'none',
        },
        storyboard: { sha256: storyboardSha, bytes: statSync(storyboardPath(id)).size, schemaVersion: 1 },
        artifact: { sha256: sha256(P.mp4), bytes: fileBytes(P.mp4), durationMs: info.durationMs },
        timeline: { sha256: sha256(P.timeline), sceneCount: rec.timeline.length, leadTrimMs: rec.leadTrimMs },
        recording: {
          identity: null,
          scope: story.scope ?? null,
          hostsContacted: rec.hostsContacted,
          hostRules: rec.hostRules,
          preflight: [],
          publishConsent: opts.publishConsent ?? null,
          externalConsent: config.external?.publishConsent ?? null,
          volatileScenes: rehearsalResult?.exemptScenes ?? [],
        },
        checks: report.checks,
        summary: report.summary,
        rehearsal: rehearsalResult
          ? { status: rehearsalResult.status, passes: rehearsalResult.passes, exemptScenes: rehearsalResult.exemptScenes }
          : { status: 'skipped', passes: 0, exemptScenes: [] },
        frameEvidence: { status: evidence.status, artifactSha256: evidence.artifactSha256, frames: evidence.frames },
        narrationCheck: { verified: vision.verified, unverified: vision.unverified, inconclusive: vision.inconclusive },
        humanReview: { status: 'pending', reviewer: null },
        diagnostics: problems.toJSON(),
        overridden: false,
      };
      writeReceipt(P.receipt, receipt);
      writeFileSync(P.problems, JSON.stringify(problems.toJSON(), null, 2));

      recordBuild({
        id, feature: story.feature, builtAt: receipt.builtAt, profile: opts.quality,
        verdict: report.ok ? 'passed' : 'failed',
        storyboardSha256: storyboardSha, artifactSha256: receipt.artifact.sha256,
      });

      const junk = sweep(id, 'junk');
      if (junk.paths.length) process.stderr.write(`  swept ${junk.paths.length} junk entries (${mb(junk.bytes)})\n`);

      process.stderr.write('\n' + formatScore(scoreSheet(rec.timeline, report)) + '\n');
      process.stderr.write('\n' + handoffReport(receipt, P.mp4, 0) + '\n');
      process.stderr.write(`\nevidence:  ${evidence.contactSheet ?? '(none)'}\n`);
      process.stderr.write(`thumbnail: ${P.thumbPng}\n`);
      process.stderr.write(`youtube:   ${P.youtube}\n`);
      process.stderr.write(`linkedin:  ${P.linkedin}\n`);
      // The command for the shell the reader is actually in, so the last step of
      // a delivery is a paste rather than a translation.
      process.stderr.write(`\nwatch it:  ${openCommand(P.mp4)}\n`);
      process.stderr.write('\nNOT published. Review the video, then ask the user before publishing.\n');
      return 0;
    } finally {
      if (!committed) staging.discard();
    }
  } finally {
    if (stopApp) await stopApp();
  }
}


/** `check`: re-run the checker against what is already on disk. */
export async function checkOnly(id: string, quality: QualityProfile, json: boolean): Promise<number> {
  const loaded = loadConfig();
  const sb = loadStoryboard(id, loaded.config);
  const P = demoPaths(id);
  if (!existsSync(P.timeline)) {
    process.stderr.write(`no timeline at ${P.timeline}; run \`rushes build ${id}\` first\n`);
    return 1;
  }
  const tl = JSON.parse(readFileSync(P.timeline, 'utf8')) as { timeline: Parameters<typeof runChecks>[0]['timeline'] };
  const problems = existsSync(P.problems)
    ? JSON.parse(readFileSync(P.problems, 'utf8')) as Parameters<typeof runChecks>[0]['problems']
    : [];
  const introDurMs = readIntroDurationMs(P.timeline)
    ?? ((await synth(sb.story.opening.narration, loaded.config)).durationMs + TIMING.cardPadMs);

  // Re-checking what is already on disk has to read the DELIVERY's own record of
  // how it was made. Without it the run reports the consent and the hosts as
  // absent, which is a false failure: they are not missing, this command simply
  // was not the one that collected them.
  const receipt = readReceipt(P.receipt);
  const report = runChecks({
    profile: quality, story: sb.story, config: loaded.config, mp4: P.mp4,
    vtt: P.vtt, srt: P.srt, timeline: tl.timeline, introDurationMs: introDurMs,
    problems: [...problems, ...sb.diagnostics, ...loaded.diagnostics],
    publishConsent: receipt?.recording?.publishConsent ?? null,
    identity: receipt?.recording?.identity ?? null,
    hostsContacted: receipt?.recording?.hostsContacted ?? [],
    rehearsal: receipt?.rehearsal ? { status: receipt.rehearsal.status } : undefined,
    narrationCheck: receipt?.narrationCheck,
  });
  if (json) process.stdout.write(JSON.stringify({ report, diagnostics: report.diagnostics }, null, 2) + '\n');
  else process.stderr.write(formatReport(report) + '\n');
  return report.ok ? 0 : 1;
}

