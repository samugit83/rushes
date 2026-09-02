// The smaller commands: evidence, recut, formats, status, clean.

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { TIMING } from '../config.ts';
import { demoPaths } from '../paths.ts';
import { loadConfig } from '../projectConfig.ts';
import { loadStoryboard } from '../storyboard.ts';
import { printDiagnostics } from '../diagnostics.ts';
import { synth } from '../compose/tts.ts';
import { extractEvidence } from '../check/evidence.ts';
import { checkNarration } from '../check/vision.ts';
import { readReceipt, writeReceipt } from '../check/receipt.ts';
import { buildBody, assembleFinal } from '../compose/mux.ts';
import { openingHtml, closingHtml, renderCardClip } from '../compose/cards.ts';
import { buildVtt, buildSrt } from '../compose/subtitles.ts';
import { toGif, toVertical, toStems } from '../compose/formats.ts';
import { readCatalogue, staleEntries } from '../publish/catalogue.ts';
import { plan as sweepPlan, sweep, mb, type SweepLevel } from '../cleanup.ts';
import type { TimelineEntry } from '../types.ts';

interface TimelineFile { durationMs: number; leadTrimMs: number; introDurationMs?: number; timeline: TimelineEntry[] }

function readTimeline(id: string): TimelineFile | null {
  const P = demoPaths(id);
  if (!existsSync(P.timeline)) return null;
  return JSON.parse(readFileSync(P.timeline, 'utf8')) as TimelineFile;
}

/**
 * The intro card's length, read off disk.
 *
 * `evidence` and `check` used to recompute this by calling the voice provider,
 * which meant a command whose whole job is to MEASURE could bill for characters.
 * It is recorded at delivery instead. `null` means an older timeline that
 * predates the field, and the caller falls back.
 */
export function readIntroDurationMs(timelinePath: string): number | null {
  if (!existsSync(timelinePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(timelinePath, 'utf8')) as TimelineFile;
    return typeof parsed.introDurationMs === 'number' ? parsed.introDurationMs : null;
  } catch {
    return null;
  }
}

/** Persist it, so every later measurement is free. */
export function writeIntroDurationMs(timelinePath: string, introDurationMs: number): void {
  if (!existsSync(timelinePath)) return;
  try {
    const parsed = JSON.parse(readFileSync(timelinePath, 'utf8')) as TimelineFile;
    writeFileSync(timelinePath, JSON.stringify({ ...parsed, introDurationMs }, null, 2));
  } catch { /* a timeline we cannot rewrite is not worth failing a delivery over */ }
}

/** `evidence`: frames from the DELIVERED mp4, plus the narration check. */
export async function evidence(id: string): Promise<number> {
  const P = demoPaths(id);
  const { config } = loadConfig();
  const sb = loadStoryboard(id, config);
  const tl = readTimeline(id);
  if (!tl) { process.stderr.write(`no timeline for ${id}; build it first\n`); return 1; }

  // Read the recorded value; only fall back to the provider for a timeline
  // written before it was persisted.
  const introDurMs = readIntroDurationMs(P.timeline)
    ?? ((await synth(sb.story.opening.narration, config)).durationMs + TIMING.cardPadMs);
  const result = extractEvidence(id, P.mp4, tl.timeline, introDurMs);
  if (result.diagnostics.length) printDiagnostics(result.diagnostics);

  const vision = await checkNarration(result.files.map((f) => ({
    sceneId: f.sceneId, png: f.png,
    narration: tl.timeline.find((t) => t.sceneId === f.sceneId)?.narration ?? '',
  })));
  if (vision.diagnostics.length) printDiagnostics(vision.diagnostics);

  process.stderr.write(`\n  frame evidence: ${result.status}, ${result.frames} frames`);
  process.stderr.write(result.artifactSha256 ? ` from sha256 ${result.artifactSha256.slice(0, 12)}…\n` : '\n');
  process.stderr.write(`  narration:      ${vision.verified} verified, ${vision.unverified} unverified, ${vision.inconclusive} inconclusive\n`);
  if (result.contactSheet) process.stderr.write(`  contact sheet:  ${result.contactSheet}\n\n`);

  // Keep the receipt honest: it now carries what this run actually measured.
  const receipt = readReceipt(P.receipt);
  if (receipt) {
    receipt.frameEvidence = { status: result.status, artifactSha256: result.artifactSha256, frames: result.frames };
    receipt.narrationCheck = { verified: vision.verified, unverified: vision.unverified, inconclusive: vision.inconclusive };
    writeReceipt(P.receipt, receipt);
  }
  return result.status === 'failed' || vision.unverified > 0 ? 1 : 0;
}

/**
 * `recut`: rebuild the video from recording.webm, timeline.json and the cached
 * voice clips. Fixing a caption typo stops costing a re-record, and the mux
 * becomes testable, because the same inputs must produce the same bytes.
 */
export async function recut(id: string, bitexact = false): Promise<number> {
  const P = demoPaths(id);
  const { config } = loadConfig();
  const sb = loadStoryboard(id, config);
  const tl = readTimeline(id);
  if (!tl || !existsSync(P.webm)) {
    process.stderr.write(`no recording to re-cut for ${id} (need recording.webm + timeline.json)\n`);
    return 1;
  }

  const opening = await synth(sb.story.opening.narration, config);
  const closing = await synth(sb.story.closing.narration, config);
  // Re-synthesise the scene lines too: a caption edit that changed a word must
  // change the voice, or the two drift apart silently.
  const timeline: TimelineEntry[] = [];
  for (const e of tl.timeline) {
    const scene = sb.story.scenes.find((s) => s.id === e.sceneId);
    const clip = scene ? await synth(scene.narration, config) : null;
    timeline.push({ ...e, narration: scene?.narration ?? e.narration, audioPath: clip?.path ?? e.audioPath, audioDurationMs: clip?.durationMs ?? e.audioDurationMs });
  }

  const introDurMs = opening.durationMs + TIMING.cardPadMs;
  writeFileSync(P.vtt, buildVtt(timeline, introDurMs));
  writeFileSync(P.srt, buildSrt(timeline, introDurMs));

  const introMp4 = renderCardClip({ html: openingHtml(sb.story.opening, config), id, name: 'intro', audioPath: opening.path, durationMs: opening.durationMs, config });
  const outroMp4 = renderCardClip({ html: closingHtml(sb.story.closing, config), id, name: 'outro', audioPath: closing.path, durationMs: closing.durationMs, config });
  buildBody({ webm: P.webm, timeline, durationMs: tl.durationMs, leadTrimMs: tl.leadTrimMs, out: P.bodyMp4, config, bitexact, freezeDeadAir: true });
  assembleFinal(introMp4, P.bodyMp4, outroMp4, P.mp4, config, bitexact);

  process.stderr.write(`\n✓ re-cut ${P.mp4}\n`);
  process.stderr.write('  the receipt no longer matches these bytes: re-run `rushes deliver` before publishing.\n\n');
  return 0;
}

/** `formats`: everything else the same capture can produce (Q2). */
export function formats(id: string): number {
  const P = demoPaths(id);
  if (!existsSync(P.mp4)) { process.stderr.write(`no delivered mp4 for ${id}\n`); return 1; }
  process.stderr.write(`  gif       ${toGif(P.mp4, P.gif, { maxSeconds: 20 })}\n`);
  process.stderr.write(`  vertical  ${toVertical(P.mp4, P.vertical)}\n`);
  for (const f of toStems(P.mp4, P.srt, P.dir)) process.stderr.write(`  stem      ${f}\n`);
  return 0;
}

/** `status`: the catalogue, and which published videos have drifted (S3). */
export function status(): number {
  const cat = readCatalogue();
  const entries = Object.values(cat);
  if (!entries.length) { process.stderr.write('nothing built yet.\n'); return 0; }

  const width = Math.max(...entries.map((e) => e.id.length));
  process.stderr.write('\n');
  for (const e of entries) {
    const mark = e.verdict === 'passed' ? '✓' : '✗';
    const where = e.publishedUrl ?? '(not published)';
    process.stderr.write(`  ${mark} ${e.id.padEnd(width)}  ${e.builtAt.slice(0, 10)}  ${e.profile.padEnd(9)}  ${where}\n`);
  }

  const stale = staleEntries();
  if (stale.length) {
    process.stderr.write('\n  storyboards edited since the video was built:\n');
    for (const s of stale) process.stderr.write(`    ${s.id}${s.url ? `  (published at ${s.url})` : ''}\n`);
    process.stderr.write('  Re-deliver these, or the published chapters no longer match the video.\n');
  }
  process.stderr.write('\n');
  return 0;
}

export function clean(id: string, level: SweepLevel, confirm: boolean): number {
  const p = sweepPlan(id, level);
  process.stderr.write(`\n── sweep "${level}" for ${id} ─────────────\n`);
  for (const path of p.paths) process.stderr.write(`  ${path}\n`);
  process.stderr.write(`  ${p.paths.length} entries, ${mb(p.bytes)}\n`);
  if (!confirm) { process.stderr.write('\nDRY RUN — nothing deleted. Re-run with --confirm.\n'); return 0; }
  sweep(id, level);
  process.stderr.write(`\n✓ freed ${mb(p.bytes)}\n`);
  return 0;
}
