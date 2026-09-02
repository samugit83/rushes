// "The app is ready" as a measurement, not a guess (P4).
//
// The old code waited `domcontentloaded` plus a fixed 400 ms, and booted on a
// fixed 1,200 ms. That is tuned for exactly one client-rendered SPA. A
// server-rendered Django page settles in one paint; a hydrating React route
// settles after its first data fetch; a slow Rails render settles later than
// either. The engine must not need to know which — so it waits on conditions
// that are true of all of them:
//
//   1. document.readyState === 'complete'
//   2. no in-flight network requests for `quietMs`
//   3. no CSS animation or transition currently running on a visible element
//   4. optionally, the app's own readySelector is visible
//   5. optionally, the app's own busySelector is NOT visible — the app's own
//      spinner is more reliable than any heuristic we could invent
//
// On timeout it says WHICH condition never became true, rather than continuing
// into a scene against a half-loaded page.

import type { Page } from 'playwright';
import { type Diagnostic, diag } from '../diagnostics.ts';

export interface ReadinessOptions {
  quietMs: number;
  timeoutMs: number;
  pollMs?: number;
  readySelector?: string | null;
  busySelector?: string | null;
  label?: string;
}

interface Tracker { inFlight: number; lastActivity: number; detach: () => void }

/** Count in-flight requests on a page, surviving navigations. */
export function trackNetwork(page: Page): Tracker {
  const t: Tracker = { inFlight: 0, lastActivity: Date.now(), detach: () => {} };
  const started = () => { t.inFlight++; t.lastActivity = Date.now(); };
  const ended = () => { t.inFlight = Math.max(0, t.inFlight - 1); t.lastActivity = Date.now(); };
  page.on('request', started);
  page.on('requestfinished', ended);
  page.on('requestfailed', ended);
  t.detach = () => {
    page.off('request', started);
    page.off('requestfinished', ended);
    page.off('requestfailed', ended);
  };
  return t;
}

async function animationsRunning(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    if (!document.getAnimations) return false;
    return document.getAnimations().some((a) => {
      if (a.playState !== 'running') return false;
      const target = (a as unknown as { effect?: { target?: Element | null } }).effect?.target;
      if (!target || !(target instanceof Element)) return false;
      // An infinite decorative loop (a pulsing dot, a spinner in a corner) must
      // not hold the whole page hostage.
      const timing = (a as unknown as { effect?: { getTiming?: () => { iterations?: number } } }).effect?.getTiming?.();
      if (timing && timing.iterations === Infinity) return false;
      const r = target.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
    });
  }).catch(() => false);
}

export interface SettleResult { settled: boolean; waitedMs: number; failed: string | null; diagnostics: Diagnostic[] }

/** Wait until the page is observably settled, or say which condition never was. */
export async function settle(page: Page, opts: ReadinessOptions): Promise<SettleResult> {
  const poll = opts.pollMs ?? 100;
  const started = Date.now();
  const net = trackNetwork(page);
  let lastFailed = 'readyState';

  try {
    while (Date.now() - started < opts.timeoutMs) {
      const state = await page.evaluate(() => document.readyState).catch(() => 'loading');
      if (state !== 'complete') { lastFailed = 'readyState'; await page.waitForTimeout(poll); continue; }

      if (net.inFlight > 0 || Date.now() - net.lastActivity < opts.quietMs) {
        lastFailed = 'networkQuiet';
        await page.waitForTimeout(poll);
        continue;
      }

      if (await animationsRunning(page)) { lastFailed = 'animations'; await page.waitForTimeout(poll); continue; }

      if (opts.busySelector) {
        const busy = await page.locator(opts.busySelector).first().isVisible({ timeout: 200 }).catch(() => false);
        if (busy) { lastFailed = 'busySelector'; await page.waitForTimeout(poll); continue; }
      }

      if (opts.readySelector) {
        const ready = await page.locator(opts.readySelector).first().isVisible({ timeout: 200 }).catch(() => false);
        if (!ready) { lastFailed = 'readySelector'; await page.waitForTimeout(poll); continue; }
      }

      return { settled: true, waitedMs: Date.now() - started, failed: null, diagnostics: [] };
    }
  } finally {
    net.detach();
  }

  const waitedMs = Date.now() - started;
  const code = lastFailed === 'busySelector' ? 'readiness/busy-selector-stuck' : 'readiness/timeout';
  const severity = lastFailed === 'busySelector' ? 'warning' : 'error';
  return {
    settled: false,
    waitedMs,
    failed: lastFailed,
    diagnostics: [diag(code, severity,
      `page never settled: "${lastFailed}" was still true after ${waitedMs} ms`,
      { url: page.url(), condition: lastFailed, label: opts.label ?? 'app' },
      { waitedMs, timeoutMs: opts.timeoutMs, quietMs: opts.quietMs },
      lastFailed === 'networkQuiet'
        ? ['raise readiness.quietMs if the app polls', 'raise readiness.timeoutMs', 'set readiness.readySelector to something the loaded page shows']
        : lastFailed === 'busySelector'
          ? ['check readiness.busySelector still matches the app spinner', 'raise readiness.timeoutMs']
          : ['set readiness.readySelector to an element the loaded page shows', 'raise readiness.timeoutMs'])],
  };
}
