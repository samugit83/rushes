# The slide contract

A video alternates two registers: designed slides that explain a concept, and the
live application filmed driving itself. This is the first register.

## Two modes, both first class

**`composed`** — the default for anything structural. Diagrams, flows,
sequences, rings, comparisons, anything with connectors. JSON blocks, no CSS, no
coordinates. This is where a diagram belongs, because a diagram's value is that
its geometry is trustworthy.

**`authored`** — full HTML and CSS, written by you. For slides where expression
matters more than structure: a title moment, a statistic reveal, a quote, a
bespoke visual no block should be bent into.

**Choose `composed` when the slide has a topology and `authored` when it does
not. Neither is a fallback for the other.** State the mode at Gate 2 so a wrong
call is caught before anything is built.

## What is enforced, in both modes

Every check measures the RENDERED RESULT, never the source. That is the whole
principle: an artifact nobody measured is not delivered — not that an author must
be constrained.

| Enforced | Severity |
|---|---|
| nothing outside the 1920x1080 safe area | error |
| no rendered text below the 22px floor | error |
| no block whose content is wider than its box | error |
| **no connector through a box it does not connect** | **error at every profile** |
| **no unrelated connectors crossing or sharing a corridor** | **error at showcase** |
| contrast at or above 4.5:1 | error at showcase |
| the computed font is the embedded face, not a fallback | error |
| every declared beat fired before the scene ended | error at showcase |
| no off-origin `src` or `href` | error |
| **text still readable once projected into a video player** | warning |
| **no connector label covering a box, a route or another label** | warning |
| a literal colour where a project token exists | warning |
| a `font-family` outside the project face | warning |
| the same authored structure in two slides | warning: promote it to a block |
| more words than the ceiling | warning |

Seventeen of the twenty slides this system replaces rendered in a fallback
typeface for months, and nobody noticed, because nothing measured it. Under these
checks that is a build error the first time. The connector rows exist for the
same reason: until they did, this half measured text with real care and measured
**nothing at all about the arrows**, so a route could run straight through an
unrelated box and every check stayed green.

### The connectors are measured, not predicted

The deck draws the routes, then samples the stroke it actually drew off the SVG
path and publishes it. Every composition check runs against those samples, so
there is no prediction that can be wrong about the picture.

A route through a box the source never connected states a relationship nobody
authored, which is why it fails at every profile. The commonest way to write one
is a `flow-row` whose connectors skip a box: `a` to `d` in a row of five runs
straight through `b` and `c`. That is not a routing problem to be solved, it is
the wrong block for that topology.

**Route rhythm is deliberately absent.** An orthogonal renderer enforces a
minimum straight-segment length; these routes are curves, which have no segments,
so approximating the check would be inventing a number rather than measuring one.

### Readability is what a viewer sees, not what you authored

A slide is composed in a 1920-wide frame and the 22px floor is measured there. It
is watched inside a video player that is routinely 640px wide, where 22px arrives
as 7px. The projected check assumes that player and asks for 10px there, which
works out to a **30px authored floor**. It is a warning, not an error: it is a
house standard about how the video will be watched, not a defect in the file.

**Never make a check pass by shrinking the type, compressing the spacing, or
hiding the overflow.** A slide with nine boxes is not a layout problem, it is two
slides.

**A label is semantic data, and deleting it is not a geometry repair.** When a
label collides, move it, change the composition, or shorten the wording while
keeping the meaning. No diagnostic here will ever propose dropping one.

### Every offered fix was tried

`rushes slides check` does not guess. For each diagnostic it builds candidate
edits, applies each to a copy of the sources, compiles a scratch deck, re-renders
the affected slide, and keeps a candidate only when the diagnostic it targeted is
gone and no new error appeared. What survives is marked `(verified by re-render)`
and comes first; editorial advice that cannot be machine-checked, such as "split
the slide in two", is marked `(not verified)`.

```text
✗ slide/block-over-capacity  slide "gates" puts 5 items in "compare", whose maximum is 3
    fix: set block to "bullets" (verified by re-render)
    fix: set block to "stack" (verified by re-render)
    fix: split the slide in two (not verified)
```

Pick a verified fix first, and never invent a value. Verification costs a render
per candidate, so it runs during `check`, where you are iterating, and not during
`deliver`, whose job is to refuse rather than to repair. `--no-verify-fixes`
turns it off.

## Composed: the block vocabulary

`title` · `bullets` · `flow-row` · `sequence` · `ring` · `compare` · `stack` ·
`hub` · `store` · `badge-list` · `metric` · `code` · `quote`

```jsonc
{
  "schemaVersion": 1,
  "id": "pipeline",
  "mode": "composed",
  "block": "flow-row",
  "kicker": "HOW IT WORKS",
  "title": "Five stages, one gate",
  "subtitle": "Nothing is delivered that was not measured.",
  "intent": "the shape of the pipeline, with the check as the obvious pinch point",
  "items": [
    { "id": "storyboard", "label": "Storyboard", "detail": "scenes, steps, expects", "tone": "neutral" },
    { "id": "check",      "label": "Check",      "detail": "the finished file",     "tone": "security" }
  ],
  "connectors": [
    { "from": "storyboard", "to": "check", "kind": "write", "label": "the clock", "travel": true }
  ]
}
```

### There are no coordinates, ever

The schema forbids `x`, `y`, `col`, `row`, `via` and every other routing hint,
and that single constraint is what removes the need for a layout solver: there is
nothing to solve, because geometry is a pure function of the block and the number
of items in it.

| Block | Geometry follows from |
|---|---|
| `flow-row` | N boxes in one row, wrapping to a second above 5 |
| `sequence` | participants become columns, messages become rows |
| `ring` | concentric rounded rects, one per ring |
| `compare` | 2 or 3 equal columns |
| `stack` | N full-width rows |
| `hub` | one centre, N satellites at even angles |
| `store` | a cylinder, sized to its label |
| the rest | flow layout, no connectors |

**Connectors are measured after layout, never predicted.** The deck renders the
boxes, reads their real rects, and draws the path between them. A static renderer
has to predict geometry because it has no layout pass; this one runs in a browser
and can simply look. Routing stays trivial because each block constrains
topology — `flow-row` joins adjacent boxes, `hub` joins centre to satellite —
so there is never an obstacle to route around.

**Every block declares a capacity.** Exceeding it, or overflowing the frame, is
`slide/block-over-capacity`, whose supported fixes are: split the slide, choose a
different block, or cut an item. That is deliberately editorial.

### `tone` is a meaning, never a decoration

`neutral` `frontend` `backend` `database` `security` `bus` `external` `accent`
`danger`. Each maps to the project's palette, which `rushes slides tokens`
derives from the running application. So a viewer who watches a concept slide and
the real UI two minutes later sees one language across both halves of the video,
and nobody has to be told it is happening.

## Authored: what you are given

```jsonc
{
  "id": "opening",
  "mode": "authored",
  "kicker": "RUSHES",
  "intent": "one enormous number, everything else recedes",
  "html": "<div class='hero'><div class='count' data-node='count'>0</div></div>",
  "css": ".slide[data-slide=\"opening\"] .hero { display:grid; place-items:center; }"
}
```

The compiler still supplies the frame, the brand block, the safe area, the
preview, the golden screenshot, and the beat wiring through `data-node`. The
project's tokens are available as custom properties — `var(--accent)`,
`var(--surface)`, `var(--fg)`, `var(--type-title)` — so matching the app's
palette costs nothing. Nothing forces their use, and the two warnings exist to
make the divergence visible rather than to forbid it.

Scope your selectors to `.slide[data-slide="<id>"]`, or one slide's `h1` will
restyle another's.

## Beats: anchored to words, not milliseconds

```jsonc
"beats": [
  { "on": "orchestrator", "do": "focus",     "target": "orchestrator" },
  { "on": "broker",       "do": "highlight", "target": "broker" },
  { "on": "throwaway",    "do": "spawn",     "target": "scanner" }
]
```

Declared on the SCENE, not the slide. Each anchor resolves to a timestamp from
the voice's own character alignment, and fires 180 ms early — viewers look, then
listen, and a beat landing exactly on the word reads as late.

Two properties hand-timed animation never has:

1. **Re-recording re-syncs automatically.** A reworded sentence or a different
   voice moves every beat correctly, with no storyboard edit.
2. **A beat that never fired is a diagnostic.** A slide that stalled halfway
   fails the build instead of shipping.

An anchor that appears more than once in the narration needs an `occurrence`
index, or authoring fails. `do` is one of `focus`, `dim`, `highlight`, `spawn`,
`reveal`, `travel`. `travel` targets a connector, not a node.

## Motion, and the two habits that matter

**Dim and focus. Do not reveal from nothing.** Show the whole picture and
spotlight the part being narrated. A viewer who can always see the whole system
never gets lost.

**Accumulate. Do not redraw.** Draw the architecture once and have each slide add
a layer while dimming what came before, rather than redrawing the system from
scratch on every slide and making the viewer re-orient ten times in one video.
This is less authoring, not more, because the geometry is written once — use
`reference` to point at the slide whose composition should be matched.

State transitions are 140-200 ms. Authored story motion may be longer, but it
must be finite, reader-paced, and must never carry meaning that disappears in a
still frame: someone who pauses must still be able to read the picture.

## The workflow

```bash
rushes slides build                    # sources -> one hash-routed deck
rushes slides preview <id>             # every slide as a PNG + a contact sheet
rushes slides check                    # the measured checks + verified repairs
rushes slides build --update-golden    # re-pin the reference frames, deliberately
rushes slides tokens                   # derive the palette from the running app
```

`preview` needs no voice, no recording and no ffmpeg. Seconds, and no spend.
**Show it at Gate 2.5 and let the user direct the design in words, against a
picture.** They say "make slide 2 a flow, not bullets" or "too dense"; you map
words to blocks. A user never names a CSS property and never names a block
unprompted.

## The explicit limitation

Rushes cannot draw a free-form node-and-edge graph with crossing connections and
arbitrary placement. If a diagram genuinely needs one, the answer is the live
application filmed directly — which is the other half of the format, and always
more truthful than a drawing of it.
