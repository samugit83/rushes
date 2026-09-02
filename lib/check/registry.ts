// The check registry, and the fail-closed rule (SP7).
//
// A check's severity depends on the quality profile: `standard` is an internal
// review cut, `showcase` is anything publishable. A receipt showing fewer than
// the full check set must never be reported as a showcase pass, so the checker
// records the profile it ran under and the count, and `publish` reads both.
//
// SP7 — everything fails closed. The COMPLETE set of checks permitted to degrade
// to a warning is the DEGRADABLE list below. Anything privacy-, consent- or
// identity-related is an error at every profile. A future check that wants to
// degrade must be added to that list explicitly, which is the point of writing
// it down rather than leaving it to each check's own opinion.

import type { QualityProfile } from '../config.ts';

export type Level = 'error' | 'warn' | 'ignore';

export interface CheckSpec {
  name: string;
  measures: string;
  standard: Level;
  showcase: Level;
}

export const CHECKS: CheckSpec[] = [
  { name: 'storyboard_schema', measures: 'schema + cross-field lint', standard: 'error', showcase: 'error' },
  { name: 'config_valid', measures: 'project config passes its schema and every ${VAR} resolves', standard: 'error', showcase: 'error' },
  { name: 'steps_resolved', measures: 'zero step/* errors in problems.json', standard: 'warn', showcase: 'error' },
  { name: 'scene_expects', measures: 'every scene expect satisfied', standard: 'warn', showcase: 'error' },
  { name: 'rehearsal_agreed', measures: 'the two rehearsal passes matched', standard: 'ignore', showcase: 'error' },
  { name: 'timeline_complete', measures: 'every scene present, monotonic, non-overlapping', standard: 'error', showcase: 'error' },
  { name: 'narration_covered', measures: 'every scene has audio; audio fits the scene', standard: 'error', showcase: 'error' },
  { name: 'dead_air', measures: 'per-scene gap at or under 8s', standard: 'warn', showcase: 'error' },
  { name: 'audio_present', measures: 'volumedetect mean between -30 and -6 dB', standard: 'warn', showcase: 'error' },
  { name: 'audio_loudness', measures: 'integrated loudness -18..-14 LUFS', standard: 'ignore', showcase: 'warn' },
  { name: 'video_stream', measures: 'resolution, fps and duration as configured', standard: 'error', showcase: 'error' },
  { name: 'no_black_scene', measures: 'scene midpoint keyframe not uniformly dark', standard: 'ignore', showcase: 'error' },
  { name: 'scene_opens_on_its_slide', measures: 'a slide scene is showing its slide when its narration starts', standard: 'error', showcase: 'error' },
  { name: 'captions_aligned', measures: 'cues exist; the last cue ends before the video does', standard: 'warn', showcase: 'error' },
  { name: 'caption_reading_rate', measures: 'no cue over ~20 characters per second', standard: 'ignore', showcase: 'warn' },
  { name: 'privacy_clean', measures: 'no secret or PII pattern in captured visible text', standard: 'error', showcase: 'error' },
  { name: 'never_show_clean', measures: 'no never-show term in narration, captions or evidence', standard: 'error', showcase: 'error' },
  { name: 'assert_metrics', measures: 'every assert satisfied against live data', standard: 'error', showcase: 'error' },
  { name: 'youtube_meta', measures: 'title within the limit; chapters 3+ or none; no orphan labels', standard: 'warn', showcase: 'error' },
  { name: 'narration_check', measures: 'zero unverified scenes from the vision check', standard: 'ignore', showcase: 'error' },
  { name: 'slide_font_embedded', measures: 'computed font-family is the embedded face on every slide', standard: 'error', showcase: 'error' },
  { name: 'slide_no_overflow', measures: 'no block whose scrollWidth exceeds its clientWidth', standard: 'error', showcase: 'error' },
  { name: 'slide_safe_area', measures: 'no element outside the frame', standard: 'error', showcase: 'error' },
  { name: 'slide_min_font', measures: 'no rendered text below the size floor', standard: 'warn', showcase: 'error' },
  { name: 'slide_contrast', measures: 'every text/background pair at or above 4.5:1', standard: 'warn', showcase: 'error' },
  { name: 'slide_beats_fired', measures: 'every declared beat fired before the scene ended', standard: 'warn', showcase: 'error' },
  { name: 'slide_word_count', measures: 'words per slide under the ceiling', standard: 'ignore', showcase: 'warn' },
  { name: 'slide_edge_through_node', measures: 'no connector runs through a box it does not connect', standard: 'error', showcase: 'error' },
  { name: 'slide_route_composition', measures: 'no unrelated connectors cross or share a corridor', standard: 'warn', showcase: 'error' },
  { name: 'slide_label_clearance', measures: 'no connector label covers a box, a route or another label', standard: 'ignore', showcase: 'warn' },
  { name: 'slide_projected_readability', measures: 'the smallest text still readable once projected into a video player', standard: 'ignore', showcase: 'warn' },
  { name: 'slide_authored_fidelity', measures: 'authored slides stay on the project palette and face (L18)', standard: 'ignore', showcase: 'warn' },
  { name: 'slide_source_truth', measures: 'generated slide content matches the repo it was derived from', standard: 'error', showcase: 'error' },
  { name: 'slide_golden', measures: 'rendered slide matches its checked-in golden PNG', standard: 'ignore', showcase: 'warn' },
  { name: 'publish_consent', measures: 'the publish-safety question was answered yes and recorded', standard: 'error', showcase: 'error' },
  { name: 'recording_identity', measures: 'the recording identity is dedicated, not an operator account', standard: 'error', showcase: 'error' },
  { name: 'egress_policy', measures: 'every host contacted, and every redirect hop, passed the resolved-IP classification', standard: 'error', showcase: 'error' },
  { name: 'external_allowlisted', measures: 'every off-origin navigation named a host in external.allow', standard: 'error', showcase: 'error' },
  { name: 'external_credential_free', measures: 'no external request carried a header or basic credential', standard: 'error', showcase: 'error' },
  { name: 'file_scope', measures: 'every file:// target lay inside the compiled slide directory', standard: 'error', showcase: 'error' },
  { name: 'no_pending_restore', measures: 'no leftover .rushes/pending-restore.json', standard: 'error', showcase: 'error' },
  { name: 'receipt_auditable', measures: 'every auditable receipt field is present and non-empty', standard: 'error', showcase: 'error' },
  { name: 'secret_scrub', measures: 'no resolved secret value appears in any diagnostic, receipt or log', standard: 'error', showcase: 'error' },
  { name: 'env_allowlist', measures: "the skill's .env carries only the two voice keys", standard: 'error', showcase: 'error' },
  { name: 'auth_effective', measures: 'the app is signed in after the auth strategy ran', standard: 'error', showcase: 'error' },
  { name: 'engine_neutral', measures: 'no product-specific identifier appears in lib/, bin/ or schemas/', standard: 'ignore', showcase: 'error' },
];

/**
 * SP7's named exception list. Nothing outside this may degrade to a warning at
 * the showcase profile, and adding to it is a deliberate act, not a default.
 */
export const DEGRADABLE = new Set([
  'audio_loudness',
  'caption_reading_rate',
  'slide_word_count',
  'slide_golden',
  'slide_authored_fidelity', // L18: inconsistency is made visible, not forbidden
  // Both are advisory on purpose. A label collision is repaired by rewording,
  // which is an editorial act, and the projected floor is a house standard
  // rather than a defect in the artifact. Neither is allowed to become an
  // error quietly: adding a name here is the deliberate act SP7 asks for.
  'slide_label_clearance',
  'slide_projected_readability',
]);

export function levelFor(spec: CheckSpec, profile: QualityProfile): Level {
  const level = profile === 'showcase' ? spec.showcase : spec.standard;
  if (profile === 'showcase' && level !== 'error' && !DEGRADABLE.has(spec.name)) {
    // A check that is not on the exception list may not be softer than an error
    // at the publishable profile, whatever its row says.
    return level === 'ignore' ? 'ignore' : 'error';
  }
  return level;
}

export function specFor(name: string): CheckSpec | undefined {
  return CHECKS.find((c) => c.name === name);
}
