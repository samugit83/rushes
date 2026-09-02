// Assembles the final video with ffmpeg:
//   1. body  = the screencast (scaled and padded to frame) with narration mixed
//      in at each scene's offset. Captions are NOT burned in: they ship as .vtt
//      and .srt sidecars, so they stay toggleable, translatable and indexable,
//      and they never cover the UI the demo exists to show.
//   2. final = intro card + body + outro card, concatenated with one re-encode
//      so the join is seamless regardless of tiny stream differences.
//
// Two things this stage now does that it did not:
//
// Q1 — the narration bed is normalised to -16 LUFS. Whatever level the voice
// provider returned drifts between voices and models; a platform will normalise
// on its side anyway, and arriving already correct stops its transcode fighting
// the mix.
//
// T3 — where a scene's audio outlasts its actions, the FINAL FRAME of the action
// span is frozen for the remainder instead of recording live idle. That removes
// dead air without touching the storyboard, and it decouples scene length from
// how slow software rendering happens to be that day.

import { basename, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { TimelineEntry } from '../types.ts';
import { VIDEO } from '../config.ts';
import type { ProjectConfig } from '../projectConfig.ts';

export interface MuxOptions {
  webm: string;
  timeline: TimelineEntry[];
  durationMs: number;   // full webm length
  leadTrimMs: number;   // trimmed off the front so the body opens on the settled app
  out: string;
  config: ProjectConfig;
  /** Byte-identical output across runs, for the determinism test (T2). */
  bitexact?: boolean;
  /** Freeze the last action frame instead of showing live idle (T3). */
  freezeDeadAir?: boolean;
}

function geometry(config: ProjectConfig) {
  return {
    width: config.video?.width ?? VIDEO.width,
    height: config.video?.height ?? VIDEO.height,
    fps: config.video?.fps ?? VIDEO.fps,
    bitrate: config.video?.bitrate ?? VIDEO.bitrate,
    background: config.brand?.background ?? '#0b0a10',
  };
}

/**
 * Scenes whose voice outlasts their action, as (freezeAtMs, holdMs) pairs
 * relative to the trimmed body. Exported so the checker can report how much dead
 * air the freeze absorbed.
 */
export function freezeSpans(timeline: TimelineEntry[], minMs = 1200): { atMs: number; holdMs: number }[] {
  const out: { atMs: number; holdMs: number }[] = [];
  for (const e of timeline) {
    if (e.actionEndMs == null) continue;
    const idle = e.endMs - e.actionEndMs;
    if (idle >= minMs) out.push({ atMs: e.actionEndMs, holdMs: idle });
  }
  return out;
}

/**
 * The video filter chain.
 *
 * Without the freeze this is one trim, one scale, one pad and a constant frame
 * rate. With it, the body is cut into per-scene segments: each scene plays live
 * up to the moment its last step finished, then holds THAT frame for the rest of
 * its narration. Total duration is unchanged by construction, so every timeline
 * offset, every caption cue and every chapter timestamp stays valid — the
 * picture simply stops moving instead of showing a spinner or a jerky software
 * render while the voice finishes the sentence.
 */
function videoChain(opts: MuxOptions, g: ReturnType<typeof geometry>): string {
  const trimS = (opts.leadTrimMs / 1000).toFixed(3);
  const base =
    `[0:v]trim=start=${trimS},setpts=PTS-STARTPTS,` +
    `scale=${g.width}:${g.height}:force_original_aspect_ratio=decrease,` +
    `pad=${g.width}:${g.height}:(ow-iw)/2:(oh-ih)/2:color=${g.background},` +
    `fps=${g.fps}`;

  const spans = opts.freezeDeadAir ? freezeSpans(opts.timeline) : [];
  if (!spans.length) return `${base},format=yuv420p[vout]`;

  const bodyMs = Math.max(0, opts.durationMs - opts.leadTrimMs);
  const sec = (ms: number) => Math.max(0, ms / 1000).toFixed(3);

  // Cut points, in order: everything before the first freeze, then for each
  // freeze a live part and a held frame, then the tail.
  type Part = { kind: 'live'; from: number; to: number } | { kind: 'hold'; at: number; ms: number };
  const parts: Part[] = [];
  let cursor = 0;
  for (const s of spans) {
    if (s.atMs > cursor) parts.push({ kind: 'live', from: cursor, to: s.atMs });
    parts.push({ kind: 'hold', at: s.atMs, ms: s.holdMs });
    cursor = s.atMs + s.holdMs;
  }
  if (cursor < bodyMs) parts.push({ kind: 'live', from: cursor, to: bodyMs });

  const chain: string[] = [`${base}[src]`];
  chain.push(`[src]split=${parts.length}${parts.map((_, i) => `[s${i}]`).join('')}`);
  parts.forEach((p, i) => {
    if (p.kind === 'live') {
      chain.push(`[s${i}]trim=start=${sec(p.from)}:end=${sec(p.to)},setpts=PTS-STARTPTS[p${i}]`);
    } else {
      // One frame, looped. `loop` counts frames, so the held length is exact at
      // the constant rate the previous filter already imposed.
      const frames = Math.max(1, Math.round((p.ms / 1000) * g.fps));
      const oneFrame = (1 / g.fps).toFixed(4);
      chain.push(
        `[s${i}]trim=start=${sec(p.at)}:duration=${oneFrame},setpts=PTS-STARTPTS,` +
        `loop=loop=${frames - 1}:size=1:start=0,setpts=N/${g.fps}/TB[p${i}]`);
    }
  });
  chain.push(`${parts.map((_, i) => `[p${i}]`).join('')}concat=n=${parts.length}:v=1:a=0,format=yuv420p[vout]`);
  return chain.join(';');
}

export function buildBody(opts: MuxOptions): void {
  const g = geometry(opts.config);
  const dir = dirname(opts.out);
  const bodyMs = Math.max(0, opts.durationMs - opts.leadTrimMs);
  const dur = (bodyMs / 1000).toFixed(3);
  const clips = opts.timeline.filter((e) => e.audioPath);

  const inputs: string[] = ['-i', opts.webm];
  clips.forEach((c) => inputs.push('-i', c.audioPath!));

  const vChain = videoChain(opts, g);

  // A full-length silent bed plus each narration clip delayed to its offset,
  // summed (normalize=0 keeps full volume since clips never overlap), then
  // brought to a known loudness.
  const bed = `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${dur}[bed]`;
  const delays = clips.map((c, i) => `[${i + 1}:a]adelay=${c.startMs}|${c.startMs}[a${i}]`);
  const mixLabels = ['[bed]', ...clips.map((_, i) => `[a${i}]`)].join('');
  const loudnorm = 'loudnorm=I=-16:TP=-1.5:LRA=11';
  const aChain = clips.length
    ? `${bed};${delays.join(';')};${mixLabels}amix=inputs=${clips.length + 1}:normalize=0:dropout_transition=0,${loudnorm}[aout]`
    : `${bed};[bed]anull[aout]`;

  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    ...(opts.bitexact ? ['-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact'] : []),
    ...inputs,
    '-filter_complex', `${vChain};${aChain}`,
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'medium', '-b:v', g.bitrate, '-r', String(g.fps),
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2',
    ...(opts.bitexact ? ['-map_metadata', '-1'] : []),
    '-t', dur, basename(opts.out),
  ], { cwd: dir, stdio: 'inherit' });
}

/** intro + body + outro -> final mp4 (single re-encode for a clean join). */
export function assembleFinal(
  intro: string, body: string, outro: string, out: string,
  config: ProjectConfig, bitexact = false,
): void {
  const g = geometry(config);
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    ...(bitexact ? ['-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact'] : []),
    '-i', intro, '-i', body, '-i', outro,
    '-filter_complex', '[0:v][0:a][1:v][1:a][2:v][2:a]concat=n=3:v=1:a=1[v][a]',
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'medium', '-b:v', g.bitrate, '-r', String(g.fps),
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2',
    ...(bitexact ? ['-map_metadata', '-1'] : []),
    out,
  ], { stdio: 'inherit' });
}
