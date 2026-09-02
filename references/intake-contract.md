# The intake contract

What you must know before you start, where each fact comes from, and the exact
questions you are allowed to ask.

**The target is five questions, then a resolved brief the user corrects in one
reply.** Never an interrogation. If you ask for something you could have found
by looking at the app or the repository, that is a defect in this contract, not
a conversation style.

## The four buckets

Every fact a video needs falls into exactly one. Only the fourth is a question.

| Bucket | Rule |
|---|---|
| **Discovered** | you find it by looking at the app or the repository |
| **Defaulted** | a sane default exists; take it and echo it, never ask |
| **Remembered** | it is already in `rushes.config.json` or `rushes.brief.md` |
| **Asked** | the answer changes the video and cannot be found |

## Tier 0: the blocking five

Asked as one block, before anything else. If `rushes.config.json` exists, Q2 to
Q4 are already answered and you ask only Q1 and Q5.

**Q1. What is this video about, and what should the viewer be able to do or
understand when it ends?**

Free text. The second half matters more than the first: "understand why the
graph is the agent's knowledge base" produces a different video from "show the
graph".

**Q2. Where is the app, and is it already running?**

A URL, or a start command plus a readiness check. Feeds `baseUrl` and the
optional `runner` block. If they give you a start command, tell them it will
require an explicit approval before it ever runs.

**Q3. How should I sign in?**

- it is public, no sign-in
- **I will sign in myself once, now** ← recommend this one
- there is a login form; here are throwaway credentials
- a token or signed cookie, from an environment variable I already export

The recommended answer costs one interactive minute and buys every subsequent
unattended recording, and the skill never sees the credential.

**Q4. Which account, project or tenant should I record, and is everything
visible in it safe to publish?**

The hard safety gate. Phrase it as "safe to publish", never "is it OK". Anything
short of a clear yes means you propose a seeded or demo tenant and **do not
record**. Recorded in the receipt; enforced by the `publish_consent` check, which
is an error at every quality profile.

**Q5. How long, and who is watching?**

| Option | Shape |
|---|---|
| 60-90 seconds, someone who has never seen it | teaser: 1 slide, 3 scenes |
| **3-5 minutes, a developer evaluating it** | tour: 2-3 slides, 6-9 scenes ← default |
| 8-12 minutes, an existing user learning one feature | deep dive: 4+ slides, 10-14 scenes |

## Tier 1: the standing brief, asked once per project

Written to `rushes.brief.md`, read by every later video, never asked twice.

**S1. Where should the slide graphics come from?**

| Option | What it does |
|---|---|
| **`app-native`** ← default | derive the slide tokens from the running app's own computed styles, so the slides and the live UI share one palette |
| `repo-brand` | derive from the logo, the README, a `theme-color`, or a design-tokens file |
| `preset` | a shipped style: `console`, `editorial`, `blueprint` |
| `custom` | the user supplies a tokens file |

**Do not ask this cold.** Run `rushes slides tokens`, show the six colours and
the font it found, and ask for a yes.

**S2. Dark or light?** Default: whatever the app itself defaults to. Only asked
when the app supports both.

**S3. Voice, language and tone.** Voice id from the environment; language
defaults to English; tone is calm explainer (default) or energetic launch.

**S4. What must never appear, on screen or in narration?** Unreleased features,
customer names, competitor names, pricing, roadmap, internal hostnames. Becomes
`neverShow` in the config, and it is enforced rather than remembered: the
on-screen scan fails the build at every profile on a hit.

**S5. Closing call to action, and any disclaimer that must appear.**

**S6. One video or a series?** If a series: the title convention, where the
catalogue lives, and whether videos must stay visually continuous.

**S7. Slide voice.** Three sliders, asked once, that govern every slide.

| | Options | Default |
|---|---|---|
| Density | sparse / balanced / dense | balanced |
| Depth | conceptual (no identifiers) / technical (real names, protocols, paths) | technical |
| Motion | still / paced (beats follow the voice) / animated (flows travel) | paced |

These are tokens of COMPOSITION, not layout. Which block a slide uses is decided
per slide, shown at Gate 2 and previewed at Gate 2.5. **The user never has to
name a block.**

**S8. Is there a reference?** An existing slide, deck or image to match. If
given, read it and map it onto the block vocabulary rather than reproducing it
pixel for pixel. Most projects have none.

## Tier 2: per video, kept short

**P1. Slide-led or demo-led?** Default demo-led with two or three concept slides.
Only asked when the brief is conceptual rather than a feature.

**P2. A specific path you want walked, or shall I choose one?** Default: you
propose, the user edits.

**P3. Does the app need to be in a particular state first?** Seeded data, a scan
already run, a specific record open. Becomes `preflight` and `prep`.

## Never asked: discovered

Asking for any of these is a defect in this contract:

routes and page titles · primary interactive elements per page · the app's
palette, font stack, spacing and radii · the presence of a cookie banner or an
onboarding modal · the app's own busy or spinner selector · the framework ·
existing storyboards to match style against · the live value behind any factual
claim the narration makes · the app's own README and docs for the concept
explanations

## Never asked: defaulted, then echoed at Gate 1

1920x1080 at 30fps · showcase quality profile · captions as `.vtt` and `.srt`
sidecars, never burned in · intro and outro cards · a 180 ms beat lead · a 400 ms
tail pad · English viewer UI · **publishing disabled**

## The target first conversation

```text
User    make a video about the attack surface graph
Agent   (the blocking five, as one block)
User    (answers)
Agent   Resolved: project `test` at localhost:3000, saved-state auth.
        Extracted palette: bg #0b0a10, accent #f59e0b, database #a78bfa,
        font Poppins. Demo-led, 8 scenes, ~4 min, dark, calm explainer.
        Never showing: real hostnames, customer names.
        Assuming 1920x1080, showcase, publishing off. Correct anything.
User    good, but make it 3 minutes
Agent   (outline: 6 scenes, one narration line each, slide modes named)
User    approved
Agent   (slide previews, one PNG each)
User    slide 2 should be a flow, not bullets
Agent   (revised preview) ... (build, check, deliver)
        21/21 showcase, 0 errors. 6 scenes verified against narration.
        Frames, thumbnail and description below. NOT published.
```

Two user decisions before work starts, one correction, one approval. That is the
benchmark this contract is written against.
