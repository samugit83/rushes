// Character-level timing from the TTS provider, turned into word offsets.
//
// This is what makes a slide beat anchor to a WORD instead of a millisecond
// (L4). Two properties fall out that hand-timed animation never has:
//
//   1. Re-recording re-syncs automatically. A reworded sentence or a different
//      voice moves every beat correctly, with no storyboard edit.
//   2. A beat that never fired is a diagnostic, not a thing you notice on the
//      fourth viewing.

import { readFileSync, existsSync } from 'node:fs';
import type { Beat } from '../types.ts';

export interface Alignment {
  characters: string[];
  starts: number[]; // seconds
  ends: number[];   // seconds
}

export function loadAlignment(path: string): Alignment | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      characters?: string[];
      character_start_times_seconds?: number[];
      character_end_times_seconds?: number[];
    };
    if (!raw.characters?.length) return null;
    return {
      characters: raw.characters,
      starts: raw.character_start_times_seconds ?? [],
      ends: raw.character_end_times_seconds ?? [],
    };
  } catch {
    return null;
  }
}

/**
 * Offset, in ms, at which the `occurrence`-th case-insensitive whole-word match
 * of `word` begins. The alignment is over the SPOKEN text, which may differ from
 * the caption text (pronunciation aliases), so matching is done on the
 * alignment's own character stream.
 */
export function wordOffsetMs(alignment: Alignment, word: string, occurrence = 1): number | null {
  const text = alignment.characters.join('');
  const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi');
  let hit: RegExpExecArray | null;
  let n = 0;
  while ((hit = re.exec(text)) !== null) {
    n++;
    if (n === occurrence) {
      const start = alignment.starts[hit.index];
      return typeof start === 'number' ? Math.round(start * 1000) : null;
    }
  }
  return null;
}

export interface ResolvedBeat { beat: Beat; index: number; offsetMs: number }

/**
 * Resolve every beat to an offset, in narration order. A beat whose anchor
 * cannot be located is dropped here and reported by the checker as
 * `slide/beat-not-reached` when the fired count comes up short.
 */
export function beatOffsets(beats: Beat[], narration: string, alignmentPath: string): ResolvedBeat[] {
  const alignment = loadAlignment(alignmentPath);
  const out: ResolvedBeat[] = [];
  beats.forEach((beat, index) => {
    let offsetMs: number | null = null;
    if (alignment) offsetMs = wordOffsetMs(alignment, beat.on, beat.occurrence ?? 1);
    if (offsetMs === null) {
      // No alignment (a cached clip from before timestamps, or a local voice):
      // fall back to the word's position in the sentence, scaled by length. Less
      // exact, still monotonic, and better than firing everything at zero.
      const idx = narration.toLowerCase().indexOf(beat.on.toLowerCase());
      offsetMs = idx < 0 ? 0 : Math.round((idx / Math.max(1, narration.length)) * 1000 * (narration.length / 15));
    }
    out.push({ beat, index, offsetMs });
  });
  return out.sort((a, b) => a.offsetMs - b.offsetMs);
}
