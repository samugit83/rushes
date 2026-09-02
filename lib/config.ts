// Engine defaults. Everything here is true of *any* application being filmed;
// anything that is a fact about one product lives in rushes.config.json
// (principle 10). Video geometry is fixed so every stage (record, cards, mux)
// agrees without passing sizes around; a project may override it.

export const VIDEO = {
  width: 1920,
  height: 1080,
  fps: 30,
  // ~12 Mbps master so a transcode of a flat dark UI stays crisp.
  bitrate: '12M',
} as const;

export const TIMING = {
  bootMs: 1600, // hold after the page settles before scene 0 (first-paint jitter)
  // Dark pre-roll parked on assets/hold.html just before the clock starts, when
  // scene 0 opens with its own `goto`. A change-driven screencast timeline is
  // not linear with wall clock, so the mux's leadTrimMs trim is approximate and
  // the boot page used to leak into the top of the body. Parking on a neutral
  // dark frame first makes whatever leaks harmless. Unnecessary under an engine
  // that timestamps its own frames (K7).
  preRollMs: 3000,
  sceneTailPadMs: 400, // default silence held after a scene's narration ends
  minSceneMs: 2200, // floor for a scene length (terse narration still lingers)
  cardPadMs: 600, // extra hold on intro/outro cards after their narration
  typeDelayMs: 45, // per-character cadence when the demo "types" into a field
  cursorGlideMs: 650, // how long the synthetic cursor takes to travel to a target
  beatLeadMs: 180, // fire a slide beat this early: viewers look, then listen
} as const;

// Framework-agnostic readiness defaults (P4). A server-rendered page settles in
// one paint; a hydrating SPA settles after its first data fetch. The engine does
// not need to know which — it waits for the same observable conditions.
export const READINESS = {
  quietMs: 500, // no in-flight requests for this long
  timeoutMs: 20_000,
  pollMs: 100,
} as const;

// Off-origin pages are someone else's: slower, noisier, and full of beacons.
export const EXTERNAL_READINESS = {
  quietMs: 1200,
  timeoutMs: 30_000,
  pollMs: 150,
} as const;

export const THRESHOLDS = {
  deadAirMs: 8000, // per-scene silence after the narration ends
  audioMeanDbMin: -30,
  audioMeanDbMax: -6,
  loudnessLufsMin: -18,
  loudnessLufsMax: -14,
  captionCharsPerSec: 20,
  slideMinFontPx: 22,
  slideContrastRatio: 4.5,
  slideWordCeiling: 60,
  // Readability as PROJECTED, not as authored. A slide is composed in a
  // 1920-wide frame, and the 22px floor above is measured there — but it is
  // watched inside a video player that is routinely 640px wide or less, where
  // 22px arrives as 7px. The pair below says "assume a 640px player, and demand
  // 10px there", which works out to a 30px authored floor.
  slideViewingWidthPx: 640,
  slideProjectedMinPx: 10,
  // Connector composition. A route may pass no closer than this to a box it
  // does not connect, and two unrelated routes closer than the gap for longer
  // than the run read as one line.
  slideRouteNodeGapPx: 2,
  slideCorridorGapPx: 8,
  slideCorridorMinPx: 40,
  // A golden frame differs when more than this fraction of its pixels moved by
  // more than the per-channel tolerance. Anti-aliasing must not trip it.
  slideGoldenPixelRatio: 0.002,
  slideGoldenChannelTolerance: 8,
  freeMemoryFloorMb: 2048, // CF4: refuse to record below this
  rehearsalBoxTolerancePx: 8,
  rehearsalTimingTolerancePct: 0.35,
} as const;

export type QualityProfile = 'standard' | 'showcase';
