// The slide checks (L13), applied identically to both authoring modes (L18).
//
// Every one of these measures the RENDERED result, never the source. That is the
// plan's own thesis applied consistently: principle 1 is that an artifact nobody
// measured is not delivered, not that an author must be constrained. Freedom of
// input plus measurement of output is what lets a slide be hand-authored HTML
// and still be trustworthy.
//
// These catch the failures that are invisible in a build log. Seventeen of
// twenty slides rendered in a fallback typeface for months, and nobody noticed,
// because nothing measured it.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { THRESHOLDS, VIDEO } from '../config.ts';
import { slidePaths } from '../paths.ts';
import { type Diagnostic, diag } from '../diagnostics.ts';
import { analyseGeometry, projectedTextPx, requiredSourceTextPx, type GeometryIssue } from './geometry.ts';
import { compareImages } from './imagediff.ts';
import type { RenderedSlide } from './render.ts';

const EMBEDDED_FACE = 'Poppins';

function parseColor(css: string): [number, number, number] | null {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const [r, g, b] = m[1].split(',').map((s) => parseFloat(s));
  if ([r, g, b].some((n) => !Number.isFinite(n))) return null;
  return [r, g, b];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(fg: string, bg: string): number | null {
  const a = parseColor(fg);
  const b = parseColor(bg);
  if (!a || !b) return null;
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export interface SlideCheckOptions {
  rendered: RenderedSlide[];
  /** Beats declared per slide id, so a slide can be told it declared some. */
  declaredBeats?: Record<string, number>;
  wordCeiling?: number;
  /**
   * Width of the VIDEO frame the slide ends up in.
   *
   * Not the slide body's own width: the body is inset inside the frame and
   * measures about 1728 of the 1920, so projecting against it flatters the
   * result by eleven percent and quietly contradicts the authored floor the
   * slide contract documents.
   */
  frameWidth?: number;
}

export function checkSlides(opts: SlideCheckOptions): Diagnostic[] {
  const out: Diagnostic[] = [];
  const ceiling = opts.wordCeiling ?? THRESHOLDS.slideWordCeiling;
  const frameWidth = opts.frameWidth ?? VIDEO.width;

  for (const r of opts.rendered) {
    const m = r.measurement;
    if (!m) {
      out.push(diag('slide/source-drift', 'error', `slide "${r.id}" could not be measured`, { slide: r.id }, {},
        ['run `rushes slides build` first', 'check the deck opens in a browser']));
      continue;
    }

    // F18, the one that would have been caught on day one.
    const fallbacks = m.fonts.filter((f) => f && f !== EMBEDDED_FACE);
    if (fallbacks.length) {
      out.push(diag('slide/font-fallback', 'error',
        `slide "${r.id}" rendered in ${fallbacks.join(', ')} instead of the embedded ${EMBEDDED_FACE}`,
        { slide: r.id }, { resolved: m.fonts },
        ['use font-family: var(--font)', 'remove the font-family declaration and inherit the deck face']));
    }

    for (const t of m.tooSmall) {
      out.push(diag('slide/font-too-small', 'error',
        `slide "${r.id}" renders ${t.size}px text, below the ${THRESHOLDS.slideMinFontPx}px floor`,
        { slide: r.id, tag: t.tag }, { size: t.size, text: t.text },
        ['raise the size to at least var(--type-floor)', 'cut the text so a larger size fits']));
    }

    for (const o of m.overflow) {
      out.push(diag('slide/text-overflow', 'error',
        `slide "${r.id}" has content wider than its box (${o.scrollWidth} > ${o.clientWidth})`,
        { slide: r.id, tag: o.tag }, o,
        ['shorten the label', 'split the slide', 'choose a block with fewer columns']));
    }

    for (const o of m.outside) {
      out.push(diag('slide/outside-safe-area', 'error',
        `slide "${r.id}" has an element outside the 1920x1080 frame`,
        { slide: r.id, tag: o.tag }, o,
        ['cut an item', 'split the slide', 'choose a different block']));
    }

    for (const c of m.contrast) {
      const ratio = contrastRatio(c.fg, c.bg);
      if (ratio !== null && ratio < THRESHOLDS.slideContrastRatio) {
        out.push(diag('slide/low-contrast', 'warning',
          `slide "${r.id}" has text at ${ratio.toFixed(2)}:1, below ${THRESHOLDS.slideContrastRatio}:1`,
          { slide: r.id }, { fg: c.fg, bg: c.bg, text: c.text },
          ['use var(--fg) instead of a faint tint', 'darken the surface behind it']));
      }
    }

    if (m.unmeasurable.length) {
      out.push(diag('slide/anchor-unmeasurable', 'error',
        `slide "${r.id}" has ${m.unmeasurable.length} connector anchor(s) with no box after layout`,
        { slide: r.id }, { anchors: m.unmeasurable },
        ['give the item an "id" that matches the connector', 'remove the connector']));
    }

    // The connectors. Until this existed the slide half measured text with real
    // care and measured nothing at all about the arrows, so a route could run
    // straight through an unrelated box and every check stayed green.
    if (m.geometry) {
      for (const issue of analyseGeometry(m.geometry, {
        nodeGapPx: THRESHOLDS.slideRouteNodeGapPx,
        corridorGapPx: THRESHOLDS.slideCorridorGapPx,
        corridorMinPx: THRESHOLDS.slideCorridorMinPx,
      })) {
        out.push(geometryDiagnostic(r.id, issue));
      }
    }

    // What a viewer actually sees, which is the only size that matters.
    if (typeof m.minTextPx === 'number' && Number.isFinite(m.minTextPx)) {
      const projected = projectedTextPx(m.minTextPx, frameWidth, THRESHOLDS.slideViewingWidthPx);
      if (projected < THRESHOLDS.slideProjectedMinPx) {
        const required = requiredSourceTextPx(frameWidth, THRESHOLDS.slideViewingWidthPx, THRESHOLDS.slideProjectedMinPx);
        out.push(diag('slide/text-projected-too-small', 'warning',
          `slide "${r.id}" has ${m.minTextPx}px text, which arrives as ${projected.toFixed(1)}px in a ${THRESHOLDS.slideViewingWidthPx}px player`,
          { slide: r.id },
          { sourcePx: m.minTextPx, projectedPx: Number(projected.toFixed(1)), viewingWidthPx: THRESHOLDS.slideViewingWidthPx, requiredSourcePx: required },
          [`raise the smallest text to ${required}px`,
           'move the detail into the narration so the slide needs less type',
           'split the slide so the remaining text can be larger']));
      }
    }

    if (m.words > ceiling) {
      // Advisory on purpose: the voice should carry the story, and a dense slide
      // is a judgement call, not a defect.
      out.push(diag('slide/word-count', 'warning',
        `slide "${r.id}" carries ${m.words} words, over the ${ceiling} ceiling`,
        { slide: r.id }, { words: m.words, ceiling },
        ['move the detail into the narration', 'split the slide']));
    }
  }
  return out;
}

/** Diagnostic codes for each composition failure, and what repairs each. */
const GEOMETRY_CODES: Record<GeometryIssue['kind'], { code: string; severity: 'error' | 'warning'; fixes: string[] }> = {
  // A route through a box the source never connected states a relationship
  // nobody authored. Archify calls this a hard failure at every profile.
  'edge-through-node': {
    code: 'slide/edge-through-node', severity: 'error',
    fixes: ['reorder the items so the two connected boxes are adjacent',
            'choose a block whose topology carries this relationship (hub, sequence)',
            'split the slide so the route no longer spans the whole row'],
  },
  'route-crossing': {
    code: 'slide/route-crossing', severity: 'warning',
    fixes: ['reorder the items so the routes do not have to swap sides',
            'choose a block whose topology carries both relationships',
            'split the slide in two'],
  },
  'route-corridor': {
    code: 'slide/route-corridor', severity: 'warning',
    fixes: ['reorder the items so the two routes separate',
            'give one of the two relationships a different block'],
  },
  // A label is semantic data. Every repair below moves or shortens it; none
  // deletes it, because deleting meaning is not a geometry repair.
  'label-node': {
    code: 'slide/label-clearance', severity: 'warning',
    fixes: ['shorten the label while keeping its meaning', 'cut an item so the layout has room'],
  },
  'label-route': {
    code: 'slide/label-clearance', severity: 'warning',
    fixes: ['shorten the label while keeping its meaning', 'reorder the items so the routes separate'],
  },
  'label-label': {
    code: 'slide/label-clearance', severity: 'warning',
    fixes: ['shorten one of the two labels while keeping its meaning',
            'split the slide so both relationships have room'],
  },
};

function geometryDiagnostic(slideId: string, issue: GeometryIssue): Diagnostic {
  const spec = GEOMETRY_CODES[issue.kind];
  return diag(spec.code, spec.severity, `slide "${slideId}": ${issue.message}`,
    { slide: slideId, kind: issue.kind }, issue.evidence, spec.fixes);
}

/**
 * L14: a checked-in reference frame per slide, compared perceptually.
 *
 * This used to be a byte compare, which sounds strict and is not: one re-encoded
 * pixel or a font-hinting difference between two machines flipped it, and a
 * check that cries wolf every run is a check nobody reads.
 */
export async function checkGoldens(rendered: RenderedSlide[]): Promise<Diagnostic[]> {
  const dir = slidePaths().golden;
  const pairs = rendered
    .filter((r) => r.png && existsSync(join(dir, `${r.id}.png`)))
    .map((r) => ({ id: r.id, a: join(dir, `${r.id}.png`), b: r.png! }));
  if (!pairs.length) return []; // nothing pinned yet

  const out: Diagnostic[] = [];
  const diffs = await compareImages(pairs, THRESHOLDS.slideGoldenChannelTolerance);
  for (const pair of pairs) {
    const d = diffs.get(pair.id);
    if (!d) continue;
    if (d.error) {
      // An unreadable golden is a failed comparison, never a silent pass.
      out.push(diag('slide/golden-mismatch', 'warning',
        `slide "${pair.id}" could not be compared to its golden frame: ${d.error}`,
        { slide: pair.id }, { golden: pair.a, rendered: pair.b },
        ['re-pin with `rushes slides build --update-golden`', 'check the golden file is a readable PNG']));
      continue;
    }
    if (d.sizeMismatch || d.ratio > THRESHOLDS.slideGoldenPixelRatio) {
      out.push(diag('slide/golden-mismatch', 'warning',
        d.sizeMismatch
          ? `slide "${pair.id}" no longer matches the size of its golden frame`
          : `slide "${pair.id}" differs from its golden frame in ${(d.ratio * 100).toFixed(2)}% of pixels`,
        { slide: pair.id },
        { golden: pair.a, rendered: pair.b, ratio: Number(d.ratio.toFixed(5)), threshold: THRESHOLDS.slideGoldenPixelRatio, sizeMismatch: d.sizeMismatch },
        ['review the change and re-pin with `rushes slides build --update-golden`',
         'revert the CSS change that caused it']));
    }
  }
  return out;
}
