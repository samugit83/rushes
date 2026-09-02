// `rushes rerun <id>` (S4): re-record against the current app and report, per
// scene, what changed visually against the last delivered evidence frames.
//
// With dozens of published videos and an application under active development,
// knowing WHICH THREE need re-recording after a UI change is the difference
// between maintaining a series and abandoning it. Without it the only options
// are re-recording everything or leaving wrong videos up.

import { existsSync, readdirSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { demoPaths } from '../paths.ts';
import { hasFfmpeg } from '../compose/ffprobe.ts';

export interface SceneDiff { sceneId: string; changed: boolean; score: number | null; note: string }

/**
 * Mean absolute difference between two frames, 0..1, via ffmpeg. Scaled small
 * first: this measures "did the layout move", not "did a pixel change".
 */
function frameDistance(a: string, b: string): number | null {
  if (!hasFfmpeg() || !existsSync(a) || !existsSync(b)) return null;
  try {
    const out = execFileSync('ffmpeg', ['-hide_banner', '-nostats', '-i', a, '-i', b,
      '-lavfi', '[0:v]scale=64:36,format=gray[x];[1:v]scale=64:36,format=gray[y];[x][y]blend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG',
      '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const text = String(out ?? '');
    const y = text.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
    return y ? Number(y[1]) / 255 : null;
  } catch {
    return null;
  }
}

const CHANGED_AT = 0.06; // ~6% mean luminance difference on a 64x36 thumbnail

export function compareEvidence(id: string, previousDir: string): SceneDiff[] {
  const P = demoPaths(id);
  const out: SceneDiff[] = [];
  if (!existsSync(previousDir)) return out;

  for (const file of listPngs(previousDir)) {
    const sceneId = file.replace(/\.png$/, '');
    const before = join(previousDir, file);
    const after = join(P.evidenceDir, file);
    if (!existsSync(after)) {
      out.push({ sceneId, changed: true, score: null, note: 'the scene produced no frame this time' });
      continue;
    }
    const score = frameDistance(before, after);
    out.push({
      sceneId,
      changed: score === null ? false : score > CHANGED_AT,
      score,
      note: score === null ? 'not comparable' : score > CHANGED_AT ? 'changed' : 'unchanged',
    });
  }
  return out;
}

function listPngs(dir: string): string[] {
  // Failure screenshots are evidence of a broken run, not of a scene's look, so
  // they never take part in the comparison.
  return readdirSync(dir).filter((f) => f.endsWith('.png') && !f.startsWith('fail-')).sort();
}

/** Snapshot the current evidence so the NEXT rerun has something to compare to. */
export function snapshotEvidence(id: string): string {
  const P = demoPaths(id);
  const dest = join(P.dir, 'evidence.previous');
  rmSync(dest, { recursive: true, force: true });
  if (existsSync(P.evidenceDir)) {
    mkdirSync(dest, { recursive: true });
    cpSync(P.evidenceDir, dest, { recursive: true });
  }
  return dest;
}

export function formatDiffs(diffs: SceneDiff[]): string {
  if (!diffs.length) return '  no previous evidence to compare against; this run becomes the baseline';
  const width = Math.max(...diffs.map((d) => d.sceneId.length));
  return diffs.map((d) => {
    const mark = d.changed ? '~' : ' ';
    const score = d.score === null ? '' : `  (${(d.score * 100).toFixed(1)}%)`;
    return `  ${mark} ${d.sceneId.padEnd(width)}  ${d.note}${score}`;
  }).join('\n');
}
