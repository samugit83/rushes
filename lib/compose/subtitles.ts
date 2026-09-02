// Caption sidecars from one timeline. Nothing is burned into the picture: the
// .vtt is uploaded to YouTube as a real caption track (toggleable, translatable,
// indexed for search) and the .srt is what LinkedIn's uploader accepts. Burning
// pixels would cover the very interface the video exists to show, and could never
// be turned off or translated.
//
// Each scene's narration is chunked into sentence-level cues timed across the
// scene's AUDIO window (not the whole scene), so captions track the voice, stay
// short enough to read, and clear during any silent tail after the narration.

import type { TimelineEntry } from '../types.ts';

interface Cue { startMs: number; endMs: number; text: string }

// Split into sentences, then greedily merge tiny fragments so no cue is a stray
// two-word line. Keeps sentence-ending punctuation.
function sentences(text: string): string[] {
  const raw = text.match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const out: string[] = [];
  for (const s of raw) {
    // fold only a genuinely short fragment into the previous cue
    if (out.length && s.length < 25) out[out.length - 1] += ' ' + s;
    else out.push(s);
  }
  return out;
}

// One entry -> sentence cues distributed across [startMs, startMs+audioMs] by
// character length (a good proxy for speaking time without word-level align).
function cuesFor(e: TimelineEntry): Cue[] {
  const audioMs = e.audioDurationMs ?? (e.endMs - e.startMs);
  const parts = sentences(e.narration ?? '');
  const total = parts.reduce((a, s) => a + s.length, 0) || 1;
  const cues: Cue[] = [];
  let t = e.startMs;
  parts.forEach((s, i) => {
    const dur = (audioMs * s.length) / total;
    const end = i === parts.length - 1 ? e.startMs + audioMs : t + dur;
    cues.push({ startMs: Math.round(t), endMs: Math.round(end), text: s });
    t = end;
  });
  return cues;
}

function allCues(timeline: TimelineEntry[]): Cue[] {
  return timeline.filter((e) => e.narration?.trim()).flatMap(cuesFor);
}

function wrap(text: string, max = 54): string[] {
  const words = text.split(/\s+/);
  const rows: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max) { rows.push(cur.trim()); cur = w; }
    else cur += ' ' + w;
  }
  if (cur.trim()) rows.push(cur.trim());
  return rows;
}

function vttTime(ms: number): string {
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000), cs = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}.${p(cs, 3)}`;
}

// VTT sidecar for the FINAL video: shift by the intro card's duration.
export function buildVtt(timeline: TimelineEntry[], offsetMs: number): string {
  const out = ['WEBVTT', ''];
  allCues(timeline).forEach((c, i) => {
    out.push(String(i + 1));
    out.push(`${vttTime(c.startMs + offsetMs)} --> ${vttTime(c.endMs + offsetMs)}`);
    out.push(wrap(c.text).join('\n'));
    out.push('');
  });
  return out.join('\n');
}

// SRT sidecar for LinkedIn, whose uploader takes .srt (and not .vtt) when you
// post a video. Same cues, comma decimal separator, no WEBVTT header.
export function buildSrt(timeline: TimelineEntry[], offsetMs: number): string {
  const out: string[] = [];
  allCues(timeline).forEach((c, i) => {
    const t = (ms: number) => vttTime(ms).replace('.', ',');
    out.push(String(i + 1));
    out.push(`${t(c.startMs + offsetMs)} --> ${t(c.endMs + offsetMs)}`);
    out.push(wrap(c.text).join('\n'));
    out.push('');
  });
  return out.join('\n');
}
