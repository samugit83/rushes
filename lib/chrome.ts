// One place that answers "where is Chrome". Cards, thumbnails, the slide
// compiler and `doctor` all resolve the binary through here (R2 / F9: this was
// duplicated verbatim in compose/cards.ts and thumbnail/render.ts).
//
// SP9: the browser is resolved from PATH and never downloaded at run time.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { IS_MAC, IS_WINDOWS, which } from './platform.ts';

/**
 * Names to look for on PATH, per platform.
 *
 * These were Linux binary names only, which is wrong twice. On macOS Chrome
 * installs into an application bundle and is never on PATH, so the lookup always
 * missed and the stated intent — "someone who installed Chrome deliberately
 * should get the one they chose" — silently never applied. On Windows none of
 * them exists at all.
 */
export const CHROME_CANDIDATES: readonly string[] = IS_WINDOWS
  ? ['chrome', 'chrome.exe', 'msedge']
  : IS_MAC
    ? ['google-chrome', 'chromium']
    : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];

/**
 * Absolute locations a platform installs a browser to without putting it on
 * PATH. Checked after PATH and before the engine's bundled build.
 */
const CHROME_INSTALL_PATHS: readonly string[] = IS_MAC
  ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
  : IS_WINDOWS
    ? [
        `${process.env['PROGRAMFILES'] ?? 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env['LOCALAPPDATA'] ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env['PROGRAMFILES'] ?? 'C:\\Program Files'}\\Microsoft\\Edge\\Application\\msedge.exe`,
      ].filter((p) => !p.startsWith('\\'))
    : [];

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
    const found = which(c);
    if (found) { cached = found; return cached; }
  }
  // Installed, but not on PATH. This is the NORMAL case on macOS and Windows,
  // where a browser lives in an application bundle or under Program Files.
  for (const p of CHROME_INSTALL_PATHS) {
    if (existsSync(p)) { cached = p; return cached; }
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

/**
 * Render an HTML file to a PNG at an exact pixel size.
 *
 * The source URL is built with `pathToFileURL`, not by concatenating `file://`
 * onto a path. Concatenation is wrong on Windows in two ways at once — the
 * separators are backslashes and the drive letter needs a third slash — and it
 * is wrong everywhere for a path containing a character a URL must escape.
 */
export function screenshotHtml(htmlPath: string, pngPath: string, width: number, height: number): void {
  execFileSync(chromeBin(), [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--force-device-scale-factor=1', `--window-size=${width},${height}`,
    '--virtual-time-budget=4000',
    `--screenshot=${pngPath}`, pathToFileURL(htmlPath).href,
  ], { stdio: 'ignore', windowsHide: true });
}
