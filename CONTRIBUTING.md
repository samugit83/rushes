# Contributing

```bash
npm install
npm run type-check      # tsc --noEmit, strict
npm test                # unit, timing, conformance, neutrality
```

There is no build step. Node strips the types in `lib/*.ts` at load, so there is
no compiled artifact to keep in sync with the source.

## Three things that are not negotiable

**The engine knows nothing about the app it films.** Every application-specific
fact lives in `rushes.config.json` or in a storyboard, never in `lib/`. The test
is literal: `test/neutrality.test.mjs` greps the engine for product identifiers
and fails on a hit. If you find yourself wanting an `if (isNextJs)`, portability
has become a claim rather than a property.

**Readiness is measured, never waited out.** Every fixed `waitForTimeout` that
stands in for "the app is probably ready by now" is a bug on some other
framework. Add a condition to `settle()` instead.

**A check fails closed.** If you want a new check to degrade to a warning, add it
to `DEGRADABLE` in `lib/check/registry.ts` explicitly and say why in the commit.
The unit suite fails if anything degrades without being on that list.

## Adding an auth strategy

1. Implement `AuthStrategy` in `lib/auth/index.ts`: one `apply(context, config)`.
2. Return `contextCredentials` if it sets anything context-wide — that is what
   the origin boundary strips, and getting it wrong leaks a bearer token to a
   third party.
3. Add its shape to `schemas/config.schema.json`.
4. Add a case to `test/conformance.test.mjs` with a fixture that exercises it.
5. Document it in `references/config-contract.md`, in the ladder, in the position
   that reflects how many readers need it.

## Adding a step kind

1. Add it to `StepKind` in `lib/types.ts` and to the schema's enum.
2. Add its argument rule to `STEP_ARGS` in `lib/storyboard.ts` — what it
   requires, what it forbids. A step that silently ignores an argument is the
   defect this table exists to prevent.
3. Implement it in `lib/engine/actions.ts`.
4. Document it in `SKILL.md` section 4 and in the authoring contract.

## Adding a slide block

1. Add it to `BlockKind` and `CAPACITY` in `lib/slides/types.ts`. **A block
   without a declared capacity is not finished**: capacity is what stands in for
   a layout solver.
2. Add a case to `renderBlock` in `lib/slides/blocks.ts`. Every addressable
   element carries `data-node="<item id>"`; that attribute is the entire contract
   with the beat API.
3. Add its CSS to `slides/runtime/blocks.css`. Grid or flex, arrangement derived
   from the item count. **No coordinates.**
4. Add it to the table in `references/slide-contract.md`.

If a slide needs a block that does not exist, that is a request to add a block —
not a licence to write bespoke CSS for the composed path. Authored mode already
exists for the cases where no block should be bent.

## Style

Comment the WHY, not the what. A comment earns its place by saying something the
code cannot: why a value is what it is, a footgun, an ordering constraint, the
provenance of a magic constant. Delete comments that restate the line below them.
No changelog narration in the source — git remembers.
