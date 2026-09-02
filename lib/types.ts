// The typed spine of a demo. A `.demo.json` storyboard is authored by hand or by
// an agent (see SKILL.md); every stage reads and writes this shape.
//
// Principle 10: nothing here may be meaningless when filming a Django admin
// panel. Product-specific vocabulary (feature flags, tenant preferences) belongs
// in rushes.config.json, never in the storyboard schema.

export type StepKind =
  | 'goto'        // navigate to a path relative to baseUrl, or a declared external URL
  | 'slide'       // navigate the compiled deck to a slide (#/<id>) — no page load
  | 'click'       // click a resolved locator
  | 'clickCanvas' // click inside a canvas by strategy, confirmed by a locator
  | 'hover'       // hover a locator (glides the synthetic cursor onto it)
  | 'moveTo'      // just glide the cursor onto a locator (no click)
  | 'type'        // focus a locator and type text with a human cadence
  | 'press'       // press a keyboard key (e.g. "Enter")
  | 'scroll'      // wheel-scroll a locator (or the page) by `dy` pixels
  | 'drag'        // press-move-release on a locator: pans a canvas / graph
  | 'zoom'        // ctrl+wheel over a locator: zooms a canvas / graph
  | 'highlight'   // draw a focus ring around a locator and hold
  | 'waitFor'     // wait until a locator is visible (gates on real app state)
  | 'wait';       // idle for `ms` (let an animation or the narrator catch up)

export interface Locator {
  // At least one of these; resolved in priority order text > role > testId > css.
  css?: string;
  text?: string;   // visible text
  exact?: boolean; // text match must be exact
  role?: string;   // ARIA role
  name?: string;   // accessible name, paired with role
  testId?: string; // data-testid
  nth?: number;    // disambiguate when several match (0-based)
}

/** Where a canvas click aims before the confirm locator decides whether it landed. */
export type CanvasStrategy = 'saturated-disc' | 'center' | 'grid-scan';

export interface Step extends Locator {
  do: StepKind;
  path?: string;      // goto (same-origin, relative)
  external?: string;  // goto (off-origin; requires external.allow — P16)
  slide?: string;     // slide id
  keys?: string;      // press
  value?: string;     // type
  dy?: number;        // scroll / drag
  dx?: number;        // drag
  ms?: number;        // wait / hold overrides
  factor?: number;    // zoom (>1 in, <1 out)
  strategy?: CanvasStrategy; // clickCanvas
  confirm?: Locator;  // clickCanvas: what proves the click landed
}

/** A slide beat anchored to a word in the narration (L4). */
export interface Beat {
  on: string;                 // the anchor word, matched case-insensitively on a boundary
  occurrence?: number;        // 1-based, when the word appears more than once
  do: 'focus' | 'dim' | 'highlight' | 'spawn' | 'reveal' | 'travel';
  target: string;             // a block id inside the slide
}

export interface Scene {
  id: string;          // stable slug, also the audio cache key salt
  narration: string;   // what the voice says over this scene (also the caption)
  steps: Step[];
  /** Asserted after the steps run, before the timeline entry is pushed (D3). */
  expect?: Locator[];
  /** Slide beats, resolved to offsets from the TTS alignment (L4). */
  beats?: Beat[];
  minHoldMs?: number;  // floor for the scene length (terse narration)
  tailPadMs?: number;  // silence held after narration ends (default in config)
  /** Off-origin scenes are exempt from rehearsal equality when volatile (P16.6). */
  volatile?: boolean;
  // filled by the TTS stage
  audio?: { path: string; durationMs: number; alignmentPath?: string };
}

export interface OpeningCard {
  kicker: string;
  title: string;
  subtitle: string;
  disclaimer: string;
  narration: string;
  audio?: { path: string; durationMs: number };
}

export interface ClosingCard {
  title: string;
  subtitle: string;
  narration: string;
  audio?: { path: string; durationMs: number };
}

export interface YoutubeBlock {
  title?: string;    // the sentence after the configured title prefix
  summary?: string;
  hook?: string;
  chapterLabels?: Record<string, string>; // keyed by scene id (+ "intro"/"outro")
  linkedin?: string; // overrides the generated LinkedIn body (human voice!)
}

/**
 * A falsifiable claim the narration makes, checked against live data before the
 * build can pass (S1). CF8: a metric names the endpoint and the JSON path it
 * reads; a path that is absent or non-numeric fails, never passes.
 */
export interface Assertion {
  metric: string;   // label used in diagnostics
  endpoint: string; // same-origin path, e.g. "/api/graph?projectId=..."
  jsonPath: string; // dotted path into the response, e.g. "info.totalNodes"
  min?: number;
  max?: number;
  because: string;  // which narration line depends on it
}

export interface Storyboard {
  schemaVersion: 1;
  id: string;       // demo id; namespaces every output under out/<id>/
  feature: string;  // short human name of what is shown (thumbnail + title)
  /** Free-form scope the adapter interprets (e.g. a project/tenant name). */
  scope?: string;
  /** Extra localStorage keys seeded before any app script runs. */
  seed?: Record<string, string>;
  /** Setup steps run during boot, BEFORE the clock starts. Not narrated. */
  prep?: Step[];
  /** Selectors blurred in-page before the clock starts (E5). */
  redact?: string[];
  assert?: Assertion[];
  opening: OpeningCard;
  scenes: Scene[];
  closing: ClosingCard;
  youtube?: YoutubeBlock;
}

/** One recorded scene window, in ms from the start of the screencast. */
export interface TimelineEntry {
  sceneId: string;
  startMs: number;
  endMs: number;
  narration: string;
  audioPath?: string;
  audioDurationMs?: number;
  /** Per-step elapsed time, so dead air can be attributed to a step (T4). */
  steps?: { do: StepKind; ms: number }[];
  /** Where the steps finished, for the narration-driven freeze (T3). */
  actionEndMs?: number;
}

export interface RecordResult {
  webm: string;
  durationMs: number;
  leadTrimMs: number;
  timeline: TimelineEntry[];
  problems: import('./diagnostics.ts').Diagnostic[];
  /** Visible text captured per scene, for the privacy scan (E5). */
  sceneText: Record<string, string>;
  /** Hosts contacted, with the IP each resolved to. */
  hostsContacted: { host: string; ip: string; external: boolean }[];
  /** The resolver pinning the browser ran under, for the receipt. */
  hostRules: string | null;
  beatsFired: Record<string, number>;
}
