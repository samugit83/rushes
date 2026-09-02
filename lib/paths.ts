// Single source of truth for where a demo's artifacts live, so the writer and
// the reader never drift. Everything for one demo lives under out/<id>/.
//
// R4: `screencast` and `narrationWav` were dead, and cards.ts built its own
// intro/outro paths, which made the "single source of truth" comment false.
// Both are fixed here.

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { SKILL_ROOT } from './env.ts';

/** Where the filmed project lives (its config, storyboards and slide sources). */
export function projectRoot(): string {
  return process.env.RUSHES_PROJECT_ROOT || process.cwd();
}

export function outRoot(): string {
  return join(projectRoot(), 'out');
}

export function demoPaths(id: string) {
  const dir = join(outRoot(), id);
  return {
    dir,
    // intermediates
    webm: join(dir, 'recording.webm'),
    timeline: join(dir, 'timeline.json'),
    problems: join(dir, 'problems.json'),
    receipt: join(dir, 'receipt.json'),
    introMp4: join(dir, 'intro.mp4'),
    bodyMp4: join(dir, 'body.mp4'),
    outroMp4: join(dir, 'outro.mp4'),
    // deliverables
    mp4: join(dir, `${id}.mp4`),
    gif: join(dir, `${id}.gif`),
    vertical: join(dir, `${id}.vertical.mp4`),
    thumbPng: join(dir, `${id}.thumb.png`),
    thumbHtml: join(dir, `${id}.thumb.html`),
    youtube: join(dir, `${id}.youtube.txt`),
    linkedin: join(dir, `${id}.linkedin.txt`),
    vttDir: join(dir, 'subtitles'),
    vtt: join(dir, 'subtitles', `${id}.vtt`),
    srt: join(dir, 'subtitles', `${id}.srt`), // LinkedIn's uploader takes .srt
    // evidence, bound to the DELIVERED mp4 (E2), never to a probe run
    evidenceDir: join(dir, 'evidence'),
    contactSheet: join(dir, 'evidence', 'contact-sheet.html'),
    // slide previews (Gate 2.5) — no TTS, no recording, no ffmpeg
    slidePreviewDir: join(dir, 'slides-preview'),
  };
}

export type DemoPaths = ReturnType<typeof demoPaths>;

/** Where the compiled slide deck lives. `file://` navigation is confined here (F31). */
export function slidePaths() {
  const root = join(projectRoot(), 'slides');
  return {
    root,
    src: join(root, 'src'),
    runtime: join(SKILL_ROOT, 'slides', 'runtime'),
    deck: join(root, 'deck.html'),
    golden: join(root, 'golden'),
  };
}

/** Per-project state the skill writes: browser state, consent, pending restores. */
export function statePaths() {
  const dir = join(projectRoot(), '.rushes');
  return {
    dir,
    browserState: join(dir, 'state.json'),
    consent: join(dir, 'consent.json'),
    pendingRestore: join(dir, 'pending-restore.json'),
    index: join(outRoot(), 'index.json'),
  };
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export function skillAsset(...parts: string[]): string {
  return join(SKILL_ROOT, 'assets', ...parts);
}
