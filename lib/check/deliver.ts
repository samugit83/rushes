// Atomic delivery (D6). Build into a staging directory BESIDE the target, from a
// FROZEN copy of the storyboard, check there, and rename only on pass.
//
// Three properties, each of which was a real failure before:
//
//   - ffmpeg used to write straight to <id>.mp4, so an interrupted or degraded
//     run silently replaced a good cut with a worse one. A failed run now leaves
//     the last good artifact untouched.
//   - The rename is one same-filesystem operation, so there is no window in
//     which half a video is the deliverable.
//   - The storyboard bytes are frozen with `flag: 'wx'` before anything is
//     built, and the build reads the SNAPSHOT. A mid-flight edit to
//     demos/<id>.demo.json cannot change what was checked.

import { mkdtempSync, writeFileSync, renameSync, rmSync, existsSync, copyFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { demoPaths } from '../paths.ts';

export interface Staging {
  dir: string;
  /** The frozen storyboard the build must read. */
  snapshot: string;
  /** A path inside the staging directory for one output file. */
  path(name: string): string;
  /** Move every staged file into place, in one pass. */
  commit(files: string[]): void;
  discard(): void;
}

export function openStaging(id: string, storyboardRaw: string): Staging {
  const P = demoPaths(id);
  mkdirSync(P.dir, { recursive: true });
  // Beside the target, so the final rename is a same-filesystem atomic commit.
  const dir = mkdtempSync(join(P.dir, '.staging-'));
  const snapshot = join(dir, 'storyboard.snapshot.json');
  // 'wx' fails if it somehow exists: a staging directory is single-use.
  writeFileSync(snapshot, storyboardRaw, { flag: 'wx' });

  return {
    dir,
    snapshot,
    path(name: string) { return join(dir, name); },
    commit(files: string[]) {
      for (const f of files) {
        if (!existsSync(f)) continue;
        const target = join(P.dir, basename(f));
        renameSync(f, target);
      }
      // Anything left in staging is an intermediate; keep the snapshot beside
      // the receipt so the delivered artifact stays reconstructable.
      const keep = join(P.dir, 'storyboard.snapshot.json');
      if (existsSync(snapshot)) copyFileSync(snapshot, keep);
      rmSync(dir, { recursive: true, force: true });
    },
    discard() { rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Left-over staging directories from a killed run. Swept before a new build. */
export function sweepStaleStaging(id: string): number {
  const P = demoPaths(id);
  if (!existsSync(P.dir)) return 0;
  let n = 0;
  for (const e of readdirSync(P.dir)) {
    if (e.startsWith('.staging-')) { rmSync(join(P.dir, e), { recursive: true, force: true }); n++; }
  }
  return n;
}
