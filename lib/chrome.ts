// One place that answers "where is Chrome". Cards, thumbnails, the slide
// compiler and `doctor` all resolve the binary through here (R2 / F9: this was
// duplicated verbatim in compose/cards.ts and thumbnail/render.ts).
//
// SP9: the browser is resolved from PATH and never downloaded at run time.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

export const CHROME_CANDIDATES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
] as const;

let cached: string | null | undefined;

/**
 * The browser engine's own bundled Chromium.
 *
 * Two parts of this tool need a browser: the recorder, which drives one through
 * the engine, and the card, thumbnail and slide renderers, which shell out to
 * one for a headless screenshot. Those used to be satisfied by two DIFFERENT
 * installs, so `doctor --fix` could install the engine's browser, report
 * success, and leave `doctor` still saying no browser was found. One install
 * covers both now.
 *
 * This is not "downloading a browser at run time", which stays forbidden: it is
 * using a dependency that is already installed, resolved through the engine's
 * own API rather than fetched.
 */
function bundledChromium(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright-core') as { chromium: { executablePath(): string } };
    const path = chromium.executablePath();
    return path && existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

/**
 * A usable Chrome/Chromium: one on PATH first, then the engine's bundled build.
 * Memoized, including the miss.
 *
 * PATH wins because someone who installed Chrome deliberately should get the one
 * they chose, and because a system build is the one their users actually have.
 */
export function findChrome(): string | null {
  if (cached !== undefined) return cached;
  for (const c of CHROME_CANDIDATES) {
    try { execFileSync('which', [c], { stdio: 'ignore' }); cached = c; return cached; } catch { /* next */ }
  }
  cached = bundledChromium();
  return cached;
}

/** Where the browser came from, so `doctor` can say which one it will use. */
export function chromeSource(): 'path' | 'bundled' | 'none' {
  const found = findChrome();
  if (!found) return 'none';
  return found.includes('ms-playwright') ? 'bundled' : 'path';
}

/** Test seam: forget the memoized lookup. */
export function resetChromeCache(): void { cached = undefined; }

export function chromeBin(): string {
  const bin = findChrome();
  if (!bin) throw new Error(`no chrome/chromium on PATH (looked for: ${CHROME_CANDIDATES.join(', ')})`);
  return bin;
}

/** Render an HTML file to a PNG at an exact pixel size. */
export function screenshotHtml(htmlPath: string, pngPath: string, width: number, height: number): void {
  execFileSync(chromeBin(), [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--force-device-scale-factor=1', `--window-size=${width},${height}`,
    '--virtual-time-budget=4000',
    `--screenshot=${pngPath}`, `file://${htmlPath}`,
  ], { stdio: 'ignore' });
}
