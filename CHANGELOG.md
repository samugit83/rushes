# Changelog

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
