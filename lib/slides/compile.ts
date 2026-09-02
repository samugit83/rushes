// Compile slides/src/*.slide.json into ONE hash-routed slides/deck.html.
//
// Twenty standalone files is what this replaces. They shared a byte-identical
// first 600 characters, re-embedded the same logo ten times, and seventeen of
// them asked for a typeface that was not installed and silently fell back to
// whatever the machine happened to have — which nobody noticed, because nothing
// measured it.
//
// One deck fixes all of that at once, and unlocks the three things the slide
// half actually needed: shared-element morphing between slides, state that
// persists so a later slide can add a layer instead of redrawing the system, and
// a crossfade instead of a hard cut.
//
// The compiled deck is a BUILD ARTIFACT. The source of truth is
// slides/src/*.slide.json.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Ajv } from 'ajv';
import { SKILL_ROOT } from '../env.ts';
import { slidePaths, projectRoot } from '../paths.ts';
import { type Diagnostic, diag } from '../diagnostics.ts';
import { formatAjvErrors, type ProjectConfig } from '../projectConfig.ts';
import { resolveBrand, embeddedFontCss } from '../compose/brand.ts';
import { renderBlock, itemCount, capacityOf, esc } from './blocks.ts';
import { STRUCTURAL, type SlideSource, type BlockKind } from './types.ts';

/** Keys that would mean a coordinate. The schema forbids them; this catches a
 *  hand-edited file that slipped past a stale schema (slide/coordinate-in-source). */
const COORDINATE_KEYS = ['x', 'y', 'col', 'row', 'via', 'channelX', 'left', 'top', 'position'];

export interface CompileResult {
  deckPath: string;
  slides: SlideSource[];
  diagnostics: Diagnostic[];
}

// Compiled once, for the same reason the other two are.
let compiled: ReturnType<Ajv['compile']> | null = null;
function validator() {
  if (!compiled) {
    const schema = JSON.parse(readFileSync(join(SKILL_ROOT, 'schemas', 'slide.schema.json'), 'utf8'));
    compiled = new Ajv({ allErrors: true, strict: false }).compile(schema);
  }
  return compiled;
}

export function slideSources(root = projectRoot()): string[] {
  const dir = join(root, 'slides', 'src');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.slide.json')).sort();
}

function findCoordinates(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => findCoordinates(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      COORDINATE_KEYS.includes(k) ? [`${path}.${k}`] : findCoordinates(v, `${path}.${k}`));
  }
  return [];
}

export function loadSlideSources(root = projectRoot()): { slides: SlideSource[]; diagnostics: Diagnostic[] } {
  const dir = join(root, 'slides', 'src');
  const validate = validator();
  const slides: SlideSource[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const file of slideSources(root)) {
    const path = join(dir, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      diagnostics.push(diag('input/json-parse', 'error', `${file}: ${(e as Error).message}`, { file }, {},
        ['fix the JSON syntax']));
      continue;
    }
    if (!validate(parsed)) {
      for (const msg of formatAjvErrors(validate.errors)) {
        diagnostics.push(diag('storyboard/schema', 'error', `${file}: ${msg}`, { file }, {},
          ['see schemas/slide.schema.json', 'remove the unknown key']));
      }
    }
    const coords = findCoordinates(parsed);
    if (coords.length) {
      diagnostics.push(diag('slide/coordinate-in-source', 'error',
        `${file} carries coordinates: ${coords.join(', ')}`, { file }, { keys: coords },
        ['remove the coordinates: geometry follows from the block and the item count',
         'choose a block whose arrangement is what you wanted']));
    }
    slides.push(parsed as SlideSource);
  }
  return { slides, diagnostics };
}

/** Cross-source checks that do not need a browser (L17 capacity, L18 mode). */
export function lintSlides(slides: SlideSource[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const authoredShapes = new Map<string, string[]>();

  for (const s of slides) {
    const mode = s.mode ?? 'composed';
    if (mode === 'composed') {
      const block = s.block as BlockKind;
      const count = itemCount(s);
      const cap = capacityOf(block);
      if (count > cap) {
        out.push(diag('slide/block-over-capacity', 'error',
          `slide "${s.id}" puts ${count} items in "${block}", whose maximum is ${cap}`,
          { slide: s.id, block }, { count, capacity: cap },
          ['split the slide in two', 'choose a different block', 'cut an item']));
      }
      if (!STRUCTURAL.includes(block) && (s.connectors?.length ?? 0) > 0) {
        out.push(diag('slide/mode-mismatch', 'warning',
          `slide "${s.id}" declares connectors on "${block}", which has no topology`,
          { slide: s.id, block }, {},
          ['use flow-row, sequence or hub', 'remove the connectors']));
      }
      const ids = new Set((s.items ?? []).map((it, i) => it.id ?? `item-${i + 1}`));
      for (const c of s.connectors ?? []) {
        // A self-loop has no geometry to draw: both ports land on one box, the
        // curve doubles back through it, and every composition check exempts it
        // because the box is its own endpoint. It renders as a smear that
        // nothing can flag, so it is refused at the source instead.
        if (c.from === c.to) {
          out.push(diag('slide/connector-self-loop', 'error',
            `connector on slide "${s.id}" joins "${c.from}" to itself`,
            { slide: s.id, anchor: c.from }, {},
            ['point the connector at a different item', 'remove the connector',
             'say it in the narration: a self-relationship is not a shape']));
        }
        for (const end of [c.from, c.to]) {
          if (!ids.has(end)) {
            out.push(diag('slide/anchor-unmeasurable', 'error',
              `connector anchor "${end}" names no item on slide "${s.id}"`,
              { slide: s.id, anchor: end }, { itemIds: [...ids] },
              ['give the item an "id"', 'correct the connector']));
          }
        }
      }
    } else {
      // L18: authored mode is given, not imposed. What is enforced is the
      // RENDERED result, and the source-level checks that remain are warnings
      // whose whole job is to make inconsistency visible instead of silent.
      if (!s.html) {
        out.push(diag('storyboard/schema', 'error', `authored slide "${s.id}" has no html`, { slide: s.id }, {},
          ['add "html"', 'switch to composed mode with a block']));
      }
      if (s.css && /font-family\s*:/i.test(s.css) && !/var\(--font\)/.test(s.css)) {
        out.push(diag('slide/off-project-font', 'warning',
          `authored slide "${s.id}" sets a font-family outside the project face`,
          { slide: s.id }, {}, ['use font-family: var(--font)', 'remove the declaration and inherit']));
      }
      const literalColours = [...(s.css ?? '').matchAll(/#[0-9a-f]{3,8}\b|rgba?\(/gi)].length;
      if (literalColours > 0) {
        out.push(diag('slide/off-token-colour', 'warning',
          `authored slide "${s.id}" uses ${literalColours} literal colour(s) where project tokens exist`,
          { slide: s.id }, { count: literalColours },
          ['use var(--accent), var(--surface), var(--fg) and the tone tokens',
           'keep the literal if the slide genuinely needs a colour the palette does not have']));
      }
      // P16: a slide is rendered from a file:// page inside a recording. An
      // off-origin asset is both a privacy leak and a network dependency.
      const offOrigin = [...(s.html ?? '').matchAll(/(?:src|href)\s*=\s*["'](https?:)?\/\//gi)].length;
      if (offOrigin > 0) {
        out.push(diag('external/host-not-allowed', 'error',
          `authored slide "${s.id}" references ${offOrigin} off-origin asset(s)`,
          { slide: s.id }, { count: offOrigin },
          ['inline the asset as a data: URI', 'move it into slides/ and reference it relatively']));
      }
      // A structure that appears twice wants to be a block, not two hand-written
      // copies. This is how the vocabulary grows from real use.
      const shape = (s.html ?? '').replace(/>[^<]*</g, '><').replace(/\s+/g, ' ').slice(0, 400);
      const seen = authoredShapes.get(shape);
      if (seen) {
        out.push(diag('slide/authored-repeated', 'warning',
          `slides "${seen.join('", "')}" and "${s.id}" share an authored structure`,
          { slide: s.id }, { others: seen },
          ['promote the structure to a block in the vocabulary', 'keep both if they are genuinely one-offs']));
        seen.push(s.id);
      } else {
        authoredShapes.set(shape, [s.id]);
      }
    }
  }
  return out;
}

function slideHtml(s: SlideSource, beatsByslide: Record<string, number>): string {
  const mode = s.mode ?? 'composed';
  const head = (s.kicker || s.title || s.subtitle) && !(mode === 'composed' && s.block === 'title')
    ? `<div class="slide-head">
        ${s.kicker ? `<div class="slide-kicker">${esc(s.kicker)}</div>` : ''}
        ${s.title ? `<div class="slide-title" style="view-transition-name:t-${esc(s.id)}">${esc(s.title)}</div>` : ''}
        ${s.subtitle ? `<div class="slide-subtitle">${esc(s.subtitle)}</div>` : ''}
      </div>`
    : '';
  const body = mode === 'authored' ? (s.html ?? '') : renderBlock(s);
  const connectors = s.connectors?.length ? JSON.stringify(s.connectors) : '[]';
  return `<section class="slide" data-slide="${esc(s.id)}" data-mode="${mode}" data-beats="${beatsByslide[s.id] ?? 0}">
    <div class="slide-glow" data-decor></div>
    ${head}
    <div class="slide-body">
      ${body}
      <svg class="connectors" data-decor data-connectors='${connectors.replace(/'/g, '&#39;')}' xmlns="http://www.w3.org/2000/svg"></svg>
    </div>
  </section>`;
}

export interface CompileOptions {
  config: ProjectConfig;
  root?: string;
  /** Beats declared per slide, from the storyboard, for the beats-fired check. */
  beatsBySlide?: Record<string, number>;
  /**
   * Write the deck somewhere other than slides/deck.html, and take the sources
   * as given rather than reading them off disk.
   *
   * Both exist for the verified-repair loop: it has to compile a HYPOTHETICAL
   * deck to find out whether a proposed fix actually renders clean, and doing
   * that over the real deck would clobber the artifact being repaired.
   */
  outPath?: string;
  sources?: SlideSource[];
}

export function compileDeck(opts: CompileOptions): CompileResult {
  const root = opts.root ?? projectRoot();
  const paths = slidePaths();
  const loaded = opts.sources
    ? { slides: opts.sources, diagnostics: [] as Diagnostic[] }
    : loadSlideSources(root);
  const { slides } = loaded;
  const diagnostics = [...loaded.diagnostics];
  diagnostics.push(...lintSlides(slides));

  const brand = resolveBrand(opts.config);
  // A project may override the runtime tokens; P15 writes that file from the
  // running app, which is what keeps the slides and the live UI one palette.
  const projectTokens = join(root, 'slides', 'runtime', 'tokens.css');
  const tokensCss = existsSync(projectTokens)
    ? readFileSync(projectTokens, 'utf8')
    : readFileSync(join(paths.runtime, 'tokens.css'), 'utf8');
  const blocksCss = readFileSync(join(paths.runtime, 'blocks.css'), 'utf8');
  const deckJs = readFileSync(join(paths.runtime, 'deck.js'), 'utf8');
  const authoredCss = slides.filter((s) => (s.mode ?? 'composed') === 'authored' && s.css)
    .map((s) => `.slide[data-slide="${s.id}"] { }\n${s.css}`).join('\n');

  const mark = brand.logoDataUri || brand.name
    ? `<div class="deck-mark">
        ${brand.logoDataUri ? `<img src="${brand.logoDataUri}"/>` : ''}
        ${brand.name ? `<span class="name">${esc(brand.name)}</span>` : ''}
      </div>`
    : '';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>deck</title>
<style>
${embeddedFontCss()}
${tokensCss}
${blocksCss}
${authoredCss}
</style></head>
<body>
${slides.map((s) => slideHtml(s, opts.beatsBySlide ?? {})).join('\n')}
${mark}
<script>${deckJs}</script>
<script>${MEASURE_SCRIPT}</script>
</body></html>`;

  const deckPath = opts.outPath ?? paths.deck;
  mkdirSync(dirname(deckPath), { recursive: true });
  writeFileSync(deckPath, html);
  return { deckPath, slides, diagnostics };
}

/**
 * Measurement, shipped inside the deck so `slides check` and the recorder read
 * the same numbers. Everything it reports is about the RENDERED result, which is
 * the only thing that matters in either authoring mode (L18).
 */
export const MEASURE_SCRIPT = `
window.__slideMeasure = function () {
  var slide = document.querySelector('.slide[data-active]');
  if (!slide) return null;
  var W = 1920, H = 1080;
  var out = {
    id: slide.getAttribute('data-slide'),
    mode: slide.getAttribute('data-mode'),
    fonts: [], tooSmall: [], overflow: [], outside: [], contrast: [], words: 0,
    unmeasurable: window.__slideUnmeasurable || [],
    // The smallest size anything actually rendered at. The 22px floor above is
    // measured in the 1920-wide authoring frame; this is what the projected
    // readability check needs to work out what a viewer sees in a video player.
    minTextPx: null,
    geometry: window.__slideGeometry || null
  };
  var text = (slide.innerText || '').trim();
  out.words = text ? text.split(/\\s+/).length : 0;
  var els = Array.prototype.slice.call(slide.querySelectorAll('*'));
  els.forEach(function (el) {
    // Decoration is excluded from the safe-area and overflow checks: a corner
    // glow that stops at the frame edge is not a glow, and an empty connector
    // layer has no content to clip. Anything carrying text is never decoration.
    if (el.closest('[data-decor]')) return;
    var cs = getComputedStyle(el);
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var own = Array.prototype.filter.call(el.childNodes, function (n) {
      return n.nodeType === 3 && n.textContent.trim();
    }).length > 0;
    if (own) {
      var fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
      if (out.fonts.indexOf(fam) === -1) out.fonts.push(fam);
      var size = parseFloat(cs.fontSize);
      if (isFinite(size) && (out.minTextPx === null || size < out.minTextPx)) out.minTextPx = size;
      if (size < 22) out.tooSmall.push({ tag: el.tagName.toLowerCase(), size: size, text: (el.innerText||'').slice(0, 40) });
      out.contrast.push({ fg: cs.color, bg: backdrop(el), size: size, text: (el.innerText||'').slice(0, 40) });
    }
    if (el.scrollWidth > el.clientWidth + 2 && cs.overflow !== 'visible') {
      out.overflow.push({ tag: el.tagName.toLowerCase(), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
    }
    if (r.left < -1 || r.top < -1 || r.right > W + 1 || r.bottom > H + 1) {
      out.outside.push({ tag: el.tagName.toLowerCase(), rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }, text: (el.innerText||'').slice(0, 40) });
    }
  });
  return out;

  function backdrop(el) {
    var n = el;
    while (n && n !== document.documentElement) {
      var c = getComputedStyle(n).backgroundColor;
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
      n = n.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor;
  }
};`;
