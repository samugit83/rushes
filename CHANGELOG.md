# Changelog

## 1.0.10

A scene now opens on its own picture.

- **Fixed: the opening navigation ran inside the scene's own window.** A scene
  stamped its start and THEN navigated, so the page load played under the
  incoming narration: a slide scene showed the live app for the second or two
  the deck took to load, and the top of the video showed the boot page. The
  opening `goto`/`slide` is now hoisted off the scene clock, and scene 0's off
  the master clock, so the picture is the scene's own from the first word. The
  transition costs a beat of silence held on the outgoing frame, which reads as
  an edit.
- **New check `scene_opens_on_its_slide`.** Measures the DELIVERED frame at each
  slide scene's start against that slide's own render, coarsely enough that
  animation and the cursor cannot fail an honest frame. An error at every
  profile: nothing else in the check set looks at whether the right picture is
  on screen.

## 1.0.9

Tier 3: genuinely complex, organised, multi-layer diagrams.

- **New `layers` block.** A diagram of titled horizontal lanes — each lane a
  layer and a group — with a row of nodes per lane and connectors flowing
  between any of them. It is the organised, multi-layer picture the single-row
  and hub blocks could not express.
- **Orthogonal connector routing for lanes.** A cross-lane connector travels in
  the empty gap BETWEEN lanes with right angles, so it never cuts through a box;
  a curve would. Same-lane connectors stay straight.
- **Enforced, not hoped:** a within-lane connector must join adjacent nodes and
  a cross-lane one should go to the adjacent lane — the edge-through-node check
  flags a skip either way. Whole-slide capacity is 18 nodes across all lanes.

## 1.0.9

Genuinely complex, organized diagrams.

- **New `layers` block (Tier 3): lanes.** A slide can now be a stack of titled
  horizontal lanes, each a layer/group holding a row of nodes, with connectors
  that flow between any of them and route **orthogonally through the lane gaps**
  so a cross-lane edge never cuts through a box. This is the multi-layer,
  organized diagram the block vocabulary could not express before. Same
  no-coordinates rule: geometry is (lane, order). Cap is 18 nodes per slide.
- **Higher caps on the existing blocks.** flow-row/hub/sequence 8 -> 10,
  bullets/stack 6 -> 8, compare/store/metric 3 -> 4, badge-list 12 -> 14, with
  the layout CSS to hold them. The glance rule still applies; the checker still
  refuses a slide that overflows or crowds.

## 1.0.8

You can now see a slide's motion before recording, and the motion is bolder.

- **`slides preview` produces a gif for every animated slide.** A still can't
  show flowing edges or a beat pulse, so a reviewer approved a design without
  ever seeing it move — the same blind spot that let a frozen video ship. The
  preview now captures the living slide (no `data-still`, exactly as the recorder
  films it) as a short gif, and the contact sheet plays it. Static slides get no
  gif — a gif of a still is just a heavier still. `--no-gif` skips it; a missing
  ffmpeg degrades to "no gif", never a false pass.
- **Stronger diagram style.** The box glow, gradient and border were dialled up
  so the depth and the semantic colour read at a glance instead of being barely
  perceptible; connector glow is brighter too.

## 1.0.7

The freeze-dead-air optimisation was freezing the diagrams, making a slide sit
as a static image for its whole scene.

- **Fix: a slide scene is never frozen.** A slide's only action is loading it
  (~0.1s); its beats fire during the narration hold, AFTER that point, and the
  composed edges flow continuously. The mux froze the frame at the load moment,
  so it recorded every beat and edge animation and then threw them away — the
  diagram, and now the glow/flow/pulse, played to a discarded buffer while the
  finished video showed a still. Slides animate through their whole scene now;
  only genuinely static live holds are frozen.

## 1.0.6

A deep review of 1.0.5 found that the new motion moved boxes, which detaches
connectors.

- **Fix: motion is opacity and glow only, never geometry.** The 1.0.5 entrance
  animation translated every node up by 10px, but connectors are measured once
  at the settled position and never redrawn while a scene holds — so every arrow
  in every diagram pointed 10px off for the whole recorded scene. The still and
  the golden hid it, because they freeze to the settled frame. The entrance is
  now a pure fade, and the beat focus/pulse effects glow without scaling, so no
  box ever moves out from under its arrows. A source-level test forbids a
  transform on any node-state or entrance effect so it cannot come back.

## 1.0.5

Composed diagrams look and move like a finished product, without giving up the
determinism the checks depend on.

- **Style**: every box now carries a tone-tinted gradient, a hairline tone
  border and a soft coloured glow keyed to its own tone; connectors carry a
  matching glow. This is most of the "premium" look, at no render cost.
- **Motion** (filmed, because a slide is a live page the recorder captures): a
  signal flows along every connector, a beat makes the named node pulse and
  glow, and nodes fade up as a scene becomes active.
- **The determinism split**: the preview and the golden still set `data-still`
  on the root, which freezes every looping and entrance animation to its settled
  final frame — so the checks stay stable and the frame you approve is the
  settled look. The recorder never sets it, so the filmed slide is fully alive.
  The geometry checks read path coordinates, never the visual dash, so animation
  never affects them.

## 1.0.4

Keeps rushes from scattering project files across a directory that was never
meant to be a rushes project.

- **A project command run with no `--project`, from inside an existing
  repository (a directory with a `.git`), now refuses** instead of turning that
  repo into a rushes project and raining `rushes.config.json`, `demos/`,
  `slides/` and `out/` across it. The refusal names a dedicated
  `~/rushes-projects/<name>` folder and the `--project` flag. An explicit
  `--project` or `RUSHES_PROJECT_ROOT` is the override, and a plain empty
  directory still works as before.
- **`init` now creates the project folder if it does not exist**, so
  `rushes init --project ~/rushes-projects/my-app` works in one step.

## 1.0.3

- **Hub diagrams no longer cramp their vertical satellites.** On a wide 16:9
  frame the hub gave its left/right satellites far more reach than its top/bottom
  ones, so a five-node hub (one centre, four around it) squeezed the north and
  south boxes against the centre while the east/west boxes floated free. The
  reach is rebalanced so all four sit clear of the centre with room for their
  connectors.

## 1.0.2

The 1.0.1 README was wrong in two ways, both found by installing from a clean
machine and reading what actually happened rather than what was intended.

- **The documented install was not global.** `--all` is shorthand for
  `--skill '*' --agent '*' -y` and says nothing about scope, so the command
  installed project-level and wrote `.agents/`, `agent/`, `skills-lock.json` and
  a symlink into whatever repository you happened to be standing in. It is now
  `-g --all -y`.
- **The README kept promising a `rushes` binary.** There is none on this path,
  and there cannot be one via npm: Node refuses to strip types under
  `node_modules/`, so `npm install -g` produces a command that dies with
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. Step 1 now defines a one-line
  alias, which makes every later `rushes ...` in the README literally true, and
  says why an npm install cannot work.

## 1.0.1

Installing the skill did not produce a skill that could run. Found by installing
it from a clean machine and following the README, which is the only way this
class of defect ever shows up.

- **The skill installs its own dependencies on first run.** `npx skills add`
  copies files and runs no package manager, so the first command died on
  `Cannot find package 'ajv'`. The entry point now installs them once, into its
  own directory, unprivileged, and prints the one manual command if it cannot.
- **`SKILL.md` no longer assumes a `rushes` binary on the PATH.** A skill
  installed this way has no command; the agent runs `node bin/rushes.mjs` from
  the skill's own directory, and the setup section says so.
- **The documented install is non-interactive.** `npx skills add
  samugit83/rushes --all -y` answers the agent-selection prompts instead of
  stopping to ask.

## 1.0.0

The first release, and a substantial rewrite of a private tool into a
framework-agnostic, installable skill.

### The correctness gate

- Step failures are no longer swallowed. Each one screenshots the moment it
  happened, collects the visible alternatives by edit distance, and becomes a
  structured diagnostic with enumerated fixes.
- Scenes declare `expect`: what must be on screen when the scene ends.
- `check` measures the produced file and its sidecars against a registry of
  named checks, at one of two quality profiles.
- Delivery is atomic, from a frozen storyboard snapshot, into a staging
  directory beside the target. A failed run never touches the last good artifact.
- Publishing refuses without a passing receipt whose hashes still match the
  bytes on disk.

### Evidence

- `rehearse` runs two silent passes and records only if they agree.
- `evidence` extracts keyframes from the DELIVERED mp4, and asks a vision model
  one closed question per scene.
- Every frame's visible text is scanned for key-shaped strings and for the
  project's never-show list.

### Portability

- `rushes.config.json` describes the filmed application. The engine carries no
  product-specific identifier, and a test enforces it.
- Six auth strategies behind one interface, with `rushes login` for the
  universal one.
- Readiness is measured, not waited out: a static site, a server-rendered page
  and a hydrating SPA all settle through the same predicate.
- A conformance suite covers all three shapes plus an app that never settles.

### The slide system

- Twenty standalone files become one hash-routed deck with one embedded face.
- Two authoring modes: `composed` blocks with connectors measured after layout,
  and `authored` HTML. Both pass the same rendered-output checks.
- Beats anchor to WORDS in the narration, so re-recording re-syncs automatically.
- `slides preview` renders every slide with no voice, no recording and no ffmpeg.

### Security

- Egress classified on the resolved IP, with per-hop redirect checks.
- Credentials stripped at every origin boundary; `file://` confined to the slide
  directory.
- `runner.start` requires an approval recorded against the config's sha256.
- Preference restores are compare-and-set and crash-safe.
- Secrets scrubbed by value from every diagnostic, receipt and log line.
