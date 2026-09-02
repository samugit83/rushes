// Retention policy for a demo's artifacts, in one place so the build, the
// uploader and a manual sweep all agree on what is disposable.
//
// Three levels, widest-first in what they keep:
//   junk           authoring litter: failure screenshots from superseded runs,
//                  stale staging directories, run logs, and the _vid/ webm the
//                  browser writes (a byte copy of recording.webm).
//   intermediates  junk + everything the mux can rebuild from recording.webm:
//                  the body, intro and outro clips and the card PNG/HTML.
//   all            intermediates + recording.webm and timeline.json. Only safe
//                  once the video is published: without the webm a re-cut means
//                  re-recording against a live app that has moved on, and it
//                  will not reproduce.
//
// Deliverables — the mp4, the thumbnail, the text files, the caption sidecars,
// the receipt and the evidence — are never touched at any level.

import { readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { demoPaths, outRoot } from './paths.ts';

export type SweepLevel = 'junk' | 'intermediates' | 'all';

export interface SweepResult { paths: string[]; bytes: number }

function bytesOf(path: string): number {
  const st = statSync(path);
  if (!st.isDirectory()) return st.size;
  return readdirSync(path).reduce((n, e) => n + bytesOf(join(path, e)), 0);
}

/** What a sweep at `level` would remove. Pure: touches nothing. */
export function plan(id: string, level: SweepLevel): SweepResult {
  const P = demoPaths(id);
  const candidates: string[] = [join(P.dir, '_vid')];

  if (existsSync(P.dir)) {
    for (const e of readdirSync(P.dir)) {
      // A staging directory that outlived its run is litter by definition: a
      // successful deliver removes its own.
      if (e.startsWith('.staging-')) candidates.push(join(P.dir, e));
    }
  }

  const root = outRoot();
  if (existsSync(root)) {
    for (const e of readdirSync(root)) if (e.endsWith('.log')) candidates.push(join(root, e));
  }

  if (level !== 'junk') {
    candidates.push(
      P.bodyMp4, P.introMp4, P.outroMp4,
      join(P.dir, 'intro.png'), join(P.dir, 'intro.html'),
      join(P.dir, 'outro.png'), join(P.dir, 'outro.html'),
      P.thumbHtml,
    );
  }
  if (level === 'all') candidates.push(P.webm, P.timeline);

  const paths = [...new Set(candidates)].filter(existsSync).sort();
  return { paths, bytes: paths.reduce((n, p) => n + bytesOf(p), 0) };
}

/** Delete what `plan` lists. Returns what actually went. */
export function sweep(id: string, level: SweepLevel): SweepResult {
  const p = plan(id, level);
  for (const path of p.paths) rmSync(path, { recursive: true, force: true });
  return p;
}

export const mb = (bytes: number) => `${(bytes / 1e6).toFixed(0)} MB`;
