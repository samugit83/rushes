# How the pieces fit

One page, for someone who has to change something.

```
bin/rushes.mjs            one entry point; every subcommand dispatches from here
lib/
  cli/                    one file per command; nothing else knows about argv
  engine/                 the browser: boot, readiness, steps, navigation, recording
  auth/                   six interchangeable strategies behind one apply()
  runner/                 optionally start the app; consent, memory floor
  compose/                voice, alignment, captions, cards, mux, formats, brand
  check/                  the registry, the checker, the receipt, evidence, vision, rehearsal
  slides/                 compile, render, measure, tokens
  publish/                OPTIONAL; metadata, the gate, the catalogue, the uploader
  platform.ts             the ONLY file that knows which operating system this is
  diagnostics.ts          the structured-failure type and the collector
  secrets.ts              the value scrubber and the on-screen scanner
  egress.ts               resolved-IP classification, ported from a Python original
  projectConfig.ts        rushes.config.json: load, validate, expand ${VAR}
  storyboard.ts           the schema and the cross-field lint
schemas/                  the three JSON schemas, all additionalProperties:false
slides/runtime/           tokens.css, blocks.css, deck.js, the embedded face
references/               five contracts, read one at a time
examples/ test/ benchmark/
```

## The three invariants everything else follows from

**One boot path.** `validate`, `rehearse`, `build` and `deliver` all open the app
through `lib/engine/session.ts`. A validator that boots differently from the
recorder produces the worst kind of green: steps that pass in the check and fail
in the take.

**The voice is the clock.** TTS runs first, each clip is measured, and every
scene is held for at least `audio + tail`. The picture is stretched to the voice,
never the reverse, so narration can never be cut off. Everything downstream —
caption offsets, chapter timestamps, beat firing — derives from that one measured
number.

**Nothing is delivered that was not measured.** The build composes into a staging
directory beside the target, from a frozen snapshot of the storyboard, and the
checker runs against the staged file. Only a pass earns the rename.

## The data flow of one delivery

```
demos/<id>.demo.json ──┐
rushes.config.json ────┼─→ boot() ──→ record() ──→ recording.webm
slides/src/*.json ─────┘                │            timeline.json
                                        │            problems.json
                                        ↓
                        voice clips ──→ mux ──→ .staging-*/​<id>.mp4
                                                     │
                                        runChecks() ─┤
                                                     ↓
                                          pass → rename + receipt.json
                                          fail → discard; the last good file stands
```

## Where a change usually goes

| You want to | Change |
|---|---|
| support a new way of signing in | `lib/auth/index.ts` + the config schema + a conformance case |
| support a new UI action | `lib/types.ts` `StepKind` + `STEP_ARGS` in `lib/storyboard.ts` + `lib/engine/actions.ts` |
| make the engine wait for something new | `settle()` in `lib/engine/readiness.ts` — never a fixed timeout |
| add a slide arrangement | `CAPACITY` in `lib/slides/types.ts` + `renderBlock` + `blocks.css` |
| add a check | `lib/check/registry.ts` (with a severity per profile) + the measurement in `lib/check/index.ts` |
| change what a receipt records | `lib/check/receipt.ts` + `auditableFields` |
| change how a video is cut | `lib/compose/mux.ts` |

## The one file that knows about the operating system

`lib/platform.ts`. Everything else is platform-neutral by construction, and the
only places that are not are the four seams where the code leaves Node for the
OS: finding a binary (`which` does not exist on Windows), spawning a shell (`sh`
does not either), stopping a process TREE (process groups are POSIX-only), and
asking how much memory is available (`os.freemem()` on macOS counts only free
pages and excludes the pools the kernel reclaims on demand, so a 32 GB machine
reports a few hundred megabytes).

Each is answered once, there. `test/run.mjs portability` greps the whole source
for the POSIX-only forms and fails if one escapes that module, and CI runs the
suite on Linux, macOS and Windows so the grep is backed by an execution.

Turning a path into a URL belongs to the same rule: `pathToFileURL`, never
`` `file://${path}` ``, and `fileURLToPath(import.meta.url)`, never
`new URL(import.meta.url).pathname` — which yields `/C:/Users/...` on Windows
and made every skill-relative path unresolvable there.

## The two things that are duplicated on purpose

**The egress rule** is a port of `ip_denylist.py` from the repository this tool
grew in. Behaviour must match, so an operator does not learn two different rules.
When one changes, change both, and say so.

**The JWT minting** exists in the app, in that repository's e2e harness, and here
as a generic strategy. Sharing code with the e2e harness would couple the skill
to a monorepo it must stay independent of. The duplication is the cheaper of the
two costs.
