// One capture, many formats (Q2). Everything here is derived from the SAME
// recording.webm and timeline.json that produced the 16:9 master, so none of it
// costs a re-capture and none of it re-bills narration.
//
// The README GIF matters more than it looks: it is what a visitor to a
// repository actually sees, and a tool that makes videos which shows a wall of
// text has already lost.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Format = 'gif' | 'vertical' | 'stems';

/** 960x540 at 15fps, two-pass palette, sized to stay inline on a README. */
export function toGif(mp4: string, out: string, opts: { fps?: number; width?: number; maxSeconds?: number } = {}): string {
  const fps = opts.fps ?? 15;
  const width = opts.width ?? 960;
  const palette = join(dirname(out), '.palette.png');
  const limit = opts.maxSeconds ? ['-t', String(opts.maxSeconds)] : [];
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...limit, '-i', mp4,
    '-vf', `fps=${fps},scale=${width}:-1:flags=lanczos,palettegen=stats_mode=diff`, palette], { stdio: 'ignore' });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...limit, '-i', mp4, '-i', palette,
    '-lavfi', `fps=${fps},scale=${width}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`,
    out], { stdio: 'ignore' });
  return out;
}

/** 9:16 crop centred on the frame, for Shorts and Reels. */
export function toVertical(mp4: string, out: string, height = 1920): string {
  const width = Math.round((height * 9) / 16);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4,
    '-vf', `scale=-2:${height},crop=${width}:${height}`,
    '-c:v', 'libx264', '-preset', 'medium', '-b:v', '10M', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', out], { stdio: 'ignore' });
  return out;
}

/** Video, narration and captions as separate files, for an editor. */
export function toStems(mp4: string, srt: string, outDir: string): string[] {
  const video = join(outDir, 'stem.video.mp4');
  const audio = join(outDir, 'stem.narration.wav');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-an', '-c:v', 'copy', video], { stdio: 'ignore' });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-vn', '-c:a', 'pcm_s16le', audio], { stdio: 'ignore' });
  return [video, audio, ...(existsSync(srt) ? [srt] : [])];
}
