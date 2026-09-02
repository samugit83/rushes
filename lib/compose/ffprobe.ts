// Every measurement of a media file goes through here, so "how long is this"
// has exactly one answer everywhere in the pipeline.

import { execFileSync, spawnSync } from 'node:child_process';
import { hasBinary } from '../platform.ts';

export function ffprobeJson(path: string, entries: string): Record<string, unknown> {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', entries, '-of', 'json', path,
  ]).toString();
  return JSON.parse(out) as Record<string, unknown>;
}

export function ffprobeDurationMs(path: string): number {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', path,
  ]).toString().trim();
  const secs = parseFloat(out);
  if (!Number.isFinite(secs)) throw new Error(`ffprobe could not measure ${path}`);
  return Math.round(secs * 1000);
}

export interface VideoStreamInfo {
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  hasAudio: boolean;
}

export function probeVideo(path: string): VideoStreamInfo {
  const raw = ffprobeJson(path, 'stream=width,height,r_frame_rate,codec_type:format=duration');
  const streams = (raw.streams ?? []) as { width?: number; height?: number; r_frame_rate?: string; codec_type?: string }[];
  const v = streams.find((s) => s.codec_type === 'video');
  const [num, den] = (v?.r_frame_rate ?? '0/1').split('/').map(Number);
  const format = (raw.format ?? {}) as { duration?: string };
  return {
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    fps: den ? Math.round((num / den) * 100) / 100 : 0,
    durationMs: Math.round(parseFloat(format.duration ?? '0') * 1000),
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
  };
}

/**
 * Mean and peak volume in dB, via ffmpeg's volumedetect.
 *
 * The numbers arrive on STDERR, because ffmpeg's filters report through av_log
 * and only the encoded stream goes to stdout. Reading the wrong one returns an
 * empty string, which parses to NaN — a check that measured nothing while
 * reporting a warning, which is worse than one that fails.
 */
export function volumeDetect(path: string): { meanDb: number; maxDb: number } {
  const run = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', path, '-vn', '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const text = run.stderr ?? '';
  const mean = parseFloat(text.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/)?.[1] ?? 'NaN');
  const max = parseFloat(text.match(/max_volume:\s*(-?\d+(?:\.\d+)?) dB/)?.[1] ?? 'NaN');
  return { meanDb: mean, maxDb: max };
}

/** Integrated loudness in LUFS, via the loudnorm analysis pass. */
export function measureLoudness(path: string): number {
  try {
    const run = spawnSync('ffmpeg', [
      '-hide_banner', '-nostats', '-i', path, '-vn',
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-',
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const text = run.stderr ?? '';
    const json = text.slice(text.lastIndexOf('{'), text.lastIndexOf('}') + 1);
    return parseFloat((JSON.parse(json) as { input_i?: string }).input_i ?? 'NaN');
  } catch {
    return NaN;
  }
}

export function hasFfmpeg(): boolean {
  // Both, not either: every stage that needs one needs the other, and reporting
  // "present" on half of them turns a missing tool into a mid-build crash.
  return hasBinary('ffmpeg') && hasBinary('ffprobe');
}
