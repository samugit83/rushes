---
name: rushes
description: >-
  Record a narrated, captioned, verified demo video of a web application by
  driving its real UI in a real browser. Use when asked to make a product demo,
  a screen recording with narration, a feature walkthrough, an app tour, a
  release video, a YouTube demo, a Loom-style explainer, or to turn a web app
  into a video. Works with Django, Rails, Next.js, a static site, or any other
  web framework; nothing about the framework is assumed.
license: MIT
metadata:
  version: 1.0.0
  author: Rushes
---

# Rushes

You describe the demo; Rushes drives the real UI, narrates each scene, cuts it
together with captions and chapters, and then **measures the finished file**. If
a check fails, nothing is delivered.

The one idea this skill is built around: **an artifact nobody measured is not
delivered.** You are a nondeterministic author, and the pixels come from live
software. Trust the measurement, not your own reading of what you wrote.

---

## 1. Intake

Read `references/intake-contract.md` for the full question list. The short form:

**Ask five questions, once, as one block.** Then echo a resolved brief the user
can correct in one reply. If `rushes.config.json` exists, three of the five are
already answered and you ask two.

1. What is this video about, and what should the viewer be able to do or
   understand when it ends?
2. Where is the app, and is it already running?
3. How should I sign in? (Recommend: "I will sign in myself once, now" →
   `rushes login`.)
4. Which account, project or tenant should I record, and **is everything visible
   in it safe to publish?**
5. How long, and who is watching?

**Question 4 is a hard stop.** Phrase it as "safe to publish", never "is it OK".
Anything short of a clear yes means you propose a seeded or demo tenant and **do
not record**. A wrong answer is unrecoverable after upload.

**Discover, default, ask, in that order.** Routes, page titles, the app's
palette and font, its busy selector, the presence of a cookie banner, the
framework, and the live value behind any factual claim are all DISCOVERED by
looking. Asking for one of them is a defect in this file, not a conversation
style.

Never ask about: resolution, frame rate, caption format, intro cards, or
publishing. Those are defaulted and echoed at Gate 1. Publishing questions are
deliberately deferred to Gate 4, which is what keeps intake to five questions.

---

## 2. The four gates

| Gate | When | You must |
|---|---|---|
| **1. Resolved brief** | before any storyboard | echo every answer, every default you took, every fact you discovered, and the extracted palette, in one message the user can correct in one reply |
| **2. Outline** | before any voice or browser | present the scene list with one narration line each. For every slide scene, name its **mode and block** and what goes on it |
| **2.5. Slide preview** | after the outline, still before any voice or browser | run `rushes slides preview <id>` and show one PNG per slide. This is where the user directs slide design, in words, against a picture |
| **3. Review** | after `deliver` exits zero | present the mp4 and its duration, the check summary, the narration-check counts, the evidence contact sheet, the thumbnail, the description and the post — then **stop** |
| **4. Publish** | on a new user message only | ask privacy, playlist and social, then `rushes publish <id> --confirm` |

Hard rules:

- **Never deliver and publish in the same turn.**
- Never treat silence, an ambiguous reply, or approval of the OUTLINE as consent
  to publish. Gate 4 needs an explicit new instruction.
- Never report `human_review: passed`. It stays `pending` until a person says
  they watched it.
- Never render a slide for the first time inside the finished video. That is the
  most expensive possible place to discover a design is wrong.

An outline at Gate 2 looks like this:

```text
1  [live]              the graph, panning
S1 [composed/flow-row] the scan launch journey: 5 boxes, 4 arrows, broker highlighted
2  [live]              a node drawer opens
S2 [authored]          one number, full bleed
3  [live]              filtering by type
```

---

## 3. Authoring: read these and nothing else first

Before you write your first candidate, read exactly three things:

- `schemas/storyboard.schema.json`
- `examples/demos/tour.demo.json`
- `references/config-contract.md` (only if there is no `rushes.config.json` yet)

**Do not read `lib/` before the first candidate exists**, and do not read it at
all until two focused repairs have failed. Reading the engine to guess what it
will accept is slower than running `rushes validate`, which tells you.

---

## 4. The step vocabulary

```jsonc
{ "do": "goto",        "path": "/reports" }                       // same origin
{ "do": "goto",        "external": "https://docs.example.com/x" } // needs external.allow
{ "do": "slide",       "slide": "pipeline" }                      // the compiled deck
{ "do": "click",       "text": "Apply filter" }
{ "do": "clickCanvas", "strategy": "saturated-disc", "confirm": { "text": "Details" } }
{ "do": "hover",       "role": "button", "name": "Export" }
{ "do": "moveTo",      "testId": "row-3" }
{ "do": "type",        "css": "#q", "value": "operations" }
{ "do": "press",       "keys": "Enter" }
{ "do": "scroll",      "css": "main", "dy": 400 }
{ "do": "drag",        "css": "canvas", "dx": -260 }
{ "do": "zoom",        "css": "canvas", "factor": 1.4 }
{ "do": "highlight",   "text": "Total", "ms": 1600 }
{ "do": "waitFor",     "text": "Ready" }
{ "do": "wait",        "ms": 900 }
```

**Locator priority is `text` > `role`+`name` > `testId` > `css`, and that order
is the point.** A storyboard written against visible text and ARIA roles
survives a refactor that renames every class. `css` works and is last; the linter
warns when you reach for it and something better was available.

---

## 5. Authoring invariants

- **One idea per scene.** If the narration has two "and then"s, it is two scenes.
- **Narration is spoken, not written.** Read it aloud. If you would not say it,
  rewrite it. Write acronyms normally — the voice layer handles pronunciation and
  the caption keeps the real spelling.
- **Every scene declares an `expect`.** It is the difference between a scene that
  claims something and a scene that proves it. A scene whose voice says "this",
  "here" or "click any" and declares no `expect` is flagged.
- **Never delete a narration line, a caption, or a scene to make a check pass.**
  Repair the storyboard, or report the failure truthfully.
- **Every number the voice says is bound to live data with an `assert`.** A claim
  that was true when you wrote it and false when it recorded is the failure this
  prevents, and it cannot be fixed after upload.
- **A slide is `composed` when it has a topology and `authored` when it does
  not.** Neither is a fallback for the other. See `references/slide-contract.md`.

---

## 6. Validate, rehearse, deliver

```bash
rushes doctor                    # once: node, ffmpeg, chrome, engine, keys
rushes login                     # once per project, if the app needs a sign-in
rushes slides preview <id>       # Gate 2.5: every slide as a PNG, no spend
rushes validate <id> --json      # schema, lint, and a LIVE dry run of every step
rushes rehearse <id> --json      # two silent passes; they must agree
rushes deliver  <id>             # build, check, commit atomically, write a receipt
rushes evidence <id>             # keyframes from the DELIVERED mp4 + narration check
```

`validate` and `rehearse` cost no voice credits and no ffmpeg time. Run them
until they are clean **before** `deliver`. `deliver` is the only command that
spends.

---

## 7. The repair order, and when to stop

Fixing pacing before locators is wasted work. Repair in this order:

1. schema and lint errors
2. unresolved locators
3. failed scene `expect`s
4. rehearsal disagreements
5. dead air and pacing
6. narration wording, title length, chapter labels

**The stop rule:**

> Continue focused correction while the objective error count reaches a new
> minimum. If two consecutive rounds do not improve that best count, stop and
> report the unresolved diagnostics truthfully.

And three rules that keep the loop converging:

- Change only the diagnosed `subject`.
- Apply one diagnosed fix at a time.
- **Pick a fix from `supportedFixes`. Never invent a value.** Every diagnostic
  enumerates the repairs that are known to work; that field is why this loop
  converges instead of thrashing.

---

## 8. The handoff receipt

Your final message uses exactly these fields, and claims nothing beyond what was
measured:

```text
demo_id:            tour
artifact:           /abs/path/out/tour/tour.mp4
storyboard_sha256:  <from the receipt>
artifact_sha256:    <from the receipt>
validation:         21/21 showcase, 0 errors, 1 warning
rehearsal:          agreed
frame_evidence:     passed
narration_check:    verified
human_review:       pending
correction_rounds:  1
```

`human_review` is **always** `pending` unless a person told you they watched it.
`skipped` means a tool was unavailable, and never that a check passed.

---

## 9. Setup and fallback

**How to invoke it.** If `rushes` is on the PATH, use it. It usually is not:
`npx skills add` copies the skill's files and installs no command, so run the
entry point from the skill's own directory instead, and read every `rushes <cmd>`
below as that.

```bash
node bin/rushes.mjs doctor        # from the directory this SKILL.md is in
```

The first invocation installs the skill's own dependencies, once, into that same
directory. It needs no privileges and asks for nothing. If it cannot, it prints
the single command to run by hand and stops.

Run `rushes doctor`. It prints exactly what is missing and the one command that
installs it.

- No voice keys? `RUSHES_TTS=local rushes deliver <id>` produces correctly-timed
  silent clips: fine for a rehearsal, a CI re-render or a draft cut, never for
  something you publish.
- No browser? `rushes doctor` names the install command. Rushes never downloads
  a browser itself.
- App not running? Either start it, or add a `runner` block — which requires an
  explicit, recorded approval of the exact command before it will ever run.

## Reference contracts

Read one only when you need it:

| File | Read it when |
|---|---|
| `references/intake-contract.md` | starting a new project, or the first video |
| `references/config-contract.md` | writing or changing `rushes.config.json` |
| `references/authoring-contract.md` | writing a storyboard |
| `references/slide-contract.md` | writing a slide source |
| `references/delivery-contract.md` | a check failed and you need the registry |
