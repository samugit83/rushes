# The delivery contract

What gets measured, what a receipt means, and the exact meaning of every status
word. **Nothing here is decorative: a status that is used loosely makes the whole
gate worthless.**

## The three evidence tiers, never conflated

| Tier | Claim | Produced by |
|---|---|---|
| **Deterministic** | measured and repeatable | `validate`, `rehearse`, `check` |
| **Frame evidence** | a keyframe from the DELIVERED file matches the narration | `evidence` |
| **Human review** | a person watched it | a person, and only a person |

**Passing one never implies another.** In particular:

- `skipped` maps ONLY to "the tool or the artifact was unavailable". A runtime
  failure is `failed`, and normalising the second into the first is how a broken
  tool reports a clean run.
- A failed or skipped evidence run DELETES its stale sidecars, rather than
  leaving the previous run's frames sitting there looking current.
- `human_review` stays `pending` until a person says otherwise. It is never
  inferred, and it is never claimed on their behalf.

## Frame evidence comes from the delivered file

Not from a probe run, not from a validation pass, not from a screenshot taken
during authoring. The mp4's sha256 is recorded alongside the frames, so a frame
that no longer belongs to the delivered artifact can be detected rather than
assumed current. This closes a whole class of bug: probe frames can look perfect
while the delivered video is wrong.

## Quality profiles

`--quality standard` is an internal review cut. `--quality showcase` is anything
publishable, and it is the default.

A receipt that ran fewer than the full check set can never be reported as a
showcase pass: the checker records the profile it ran under and the count, and
`publish` reads both.

## Atomic delivery

1. A staging directory is created BESIDE the target, so the final rename is one
   same-filesystem atomic commit.
2. The storyboard bytes are frozen into it with `flag: 'wx'`, and the build reads
   THE SNAPSHOT. A mid-flight edit cannot change what was checked.
3. Everything is composed into staging.
4. The checker runs against the staged file.
5. On pass only: rename into place, then write the receipt.
6. On failure: remove the staging directory. The previous artifact is untouched,
   and the exit code is non-zero.

## The publish gate

`publish` refuses unless all five hold:

- a receipt exists
- `receipt.profile === "showcase"`
- `receipt.summary.errors === 0`
- the receipt's storyboard sha256 equals the storyboard on disk NOW
- the receipt's artifact sha256 equals the mp4 on disk NOW

The storyboard clause closes a live hole rather than a theoretical one: you could
otherwise edit the storyboard after recording, regenerate the description from
the new one, and upload chapter timestamps that did not match the video.

`--force` overrides deliberately, writes `overridden: true` into the receipt, and
prints a loud warning. It is never silent.

## Fail closed, with a named exception list

Every check fails closed. The COMPLETE set permitted to degrade to a warning at
the showcase profile is:

- `audio_loudness`
- `caption_reading_rate`
- `slide_word_count`
- `slide_golden`
- `slide_authored_fidelity`

Anything privacy-, consent- or identity-related is an error at every profile. A
future check that wants to degrade must be added to that list explicitly, which
is the point of writing it down rather than leaving it to each check's opinion.

## The check registry

Generated from `lib/check/registry.ts`. A table that has drifted from the code is
worse than no table.

| Check | Measures | standard | showcase |
|---|---|---|---|
| `storyboard_schema` | schema + cross-field lint | **error** | **error** |
| `config_valid` | project config passes its schema and every ${VAR} resolves | **error** | **error** |
| `steps_resolved` | zero step/* errors in problems.json | warn | **error** |
| `scene_expects` | every scene expect satisfied | warn | **error** |
| `rehearsal_agreed` | the two rehearsal passes matched | ignore | **error** |
| `timeline_complete` | every scene present, monotonic, non-overlapping | **error** | **error** |
| `narration_covered` | every scene has audio; audio fits the scene | **error** | **error** |
| `dead_air` | per-scene gap at or under 8s | warn | **error** |
| `audio_present` | volumedetect mean between -30 and -6 dB | warn | **error** |
| `audio_loudness` | integrated loudness -18..-14 LUFS | ignore | warn |
| `video_stream` | resolution, fps and duration as configured | **error** | **error** |
| `no_black_scene` | scene midpoint keyframe not uniformly dark | ignore | **error** |
| `captions_aligned` | cues exist; the last cue ends before the video does | warn | **error** |
| `caption_reading_rate` | no cue over ~20 characters per second | ignore | warn |
| `privacy_clean` | no secret or PII pattern in captured visible text | **error** | **error** |
| `never_show_clean` | no never-show term in narration, captions or evidence | **error** | **error** |
| `assert_metrics` | every assert satisfied against live data | **error** | **error** |
| `youtube_meta` | title within the limit; chapters 3+ or none; no orphan labels | warn | **error** |
| `narration_check` | zero unverified scenes from the vision check | ignore | **error** |
| `slide_font_embedded` | computed font-family is the embedded face on every slide | **error** | **error** |
| `slide_no_overflow` | no block whose scrollWidth exceeds its clientWidth | **error** | **error** |
| `slide_safe_area` | no element outside the frame | **error** | **error** |
| `slide_min_font` | no rendered text below the size floor | warn | **error** |
| `slide_contrast` | every text/background pair at or above 4.5:1 | warn | **error** |
| `slide_beats_fired` | every declared beat fired before the scene ended | warn | **error** |
| `slide_word_count` | words per slide under the ceiling | ignore | warn |
| `slide_authored_fidelity` | authored slides stay on the project palette and face (L18) | ignore | warn |
| `slide_source_truth` | generated slide content matches the repo it was derived from | **error** | **error** |
| `slide_golden` | rendered slide matches its checked-in golden PNG | ignore | warn |
| `publish_consent` | the publish-safety question was answered yes and recorded | **error** | **error** |
| `recording_identity` | the recording identity is dedicated, not an operator account | **error** | **error** |
| `egress_policy` | every host contacted, and every redirect hop, passed the resolved-IP classification | **error** | **error** |
| `external_allowlisted` | every off-origin navigation named a host in external.allow | **error** | **error** |
| `external_credential_free` | no external request carried a header or basic credential | **error** | **error** |
| `file_scope` | every file:// target lay inside the compiled slide directory | **error** | **error** |
| `no_pending_restore` | no leftover .rushes/pending-restore.json | **error** | **error** |
| `receipt_auditable` | every auditable receipt field is present and non-empty | **error** | **error** |
| `secret_scrub` | no resolved secret value appears in any diagnostic, receipt or log | **error** | **error** |
| `auth_effective` | the app is signed in after the auth strategy ran | **error** | **error** |
| `engine_neutral` | no product-specific identifier appears in lib/, bin/ or schemas/ | ignore | **error** |

## The diagnostic registry

Every diagnostic carries a stable `code`, the exact `subject`, the measured
`evidence`, and enumerated `supportedFixes`. **The repairing agent picks from
`supportedFixes` and never invents a value.** That field is why the repair loop
converges instead of thrashing.

| Code | Severity | Fires when |
|---|---|---|
| `storyboard/schema` | error | the storyboard fails its schema, or two scenes share an id |
| `storyboard/chapter-orphan` | error | a chapter label names no scene |
| `storyboard/step-arg-mismatch` | error | a step carries an argument its kind does not read |
| `storyboard/missing-expect` | warning | the narration points at something and the scene declares no expect |
| `storyboard/css-over-semantic` | warning | a css locator was used where text or role was available |
| `input/json-parse` | error | the file is not valid JSON |
| `step/locator-unresolved` | error | no element matched |
| `step/locator-ambiguous` | warning | several matched and no nth was given |
| `step/timeout` | error | it matched but never became visible |
| `step/failed` | error | the action itself threw |
| `scene/expect-failed` | error | a scene-end assertion was not satisfied |
| `scene/narration-contradicted` | error | the vision check found the frame contradicts the line |
| `scene/dead-air` | warning | the scene holds more silence than the threshold |
| `scene/audio-missing` | error | no audio was produced for the scene |
| `rehearsal/non-deterministic` | error | the two rehearsal passes disagreed |
| `audio/silent-track` | error | the mean volume is outside the usable band |
| `audio/loudness-out-of-range` | warning | integrated loudness outside -18..-14 LUFS |
| `video/stream-invalid` | error | the resolution, frame rate or duration is wrong |
| `video/black-scene` | error | a scene's midpoint keyframe is uniformly dark |
| `captions/empty` | error | no cues were emitted |
| `captions/overrun` | error | the last cue ends after the video does |
| `captions/reading-rate` | warning | a cue runs faster than the reading rate |
| `privacy/secret-on-screen` | error | a secret pattern matched visible text |
| `privacy/secret-in-diagnostic` | error | the scrubber matched a resolved secret at write time |
| `intake/never-show-violated` | error | a never-show term appears on screen or in narration |
| `intake/publish-consent-missing` | error | nobody confirmed everything visible is safe to publish |
| `timeline/scene-missing` | error | a storyboard scene produced no timeline entry |
| `timeline/non-monotonic` | error | scene offsets overlap or go backwards |
| `youtube/title-too-long` | error | the prefix plus the sentence exceeds the limit |
| `youtube/chapters-insufficient` | warning | fewer than three chapters survived the merge |
| `assert/metric-unmet` | error | a narration claim failed its live check |
| `assert/metric-unavailable` | error | the declared endpoint or path yielded no numeric value |
| `slide/font-fallback` | error | a slide's computed font resolved to a fallback face |
| `slide/text-overflow` | error | a block's content is wider than its box |
| `slide/outside-safe-area` | error | an element extends beyond the frame |
| `slide/font-too-small` | error | rendered text below the size floor |
| `slide/low-contrast` | warning | a text and background pair below 4.5:1 |
| `slide/beat-not-reached` | error | a declared beat never fired before the scene ended |
| `slide/beat-anchor-missing` | error | a beat's anchor word is absent from the narration |
| `slide/beat-anchor-ambiguous` | error | the anchor occurs more than once and no index was given |
| `slide/word-count` | warning | a slide carries more words than the ceiling |
| `slide/block-over-capacity` | error | a block holds more items than its declared maximum |
| `slide/coordinate-in-source` | error | a slide source contains a coordinate; the schema forbids them |
| `slide/anchor-unmeasurable` | error | a connector anchor had no bounding box after layout |
| `slide/edge-through-node` | error | a connector runs through a box it does not connect |
| `slide/connector-self-loop` | error | a connector joins an item to itself, which has no drawable geometry |
| `slide/route-crossing` | warning | two unrelated connectors cross |
| `slide/route-corridor` | warning | two unrelated connectors share a visible corridor |
| `slide/label-clearance` | warning | a connector label covers a box, a route or another label |
| `slide/text-projected-too-small` | warning | the smallest text is unreadable once projected into a video player |
| `slide/off-token-colour` | warning | an authored slide used a literal colour where a token exists |
| `slide/off-project-font` | warning | an authored slide used a font outside the project face |
| `slide/authored-repeated` | warning | the same authored structure appears in two slides |
| `slide/mode-mismatch` | warning | a block with no topology declares connectors |
| `slide/source-drift` | error | a slide source is missing, or its content no longer matches the repo |
| `slide/golden-mismatch` | warning | the rendered slide differs perceptually from its checked-in golden frame |
| `style/tokens-unreadable` | warning | the app yielded no usable palette; the neutral fallback was used |
| `config/schema` | error | the project config fails its schema |
| `config/env-ref-unresolved` | error | a ${VAR} in the config is not set in the environment |
| `config/env-leak` | error | the skill's own .env carries a key outside the two-key allowlist |
| `config/host-not-allowed` | error | the application origin failed the resolved-IP classification |
| `config/recording-identity` | error | the recording identity is not a dedicated account |
| `external/host-not-allowed` | error | an off-origin goto names a host absent from external.allow |
| `external/credential-leak` | warning | context headers were stripped for an off-origin navigation |
| `external/redirect-refused` | error | a redirect hop resolved to an address that must not be reached |
| `external/file-scope` | error | a file:// target lies outside the compiled slide directory |
| `external/never-settled` | warning | an external page never satisfied its readiness inside the timeout |
| `external/secret-on-screen` | warning | the scanner matched on an external origin; needs acknowledgement |
| `auth/strategy-unsupported` | error | the config names a strategy the engine does not implement |
| `auth/state-missing` | error | storage-state is configured and no state file exists |
| `auth/state-expired` | error | the saved browser state is older than its TTL |
| `auth/not-signed-in` | error | the app still presents a sign-in surface after the strategy ran |
| `auth/csrf-token-missing` | error | form-login could not find the configured CSRF field |
| `preflight/method-forbidden` | error | a preflight used a method outside GET/HEAD/PATCH/POST |
| `preflight/path-escape` | error | a preflight path was absolute, scheme-relative or contained .. |
| `preflight/restore-conflict` | error | the value changed under us; the restore was aborted |
| `preflight/restore-pending` | error | a leftover pending-restore file was found and must be replayed |
| `readiness/timeout` | error | the settle predicate never satisfied; names the condition that failed |
| `readiness/busy-selector-stuck` | warning | the app's own busy indicator never cleared |
| `runner/consent-required` | error | the start command has no approval for this config sha256 |
| `runner/start-failed` | error | the start command exited before becoming ready |
| `runner/never-ready` | error | readyWhen did not become true inside the timeout |
| `runner/insufficient-memory` | error | free memory is below the floor for a recording |
| `delivery/commit` | error | the atomic rename failed |
| `delivery/receipt-mismatch` | error | publish found a receipt bound to different bytes |
| `engine/capability-missing` | error | the active engine does not implement a step the storyboard uses |
| `internal/unclassified` | error | fallback; it should never appear in a clean run |

## The receipt

```jsonc
// out/<id>/receipt.json
{
  "schemaVersion": 1,
  "id": "tour",
  "profile": "showcase",
  "builtAt": "2026-09-01T18:20:11.402Z",
  "tool": { "commit": "<git sha at build time>", "version": "1.0.0" },

  "config":     { "sha256": "…", "baseUrl": "…", "resolvedIp": "…", "authStrategy": "storage-state" },
  "storyboard": { "sha256": "…", "bytes": 8412, "schemaVersion": 1 },
  "artifact":   { "sha256": "…", "bytes": 178432190, "durationMs": 172400 },
  "timeline":   { "sha256": "…", "sceneCount": 10, "leadTrimMs": 25962 },

  "recording": {
    "identity": "…", "scope": "…",
    "hostsContacted": [{ "host": "localhost", "ip": "127.0.0.1", "external": false }],
    "preflight": [{ "method": "PATCH", "path": "/api/user/preferences", "status": 200, "restoreAfter": true }],
    "publishConsent": "yes, this is a seeded demo tenant",
    "externalConsent": "…",
    "volatileScenes": []
  },

  "checks":  [{ "name": "steps_resolved", "ok": true, "level": "error", "details": [] }],
  "summary": { "errors": 0, "warnings": 1, "checks": "21/21", "ran": 21, "total": 41 },

  "rehearsal":      { "status": "agreed", "passes": 2, "exemptScenes": [] },
  "frameEvidence":  { "status": "passed", "artifactSha256": "…", "frames": 10 },
  "narrationCheck": { "verified": 10, "unverified": 0, "inconclusive": 0 },
  "humanReview":    { "status": "pending", "reviewer": null },

  "diagnostics": [],
  "overridden": false
}
```

`recording` exists to answer, after the fact, the three questions an operator
will actually be asked: **which target was filmed, as whom, and with whose
approval.** Without them a publish is not reconstructable, which for a tool that
uploads publicly is not an acceptable gap.

## The handoff receipt

Your final message uses exactly these fields, and claims nothing beyond what was
measured:

```text
demo_id:            tour
artifact:           /abs/path/out/tour/tour.mp4
storyboard_sha256:  <from the receipt>
artifact_sha256:    <from the receipt>
validation:         21/21 showcase, 0 errors, 1 warning
rehearsal:          agreed | disagreed | skipped
frame_evidence:     passed | failed | skipped
narration_check:    verified | unverified | inconclusive
human_review:       pending | passed | failed
correction_rounds:  0 | 1 | 2
```

