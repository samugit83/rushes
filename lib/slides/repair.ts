// Proven repairs.
//
// `supportedFixes` is the field the whole repair loop turns on: an agent picks
// from it and never invents a value. That only works if the entries are true.
// Ours were hand-written prose, so "choose a different block" was a hope, not a
// fact, and an agent could spend three rounds discovering that every suggestion
// made things worse.
//
// This is archify's `acceptsFix` applied to slides. For each diagnostic it
// builds candidate edits, applies each to a CLONE of the sources, compiles a
// scratch deck, re-renders only the affected slide, and keeps the candidate only
// if the diagnostic it was meant to fix is gone and no new error appeared. What
// survives is a list of edits that were tried and worked.
//
// Two properties fall out. A fix that cannot be proven is not offered, and the
// loop converges because every round starts from a verified move rather than a
// guess.
//
// The cost is one compile plus one slide render per candidate, which is why it
// runs during `slides check` (where an author is iterating) and not during
// `deliver` (whose job is to refuse, not to repair).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectConfig } from '../projectConfig.ts';
import type { Diagnostic } from '../diagnostics.ts';
import { compileDeck } from './compile.ts';
import { openRenderer, type SlideRenderer } from './render.ts';
import { checkSlides } from './check.ts';
import { CAPACITY, type BlockKind, type SlideSource } from './types.ts';
import { itemCount } from './blocks.ts';

/** Codes whose cause is the slide's composition, so a re-render can settle them. */
const REPAIRABLE = new Set([
  'slide/block-over-capacity',
  'slide/text-overflow',
  'slide/outside-safe-area',
  'slide/font-too-small',
  'slide/text-projected-too-small',
  'slide/edge-through-node',
  'slide/route-crossing',
  'slide/route-corridor',
  'slide/label-clearance',
  'slide/word-count',
]);

/**
 * How many candidate edits any one SLIDE is allowed to cost, across all of its
 * diagnostics together.
 *
 * It was a per-code budget, which is not a budget: a slide with five findings
 * authorised five budgets, and at roughly two seconds a render that turns a
 * check into a coffee break.
 */
export const CANDIDATE_BUDGET = 10;

/** The share of the slide budget one diagnostic code may spend. */
export function candidateBudgetFor(codeCount: number): number {
  return Math.max(1, Math.floor(CANDIDATE_BUDGET / Math.max(1, codeCount)));
}

interface Candidate {
  /** What an author would type, in the same voice as the other fixes. */
  describe: string;
  apply(slide: SlideSource): void;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function slideIdOf(d: Diagnostic): string | null {
  const id = d.subject.slide;
  return typeof id === 'string' ? id : null;
}

/** Every block that could hold this slide's items, nearest capacity first. */
function alternativeBlocks(slide: SlideSource): BlockKind[] {
  const count = itemCount(slide);
  const current = slide.block as BlockKind;
  return (Object.keys(CAPACITY) as BlockKind[])
    .filter((b) => b !== current && CAPACITY[b] >= count)
    .sort((a, b) => CAPACITY[a] - CAPACITY[b]);
}

/**
 * The candidate edits worth trying for one slide.
 *
 * Note what is NOT here: nothing proposes deleting a connector or a label
 * outright. A label is semantic data, and archify's rule is the right one: a
 * diagnostic may propose shortening wording when the wording is what does not
 * fit, and may never propose deleting meaning as a geometry repair. Shortening
 * is offered as a proven length, so an author knows what actually fits before
 * they rewrite anything.
 */
function candidatesFor(slide: SlideSource, codes: Set<string>, budget = CANDIDATE_BUDGET): Candidate[] {
  const out: Candidate[] = [];
  if ((slide.mode ?? 'composed') !== 'composed') return out;

  const wantsRoom = ['slide/block-over-capacity', 'slide/text-overflow', 'slide/outside-safe-area',
    'slide/font-too-small', 'slide/text-projected-too-small', 'slide/word-count'].some((c) => codes.has(c));
  const wantsRouting = ['slide/edge-through-node', 'slide/route-crossing', 'slide/route-corridor',
    'slide/label-clearance'].some((c) => codes.has(c));

  if (wantsRoom || wantsRouting) {
    for (const block of alternativeBlocks(slide)) {
      out.push({
        describe: `set block to "${block}"`,
        apply: (s) => { s.block = block; },
      });
    }
  }

  const items = slide.items ?? [];
  if (wantsRoom && items.length > 1) {
    const last = items[items.length - 1];
    out.push({
      describe: `cut the item "${last.label ?? last.id ?? 'the last one'}"`,
      apply: (s) => { s.items = (s.items ?? []).slice(0, -1); },
    });
  }

  // A route through an unrelated box is usually one relationship spanning the
  // whole row. Moving the far endpoint next to its partner is the edit that
  // actually fixes it, so try it rather than describing it.
  if (wantsRouting && items.length > 2) {
    for (const connector of (slide.connectors ?? []).slice(0, 3)) {
      const ids = items.map((it, i) => it.id ?? `item-${i + 1}`);
      const fromIndex = ids.indexOf(connector.from);
      const toIndex = ids.indexOf(connector.to);
      if (fromIndex < 0 || toIndex < 0 || Math.abs(fromIndex - toIndex) <= 1) continue;
      out.push({
        describe: `move item "${connector.to}" next to "${connector.from}"`,
        apply: (s) => { s.items = moveAdjacent(s.items ?? [], fromIndex, toIndex); },
      });
    }
  }

  if (codes.has('slide/label-clearance')) {
    for (const [index, connector] of (slide.connectors ?? []).entries()) {
      const label = connector.label;
      if (!label || label.length <= 8) continue;
      const shortened = `${label.slice(0, Math.max(6, Math.floor(label.length / 2)))}`.trimEnd();
      out.push({
        describe: `shorten the label "${label}" to about ${shortened.length} characters, keeping its meaning`,
        apply: (s) => {
          const c = (s.connectors ?? [])[index];
          if (c) c.label = shortened;
        },
      });
    }
  }

  return out.slice(0, budget);
}

/**
 * Move the item at `toIndex` so it sits beside the item at `fromIndex`.
 *
 * Exported because the honesty of the whole loop depends on it: the fix we
 * DESCRIBE has to be the edit we VERIFIED, and an off-by-one here would have us
 * telling an author to move one item while having proven a different move.
 */
export function moveAdjacent<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  const list = [...items];
  const target = fromIndex + (toIndex > fromIndex ? 1 : -1);
  const [moved] = list.splice(toIndex, 1);
  list.splice(target, 0, moved);
  return list;
}

interface Attempt {
  renderer: SlideRenderer;
  scratchDir: string;
  config: ProjectConfig;
  sources: SlideSource[];
  /** Bumped per candidate so no two candidates ever share a deck URL. */
  serial: number;
}

/** Does this edit actually clear the codes it was meant to, without new errors? */
async function accepts(
  attempt: Attempt,
  slideId: string,
  candidate: Candidate,
  targetCodes: Set<string>,
  baselineCodes: Set<string>,
): Promise<boolean> {
  const sources = clone(attempt.sources);
  const slide = sources.find((s) => s.id === slideId);
  if (!slide) return false;
  try {
    candidate.apply(slide);
  } catch {
    return false;
  }

  // A fresh path per candidate. The renderer reloads a repeated URL anyway, but
  // a unique URL removes the whole class of "measured the previous candidate"
  // rather than relying on one guard to hold.
  const deckPath = join(attempt.scratchDir, `candidate-${attempt.serial++}.html`);
  const compiled = compileDeck({ config: attempt.config, sources, outPath: deckPath });
  // A candidate that will not even compile is not a fix.
  if (compiled.diagnostics.some((d) => d.severity === 'error' && d.subject.slide === slideId)) return false;

  const rendered = await attempt.renderer.render({ slides: [slide], deckPath, measureOnly: true });
  // BOTH halves of the verdict. Re-running only the rendered checks meant the
  // compile-time lint was invisible, so a candidate could earn a brand new
  // source-level warning and still be offered as verified.
  const after = [...compiled.diagnostics, ...checkSlides({ rendered })];
  const afterCodes = new Set(after.filter((d) => d.subject.slide === slideId).map((d) => d.code));

  for (const code of targetCodes) if (afterCodes.has(code)) return false;
  // Trading one defect for another is not a repair, and that holds for warnings
  // too. Checking only errors let the loop verify "set block to badge-list",
  // which cleared a label collision by moving to a block with no topology and
  // silently earned a mode-mismatch instead. A fix offered as verified has to
  // leave the slide no worse by any measure the checker takes.
  for (const d of after) {
    if (d.subject.slide !== slideId) continue;
    if (!baselineCodes.has(d.code)) return false;
  }
  return true;
}

export interface VerifyOptions {
  config: ProjectConfig;
  sources: SlideSource[];
  diagnostics: Diagnostic[];
}

/**
 * Replace the guessed fixes with proven ones, in place, and return the same
 * list. A diagnostic whose fixes could not be proven keeps its editorial advice
 * and says so, rather than pretending the advice was tested.
 */
export async function verifyFixes(opts: VerifyOptions): Promise<Diagnostic[]> {
  const repairable = opts.diagnostics.filter((d) => REPAIRABLE.has(d.code) && slideIdOf(d));
  if (!repairable.length) return opts.diagnostics;

  const bySlide = new Map<string, Diagnostic[]>();
  for (const d of repairable) {
    const id = slideIdOf(d)!;
    if (!bySlide.has(id)) bySlide.set(id, []);
    bySlide.get(id)!.push(d);
  }

  const scratchDir = mkdtempSync(join(tmpdir(), 'rushes-repair-'));
  const renderer = await openRenderer();
  const attempt: Attempt = { renderer, scratchDir, config: opts.config, sources: opts.sources, serial: 0 };

  try {
    for (const [slideId, diagnostics] of bySlide) {
      const slide = opts.sources.find((s) => s.id === slideId);
      if (!slide) continue;
      // Every code the slide already carries, at any severity: a candidate may
      // leave these standing, but may not add one.
      const baselineCodes = new Set(
        opts.diagnostics.filter((d) => d.subject.slide === slideId).map((d) => d.code));

      // Verified PER CODE, not per slide. A slide with two unrelated defects
      // would otherwise prove nothing, because no single edit clears both, and
      // "we found nothing" would be reported where "this clears the overflow"
      // was true.
      const codes = [...new Set(diagnostics.map((d) => d.code))];
      const provenByCode = new Map<string, string[]>();
      const tried = new Map<string, boolean>();
      const perCode = candidateBudgetFor(codes.length);

      for (const code of codes) {
        const target = new Set([code]);
        const proven: string[] = [];
        for (const candidate of candidatesFor(slide, target, perCode)) {
          const key = `${code}::${candidate.describe}`;
          let ok = tried.get(key);
          if (ok === undefined) {
            ok = await accepts(attempt, slideId, candidate, target, baselineCodes);
            tried.set(key, ok);
          }
          if (ok) proven.push(`${candidate.describe} (verified by re-render)`);
        }
        provenByCode.set(code, proven);
      }

      for (const d of diagnostics) {
        const proven = provenByCode.get(d.code) ?? [];
        d.supportedFixes = [...proven, ...d.supportedFixes.map((f) => `${f} (not verified)`)];
      }
    }
  } finally {
    await renderer.close();
    rmSync(scratchDir, { recursive: true, force: true });
  }

  return opts.diagnostics;
}
