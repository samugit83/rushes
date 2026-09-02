// Rendering the compiled deck: one PNG per slide, and the measured facts about
// what actually came out.
//
// This is the cheap half of the whole slide system. It needs no TTS, no
// recording and no ffmpeg — a browser, a hash change and a screenshot. That is
// what makes Gate 2.5 possible: the user sees every slide in seconds, before any
// spend, instead of discovering a design is wrong inside a finished video, which
// is the most expensive possible place to discover it.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Page } from 'playwright';
import { VIDEO } from '../config.ts';
import { slidePaths } from '../paths.ts';
import type { SlideGeometry } from './geometry.ts';
import type { SlideSource } from './types.ts';

export interface SlideMeasurement {
  id: string;
  mode: string;
  fonts: string[];
  tooSmall: { tag: string; size: number; text: string }[];
  overflow: { tag: string; scrollWidth: number; clientWidth: number }[];
  outside: { tag: string; rect: { x: number; y: number; w: number; h: number }; text: string }[];
  contrast: { fg: string; bg: string; size: number; text: string }[];
  words: number;
  unmeasurable: string[];
  /** Smallest size anything rendered at, for the projected readability check. */
  minTextPx: number | null;
  /** The drawn connectors, sampled off the real paths. Null when a slide has none. */
  geometry: SlideGeometry | null;
}

export interface RenderedSlide {
  id: string;
  png: string | null;
  measurement: SlideMeasurement | null;
}

export interface RenderOptions {
  slides: SlideSource[];
  outDir?: string;
  /** Skip the PNG when only the measurements are wanted. */
  measureOnly?: boolean;
  width?: number;
  height?: number;
  /** Render from a deck other than slides/deck.html (the repair loop's scratch deck). */
  deckPath?: string;
}

/**
 * A browser held open across several renders.
 *
 * The verified-repair loop compiles and renders one slide per candidate fix, so
 * paying a browser launch per candidate would make proving a fix cost more than
 * the fix. Everything else keeps using `renderSlides`, which is this with a
 * launch and a close around it.
 */
export interface SlideRenderer {
  render(opts: RenderOptions): Promise<RenderedSlide[]>;
  close(): Promise<void>;
}

export async function openRenderer(width: number = VIDEO.width, height: number = VIDEO.height): Promise<SlideRenderer> {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  return {
    render: (opts: RenderOptions) => renderOn(page, opts),
    async close() {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}

export async function renderSlides(opts: RenderOptions): Promise<RenderedSlide[]> {
  const renderer = await openRenderer(opts.width ?? VIDEO.width, opts.height ?? VIDEO.height);
  try {
    return await renderer.render(opts);
  } finally {
    await renderer.close();
  }
}

async function renderOn(page: Page, opts: RenderOptions): Promise<RenderedSlide[]> {
  const paths = slidePaths();
  if (opts.outDir) mkdirSync(opts.outDir, { recursive: true });

  const deckUrl = pathToFileURL(opts.deckPath ?? paths.deck).toString();
  const out: RenderedSlide[] = [];

  {
    for (const s of opts.slides) {
      const url = `${deckUrl}#/${s.id}`;
      // Navigating to the URL the page is ALREADY on is a same-document
      // navigation: the file on disk has changed underneath, and the browser
      // serves what it already parsed. The verified-repair loop renders many
      // different decks through one held-open page, so without this every
      // candidate after the first was measured against the first one's DOM and
      // every "verified" fix after it was a lie.
      if (page.url() === url) await page.reload({ waitUntil: 'load' });
      else await page.goto(url, { waitUntil: 'load' });
      // A hash change on an already-open deck does not reload, so nudge the
      // router explicitly and let entrance motion finish before measuring.
      await page.evaluate((id: string) => {
        const api = (window as unknown as { __slide?: { show: (i: string) => boolean } }).__slide;
        api?.show(id);
      }, s.id);
      await page.waitForTimeout(700);
      await page.evaluate(() => document.fonts?.ready).catch(() => {});
      // Freeze motion to its settled frame for measurement and the golden still.
      // The recorder never does this, so a filmed slide stays fully animated;
      // the preview and the golden must be deterministic, so here they are not.
      await page.evaluate(() => document.documentElement.setAttribute('data-still', '')).catch(() => {});
      await page.waitForTimeout(60);

      const measurement = await page.evaluate(() => {
        const fn = (window as unknown as { __slideMeasure?: () => unknown }).__slideMeasure;
        return fn ? fn() : null;
      }) as SlideMeasurement | null;

      let png: string | null = null;
      if (!opts.measureOnly && opts.outDir) {
        png = join(opts.outDir, `${s.id}.png`);
        await page.screenshot({ path: png });
      }
      out.push({ id: s.id, png, measurement });
    }
  }
  return out;
}

/** A contact sheet with relative paths, so it opens from anywhere. */
export function contactSheet(rendered: RenderedSlide[], title: string): string {
  const cards = rendered.filter((r) => r.png).map((r) => `
    <figure>
      <img src="${r.id}.png" alt="${r.id}"/>
      <figcaption>${r.id}${r.measurement ? ` · ${r.measurement.words} words · ${r.measurement.mode}` : ''}</figcaption>
    </figure>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
    body{background:#0b0a10;color:#e7e5ea;font:14px system-ui,sans-serif;margin:0;padding:28px;}
    h1{font-size:18px;font-weight:700;margin:0 0 20px;}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(460px,1fr));gap:20px;}
    figure{margin:0;background:#151320;border:1px solid rgba(231,229,234,.14);border-radius:12px;overflow:hidden;}
    img{display:block;width:100%;height:auto;}
    figcaption{padding:10px 14px;font-size:13px;color:rgba(231,229,234,.7);}
  </style></head><body><h1>${title}</h1><div class="grid">${cards}</div></body></html>`;
}

export function writeContactSheet(path: string, rendered: RenderedSlide[], title: string): string {
  writeFileSync(path, contactSheet(rendered, title));
  return path;
}
