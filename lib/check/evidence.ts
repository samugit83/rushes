// Frame evidence, extracted from the DELIVERED mp4 (E2).
//
// This is the fix for a whole class of bug, not a feature. The old instruction
// told the reviewing agent to eyeball out/<id>/probe/*.png — frames from a
// PROBE run, not from the recording. Those frames can look perfect while the
// delivered video is wrong, which is the worst possible review signal.
//
// Two rules, taken verbatim from the delivery contract this is modelled on:
//
//   - `skipped` maps ONLY to "ffmpeg or the artifact was unavailable". A runtime
//     failure is `failed`, never normalised into `skipped`. Conflating the two
//     is how a broken tool reports as a clean run.
//   - A failed or skipped evidence run DELETES stale sidecars, rather than
//     leaving the previous run's frames sitting there looking current.

import { existsSync, mkdirSync, rmSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { TimelineEntry } from '../types.ts';
import { demoPaths } from '../paths.ts';
import { hasFfmpeg } from '../compose/ffprobe.ts';
import { type Diagnostic, diag } from '../diagnostics.ts';

export interface EvidenceResult {
  status: 'passed' | 'failed' | 'skipped';
  artifactSha256: string | null;
  frames: number;
  contactSheet: string | null;
  files: { sceneId: string; png: string }[];
  diagnostics: Diagnostic[];
}

function clearStale(dir: string): void {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    // Failure screenshots from the record pass are evidence in their own right
    // and are not this stage's to delete.
    if (f.startsWith('fail-')) continue;
    rmSync(join(dir, f), { force: true, recursive: true });
  }
}

export function extractEvidence(
  id: string,
  mp4: string,
  timeline: TimelineEntry[],
  introDurationMs: number,
): EvidenceResult {
  const P = demoPaths(id);
  const dir = P.evidenceDir;
  mkdirSync(dir, { recursive: true });

  if (!hasFfmpeg() || !existsSync(mp4)) {
    clearStale(dir);
    return {
      status: 'skipped', artifactSha256: null, frames: 0, contactSheet: null, files: [],
      diagnostics: [diag('internal/unclassified', 'warning',
        !hasFfmpeg() ? 'ffmpeg is unavailable; frame evidence was skipped' : 'no delivered artifact to extract frames from',
        { artifact: mp4 }, {}, ['install ffmpeg', 'run `rushes build` first'])],
    };
  }

  const sha = createHash('sha256').update(readFileSync(mp4)).digest('hex');
  clearStale(dir);

  const files: { sceneId: string; png: string }[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const e of timeline) {
    const mid = introDurationMs + e.startMs + (e.endMs - e.startMs) / 2;
    const png = join(dir, `${e.sceneId}.png`);
    try {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', (mid / 1000).toFixed(3),
        '-i', mp4, '-frames:v', '1', png], { stdio: 'ignore' });
      if (existsSync(png)) files.push({ sceneId: e.sceneId, png });
    } catch (err) {
      // A runtime failure is `failed`. Never softened into `skipped`.
      diagnostics.push(diag('internal/unclassified', 'error',
        `could not extract the keyframe for "${e.sceneId}": ${(err as Error).message}`,
        { sceneId: e.sceneId }, { atMs: Math.round(mid) }, ['check the artifact is readable']));
    }
  }

  if (diagnostics.some((d) => d.severity === 'error')) {
    clearStale(dir);
    return { status: 'failed', artifactSha256: sha, frames: 0, contactSheet: null, files: [], diagnostics };
  }

  const sheet = join(dir, 'contact-sheet.html');
  writeFileSync(sheet, contactSheetHtml(id, files, sha));
  return { status: 'passed', artifactSha256: sha, frames: files.length, contactSheet: sheet, files, diagnostics };
}

function contactSheetHtml(id: string, files: { sceneId: string; png: string }[], sha: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${id} — evidence</title><style>
    body{background:#0b0a10;color:#e7e5ea;font:14px system-ui,sans-serif;margin:0;padding:28px;}
    h1{font-size:18px;margin:0 0 6px;} p{color:rgba(231,229,234,.6);margin:0 0 22px;font-size:12px;}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(460px,1fr));gap:20px;}
    figure{margin:0;background:#151320;border:1px solid rgba(231,229,234,.14);border-radius:12px;overflow:hidden;}
    img{display:block;width:100%;height:auto;} figcaption{padding:10px 14px;color:rgba(231,229,234,.75);}
  </style></head><body>
    <h1>${id}</h1>
    <p>Frames extracted from the delivered artifact, sha256 ${sha}</p>
    <div class="grid">${files.map((f) => `<figure><img src="${f.sceneId}.png" alt="${f.sceneId}"><figcaption>${f.sceneId}</figcaption></figure>`).join('')}</div>
  </body></html>`;
}
