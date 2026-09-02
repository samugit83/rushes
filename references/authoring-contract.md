# The authoring contract

How a storyboard is written, and why each rule exists.

## The shape

```jsonc
{
  "schemaVersion": 1,
  "id": "tour",                    // matches the filename: demos/tour.demo.json
  "feature": "the entry ledger",   // the thumbnail line and the default title
  "scope": "demo-project",         // free-form; the adapter interprets it

  "seed":   { "app-tour-seen": "1" },
  "prep":   [ { "do": "goto", "path": "/" } ],   // off the clock, not narrated
  "redact": [".customer-name"],

  "assert": [
    { "metric": "entries", "endpoint": "/api/stats", "jsonPath": "counts.entries",
      "min": 100, "because": "scene 'scale' says 'over a hundred'" }
  ],

  "opening": { "kicker": "…", "title": "…", "subtitle": "…", "disclaimer": "…", "narration": "…" },
  "scenes":  [ … ],
  "closing": { "title": "…", "subtitle": "…", "narration": "…" },
  "youtube": { "title": "…", "hook": "…", "summary": "…", "chapterLabels": { "overview": "The overview" } }
}
```

`additionalProperties` is false everywhere, on purpose. Before that was true,
`"minHold": 9000` instead of `"minHoldMs"` was silently ignored and the scene
fell back to 2,200 ms, and `"do": "clik"` hit no case in the switch and returned
without doing anything. Both now fail loudly.

## A scene

```jsonc
{
  "id": "detail",
  "narration": "Clicking a row opens its detail panel.",
  "expect": [{ "text": "Entry detail" }],
  "steps": [
    { "do": "click", "text": "INV-1003" },
    { "do": "waitFor", "text": "Entry detail" }
  ],
  "minHoldMs": 4000,
  "tailPadMs": 400,
  "beats": [{ "on": "detail", "do": "focus", "target": "panel" }],
  "volatile": false
}
```

**The voice is the clock.** Each scene is held for at least `audio + tailPadMs`,
or `minHoldMs`, whichever is longer. The picture is stretched to the voice, never
the reverse, so narration can never be cut off. If the steps finish early, the
mux freezes the last action frame for the remainder rather than recording live
idle.

## `expect` is the whole point

```jsonc
"expect": [{ "text": "Entry detail" }, { "css": "[data-drawer]" }]
```

Asserted after the steps run, before the timeline entry is pushed. **Without it,
a scene's claim and what is on screen are connected only by hope.** A storyboard
whose locators are all broken otherwise produces a complete, correctly narrated,
correctly captioned video of a page that never changed — and every stage
downstream reports success.

Write the expect describing the state the scene LEAVES BEHIND, not the one it
started from. A scene that navigates away and then expects the old page is the
most common self-inflicted failure.

## Locators, in priority order

`text` > `role` + `name` > `testId` > `css`.

That order is not a style preference. A storyboard written against visible text
and ARIA roles survives a refactor that renames every class; one written against
CSS does not, and across a catalogue of dozens of videos that is the difference
between maintaining a series and abandoning it. The linter warns when a `css`
locator was used and something better was available.

When a locator misses, the diagnostic carries the three closest visible strings
by edit distance, how many nodes the selector matched (zero and several are
different bugs), and a trimmed accessibility tree. **Pick a fix from
`supportedFixes`. Never invent one.**

## `assert`: claims the voice makes

```jsonc
"assert": [{ "metric": "nodes", "endpoint": "/api/graph", "jsonPath": "info.totalNodes",
             "min": 1000, "because": "scene 'scale' narration" }]
```

Fetched during boot from the app's own API. A metric declares the endpoint AND
the JSON path it reads; a path that is absent or non-numeric FAILS, and is never
treated as satisfied.

This protects something you cannot fix after upload. "This project already holds
well over a thousand nodes" as a hardcoded string is true until the demo data is
reseeded smaller, and then the video is quietly wrong and stays wrong.

## Pacing

- One idea per scene. Two "and then"s means two scenes.
- Read the narration aloud. If you would not say it, rewrite it.
- Write acronyms normally. The voice layer applies the pronunciation map and the
  caption keeps the real spelling.
- A scene holding more than eight seconds of silence after its narration ends is
  flagged, and the diagnostic names the SLOWEST STEP in that scene, so it is
  actionable rather than an observation.

## What you must never do

- Never delete a narration line, a caption, or a scene to make a check pass.
  Repair the storyboard, or report the failure truthfully.
- Never put an absolute URL in `path`. Off-origin navigation uses `external`, and
  it requires an allowlist entry, which is the point. The page is filmed from a
  context that holds none of your credentials; steps after the `goto` still act
  on it, and the visit ends with the scene.
- Never point a `goto` at a `file://` URL. Use `{ "do": "slide", "slide": "id" }`.
- Never claim in narration something no `expect` and no `assert` covers.

## The repair order

1. schema and lint errors
2. unresolved locators
3. failed scene `expect`s
4. rehearsal disagreements
5. dead air and pacing
6. narration wording, title length, chapter labels

Fixing pacing before locators is wasted work: the locators change the pacing.

**The stop rule.** Continue focused correction while the objective error count
reaches a new minimum. If two consecutive rounds do not improve that best count,
stop and report the unresolved diagnostics truthfully.
