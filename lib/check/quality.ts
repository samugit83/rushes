// The advisory score sheet (Q4).
//
// NOT A GATE. The checks decide whether a video may ship; this decides whether
// video 40 is worse than video 3, which is a different question and one nothing
// else in the pipeline answers. A number that tells you the series is drifting
// is worth having even when every individual video passed.

import type { TimelineEntry } from '../types.ts';
import type { CheckReport } from './index.ts';

export interface QualityScore {
  sceneCount: number;
  meanSceneSeconds: number;
  longestStaticStretchSeconds: number;
  motionShare: number;          // share of screen time in which a step was running
  captionCharsPerSecond: number;
  cursorTravelPx: number;
  deadAirSeconds: number;
  verdict: string;
}

export function scoreSheet(timeline: TimelineEntry[], report?: CheckReport): QualityScore {
  const total = timeline.reduce((n, e) => n + (e.endMs - e.startMs), 0) || 1;
  const acting = timeline.reduce((n, e) => n + ((e.actionEndMs ?? e.endMs) - e.startMs), 0);
  const deadAir = timeline.reduce((n, e) => n + Math.max(0, e.endMs - (e.actionEndMs ?? e.endMs)), 0);
  const longestStatic = Math.max(0, ...timeline.map((e) => e.endMs - (e.actionEndMs ?? e.endMs)));
  const chars = timeline.reduce((n, e) => n + (e.narration?.length ?? 0), 0);
  const spoken = timeline.reduce((n, e) => n + (e.audioDurationMs ?? 0), 0) || 1;
  // A proxy, not a measurement: every step that moves the cursor is counted as
  // one traverse of a quarter frame. Comparable between videos, meaningless alone.
  const moves = timeline.reduce((n, e) =>
    n + (e.steps ?? []).filter((s) => ['click', 'hover', 'moveTo', 'type', 'drag', 'highlight', 'clickCanvas'].includes(s.do)).length, 0);

  const meanScene = total / timeline.length / 1000;
  const motionShare = acting / total;
  const cps = (chars / spoken) * 1000;

  const notes: string[] = [];
  if (meanScene > 25) notes.push('scenes run long; consider splitting');
  if (motionShare < 0.4) notes.push('most screen time is static');
  if (cps > 20) notes.push('the captions read fast');
  if (longestStatic > 12_000) notes.push('one scene holds a still frame for over twelve seconds');

  return {
    sceneCount: timeline.length,
    meanSceneSeconds: Number(meanScene.toFixed(1)),
    longestStaticStretchSeconds: Number((longestStatic / 1000).toFixed(1)),
    motionShare: Number(motionShare.toFixed(2)),
    captionCharsPerSecond: Number(cps.toFixed(1)),
    cursorTravelPx: moves * 480,
    deadAirSeconds: Number((deadAir / 1000).toFixed(1)),
    verdict: notes.length ? notes.join('; ') : 'nothing stands out',
  };
}

export function formatScore(s: QualityScore): string {
  return [
    `  scenes            ${s.sceneCount}`,
    `  mean scene        ${s.meanSceneSeconds}s`,
    `  motion share      ${(s.motionShare * 100).toFixed(0)}%`,
    `  longest still     ${s.longestStaticStretchSeconds}s`,
    `  caption rate      ${s.captionCharsPerSecond} chars/s`,
    `  dead air          ${s.deadAirSeconds}s (frozen, not recorded live)`,
    `  advisory          ${s.verdict}`,
  ].join('\n');
}
