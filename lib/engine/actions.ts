// Executes one storyboard Step against a page, driving the synthetic cursor so
// the recording reads as a human using the app: the cursor glides to a target
// before clicking, clicks leave a ripple (overlay.ts), and typing has a cadence.
// Locators are resolved from the declarative descriptor, so a storyboard stays
// plain JSON and never carries a Playwright object.
//
// Every navigation goes through the P16 guard, and every arrival waits on the
// measured settle predicate (P4) rather than on a fixed timeout.

import type { Page } from 'playwright';
import type { CanvasStrategy, Step } from '../types.ts';
import { TIMING, EXTERNAL_READINESS } from '../config.ts';
import { type ProjectConfig, readinessOf } from '../projectConfig.ts';
import { resolveLocator, locatorOf } from './locators.ts';
import { settle } from './readiness.ts';
import { classifyDestination, classifyRedirectChain, CredentialBoundary, type ExternalVisit } from './navigation.ts';
import type { Diagnostic } from '../diagnostics.ts';
import { diag } from '../diagnostics.ts';

export interface StepContext {
  page: Page;
  config: ProjectConfig;
  /** Rewrites a same-origin path before navigation (the adapter's scoping hook). */
  scopePath: (path: string) => string;
  /** Context-wide credential headers, withheld at an origin boundary. */
  contextHeaders: Record<string, string> | null;
  /** True when the context carries httpCredentials, which cannot be unset. */
  hasContextCredentials: boolean;
  /** Visible text captured from the last off-origin page, for the privacy scan. */
  externalText?: string;
  /**
   * The open credential-free visit, while an off-origin page is on screen.
   *
   * It stays open for the rest of the scene so the storyboard can still scroll,
   * click and wait on that page. Capturing one screenshot and calling it done
   * would have silently turned every subsequent step into a no-op, which is how
   * a shipped storyboard that scrolls a wiki page becomes four seconds of a
   * still image with nothing saying so.
   */
  externalVisit?: ExternalVisit | null;
  /** Records every host contacted with the address it resolved to (SP8). */
  noteHost: (host: string, ip: string, external: boolean) => void;
  /** The compiled deck's URL, when one has been built. */
  deckUrl: string | null;
  /** Set when the deck is open, so a `slide` step is a hash change, not a load. */
  deckOpen: boolean;
  diagnostics: Diagnostic[];
}

// Track the cursor so a glide starts from where it currently is.
let cursor = { x: 960, y: 540 };
export function resetCursor(): void { cursor = { x: 960, y: 540 }; }

async function glideTo(page: Page, x: number, y: number, ms = TIMING.cursorGlideMs): Promise<void> {
  const steps = Math.max(6, Math.round(ms / 16));
  const from = { ...cursor };
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // easeInOut so the cursor accelerates then settles, not a robotic line
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    await page.waitForTimeout(ms / steps);
  }
  cursor = { x, y };
}

async function centerOf(page: Page, step: Step): Promise<{ x: number; y: number }> {
  const box = await resolveLocator(page, step).boundingBox();
  if (!box) throw new Error('target not visible (no bounding box)');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function ring(page: Page, rect: unknown): Promise<void> {
  await page.evaluate((r) => (window as unknown as { __demoRing?: (r: unknown) => void }).__demoRing?.(r), rect);
}

async function waitSettled(ctx: StepContext, external: boolean): Promise<void> {
  const r = external
    ? await settle(ctx.page, { ...EXTERNAL_READINESS, ...(ctx.config.external?.readiness ?? {}), label: 'external' })
    : await settle(ctx.page, { ...readinessOf(ctx.config), pollMs: 100, label: 'app' });
  // An external page that never goes quiet is a warning: someone else's site is
  // allowed to have a beacon that never stops.
  ctx.diagnostics.push(...r.diagnostics.map((d) =>
    external && d.code === 'readiness/timeout'
      ? { ...d, code: 'external/never-settled', severity: 'warning' as const }
      : d));
}

/** Aim points inside a canvas, by strategy. */
async function canvasTargets(page: Page, step: Step, strategy: CanvasStrategy, box: { x: number; y: number; width: number; height: number }) {
  const sel = step.css ?? 'canvas';
  if (strategy === 'center') return [{ x: box.x + box.width / 2 + (step.dx ?? 0), y: box.y + box.height / 2 + (step.dy ?? 0) }];

  if (strategy === 'grid-scan') {
    const out: { x: number; y: number }[] = [];
    for (const fy of [0.5, 0.35, 0.65, 0.25, 0.75]) {
      for (const fx of [0.5, 0.35, 0.65, 0.25, 0.75]) {
        out.push({ x: box.x + box.width * fx, y: box.y + box.height * fy });
      }
    }
    return out.slice(0, 12);
  }

  // saturated-disc: read the actual painted pixels instead of guessing. A
  // force-directed renderer randomises node positions on every layout, so a
  // fixed pixel is unreliable; but nodes are drawn as saturated filled discs on
  // a near-black ground while links are thin desaturated lines. Aiming at the
  // most saturated pixels lands on a real node with one deliberate click, so the
  // recording never shows the cursor hunting around the canvas.
  const spots = await page.evaluate((s: string) => {
    // Largest canvas = the one that matters (apps also mount small sparklines).
    const all = [...document.querySelectorAll(s)] as HTMLCanvasElement[];
    const c = all.sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const ctx2d = c?.getContext('2d');
    if (!c || !ctx2d || !c.width || !c.height) return [];
    let img: ImageData;
    try { img = ctx2d.getImageData(0, 0, c.width, c.height); } catch { return []; }
    const d = img.data;
    const sx = c.clientWidth / c.width; // canvas px -> CSS px
    const sy = c.clientHeight / c.height;
    const hits: { x: number; y: number; score: number }[] = [];
    for (let y = 0; y < c.height; y += 3) {
      for (let x = 0; x < c.width; x += 3) {
        const i = (y * c.width + x) * 4;
        if (d[i + 3] < 200) continue;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mx < 90) continue; // background
        if ((mx - mn) / mx < 0.35) continue; // grey links + white labels
        hits.push({ x: x * sx, y: y * sy, score: ((mx - mn) / mx) * mx });
      }
    }
    // Keep the strongest, spread out, so a retry tries a DIFFERENT element
    // rather than another pixel of the same disc.
    hits.sort((a, b) => b.score - a.score);
    const picked: { x: number; y: number }[] = [];
    for (const h of hits) {
      if (picked.every((p) => Math.hypot(p.x - h.x, p.y - h.y) > 40)) picked.push({ x: h.x, y: h.y });
      if (picked.length >= 8) break;
    }
    return picked;
  }, sel);

  if (spots.length) return spots.map((s) => ({ x: box.x + s.x, y: box.y + s.y }));
  // Canvas unreadable (WebGL, tainted): fall back to a centre-outward spiral.
  const cx = box.x + box.width / 2 + (step.dx ?? 0);
  const cy = box.y + box.height / 2 + (step.dy ?? 0);
  return ([[0, 0], [36, 0], [-36, 0], [0, 36], [0, -36], [64, 48], [-64, -48]] as [number, number][])
    .map(([dx, dy]) => ({ x: cx + dx, y: cy + dy }));
}

/** The page a step acts on: the off-origin one while a visit is open. */
export function activePage(ctx: StepContext): Page {
  return ctx.externalVisit?.page ?? ctx.page;
}

/** Close an open off-origin visit and take its overlay down. */
export async function closeExternalVisit(ctx: StepContext): Promise<void> {
  if (!ctx.externalVisit) return;
  const visit = ctx.externalVisit;
  ctx.externalVisit = null;
  await visit.close();
  await ctx.page.evaluate(() => document.getElementById('__rushes_external__')?.remove()).catch(() => {});
}

export async function runStep(ctx: StepContext, step: Step): Promise<void> {
  const { config } = ctx;

  // Leaving the off-origin page: a navigation of any kind ends the visit.
  if (ctx.externalVisit && (step.do === 'goto' || step.do === 'slide') && !step.external) {
    await closeExternalVisit(ctx);
  }
  // Everything else acts on whichever page is currently on screen.
  const page = activePage(ctx);

  switch (step.do) {
    case 'goto': {
      const isExternal = !!step.external;
      const raw = isExternal ? step.external! : ctx.scopePath(step.path ?? '/');
      const decision = await classifyDestination(raw, config, isExternal ? 'external' : 'app');
      ctx.diagnostics.push(...decision.diagnostics);
      if (!decision.allowed || !decision.destination) {
        throw new Error(decision.diagnostics[0]?.message ?? `navigation refused: ${raw}`);
      }
      const dest = decision.destination;
      if (dest.kind !== 'file') ctx.noteHost(dest.host, decision.pinnedIp ?? '', dest.kind === 'external');

      if (dest.kind === 'external') {
        await gotoExternal(ctx, dest);
        ctx.deckOpen = false;
        return;
      }

      const res = await page.goto(dest.url, { waitUntil: 'domcontentloaded' });
      void res;
      await waitSettled(ctx, false);
      ctx.deckOpen = dest.kind === 'file';
      return;
    }

    case 'slide': {
      if (!ctx.deckUrl) throw new Error('no compiled deck: run `rushes slides build` first');
      const target = `${ctx.deckUrl}#/${step.slide}`;
      if (ctx.deckOpen) {
        // A hash change inside the already-open deck: no page load, so the font,
        // the runtime and the cursor overlay all stay alive across slides.
        await page.evaluate((h: string) => { location.hash = h; }, `#/${step.slide}`);
        await page.waitForTimeout(120);
      } else {
        const decision = classifyDestinationFile(target);
        ctx.diagnostics.push(...decision.diagnostics);
        if (!decision.allowed) throw new Error(decision.diagnostics[0]?.message ?? 'slide navigation refused');
        await page.goto(target, { waitUntil: 'domcontentloaded' });
        ctx.deckOpen = true;
      }
      await page.waitForFunction(() => !!(window as unknown as { __slide?: unknown }).__slide, null, { timeout: 5000 })
        .catch(() => {});
      return;
    }

    case 'wait':
      await page.waitForTimeout(step.ms ?? 1000);
      await repaintExternal(ctx);
      return;

    case 'waitFor':
      await resolveLocator(page, step).waitFor({ state: 'visible', timeout: 20_000 });
      return;

    case 'press':
      await page.keyboard.press(step.keys ?? 'Enter');
      return;

    case 'scroll': {
      if (locatorOf(step)) {
        const { x, y } = await centerOf(page, step);
        await page.mouse.move(x, y);
      }
      await page.mouse.wheel(0, step.dy ?? 400);
      await page.waitForTimeout(500);
      await repaintExternal(ctx);
      return;
    }

    case 'clickCanvas': {
      const canvas = resolveLocator(page, { css: step.css ?? 'canvas' });
      const box = await canvas.boundingBox();
      if (!box) throw new Error('canvas not visible for clickCanvas');
      // What proves the click landed. This used to be one application's drawer
      // label, compiled into the engine; it is now the storyboard's (or the
      // config's) business, which is what makes the step portable.
      const confirmDesc = step.confirm ?? config.canvasConfirm ?? null;
      const confirm = confirmDesc ? resolveLocator(page, confirmDesc) : null;
      const targets = await canvasTargets(page, step, step.strategy ?? 'saturated-disc', box);

      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        // Glide only to the first candidate; a miss retries without a new sweep,
        // so the recording does not show the cursor wandering.
        if (i === 0) await glideTo(page, t.x, t.y);
        else await page.mouse.move(t.x, t.y);
        await page.mouse.click(t.x, t.y);
        cursor = { x: t.x, y: t.y };
        await page.waitForTimeout(600);
        if (!confirm) return; // nothing declared to confirm against: one click is the step
        if (await confirm.isVisible().catch(() => false)) return;
      }
      throw new Error('clickCanvas: no candidate satisfied the confirm locator');
    }
  }

  // Remaining kinds all target a locator.
  const loc = resolveLocator(page, step);
  await loc.waitFor({ state: 'visible', timeout: 20_000 });
  const { x, y } = await centerOf(page, step);

  switch (step.do) {
    case 'moveTo':
    case 'hover':
      await glideTo(page, x, y);
      if (step.do === 'hover') await loc.hover();
      await repaintExternal(ctx);
      return;
    case 'highlight':
      await glideTo(page, x, y);
      await ring(page, await loc.boundingBox());
      await page.waitForTimeout(step.ms ?? 1400);
      await ring(page, null);
      return;
    case 'click':
      await glideTo(page, x, y);
      await loc.click();
      await page.waitForTimeout(450);
      await repaintExternal(ctx);
      return;
    case 'type':
      await glideTo(page, x, y);
      await loc.click();
      await loc.fill('');
      await page.keyboard.type(step.value ?? '', { delay: TIMING.typeDelayMs });
      return;
    case 'drag': {
      // press-move-release: pans a canvas or a node graph
      await glideTo(page, x, y);
      await page.mouse.down();
      const dx = step.dx ?? -260;
      const dy = step.dy ?? 0;
      const steps = 24;
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(x + (dx * i) / steps, y + (dy * i) / steps);
        await page.waitForTimeout(16);
      }
      await page.mouse.up();
      cursor = { x: x + dx, y: y + dy };
      await page.waitForTimeout(400);
      return;
    }
    case 'zoom': {
      await glideTo(page, x, y);
      await page.keyboard.down('Control');
      const per = (step.factor ?? 1.4) >= 1 ? -60 : 60;
      for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, per); await page.waitForTimeout(60); }
      await page.keyboard.up('Control');
      await page.waitForTimeout(400);
      return;
    }
  }
}

/**
 * Film an off-origin page from a context that never held a credential, then
 * paint it back into the recorded page.
 *
 * The recording is of ONE page, so the external page cannot simply take over:
 * its rendered result is captured and shown in the page being recorded. What
 * crosses the boundary is a picture, which is exactly what a video needs and
 * the least that could cross.
 */
async function gotoExternal(ctx: StepContext, dest: { url: string; host: string }): Promise<void> {
  const { page, config } = ctx;
  const boundary = new CredentialBoundary(page, ctx.contextHeaders, ctx.hasContextCredentials);
  if (boundary.hadCredentials) {
    // Recorded, not refused: the receipt has to be able to show that a
    // credential was in play at the boundary and did not cross it.
    ctx.diagnostics.push(diag('external/credential-leak', 'warning',
      'a context credential was withheld from an off-origin navigation',
      { host: dest.host },
      { headers: Object.keys(ctx.contextHeaders ?? {}), httpCredentials: ctx.hasContextCredentials },
      ['this is the correct behaviour; no action needed']));
  }

  await closeExternalVisit(ctx); // one visit at a time
  const viewport = page.viewportSize() ?? { width: 1920, height: 1080 };
  const visit = await boundary.open(viewport);
  ctx.externalVisit = visit;
  try {
    const res = await visit.page.goto(dest.url, { waitUntil: 'domcontentloaded' });
    ctx.diagnostics.push(...await classifyRedirectChain(res));

    const external = { ...EXTERNAL_READINESS, ...(config.external?.readiness ?? {}), label: 'external' };
    const settled = await settle(visit.page, external);
    ctx.diagnostics.push(...settled.diagnostics.map((d) =>
      d.code === 'readiness/timeout' ? { ...d, code: 'external/never-settled', severity: 'warning' as const } : d));

    for (const d of config.external?.dismiss ?? []) {
      const loc = resolveLocator(visit.page, d.locator);
      if (await loc.isVisible({ timeout: 800 }).catch(() => false)) {
        await loc.click({ timeout: 1500 }).catch(() => {});
        await visit.page.waitForTimeout(400);
      }
    }

    // The visible text still has to be scannable, so the privacy check sees
    // what a viewer will see.
    ctx.externalText = await visit.page.evaluate(() => document.body?.innerText ?? '').catch(() => '');

    await repaintExternal(ctx, dest.url);
  } catch (e) {
    await closeExternalVisit(ctx);
    throw e;
  }
}

/**
 * Re-capture the off-origin page and show it in the recording.
 *
 * Called after every step that acted on it, so a scroll or a click on someone
 * else's page is visible in the video exactly as it would be if the recording
 * were pointed at it directly. The picture is what crosses the boundary; the
 * credential does not.
 */
export async function repaintExternal(ctx: StepContext, url?: string): Promise<void> {
  const visit = ctx.externalVisit;
  if (!visit) return;
  const shot = await visit.page.screenshot({ type: 'png' }).catch(() => null);
  if (!shot) return;
  await paintExternalFrame(ctx.page, shot.toString('base64'), url ?? visit.page.url());
}

/**
 * Show the captured external page inside the recorded page, full-bleed, with
 * the source URL visible. A viewer must be able to see WHERE this came from;
 * a borrowed page with no attribution reads as part of the product.
 */
async function paintExternalFrame(page: Page, pngBase64: string, url: string): Promise<void> {
  await page.evaluate(({ src, href }) => {
    const id = '__rushes_external__';
    document.getElementById(id)?.remove();
    const host = document.createElement('div');
    host.id = id;
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:#0b0a10;';
    const img = document.createElement('img');
    img.src = 'data:image/png;base64,' + src;
    img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
    const bar = document.createElement('div');
    bar.textContent = href;
    bar.style.cssText = 'position:absolute;left:0;right:0;bottom:0;padding:10px 18px;'
      + 'font:500 20px system-ui,sans-serif;color:#e7e5ea;background:rgba(11,10,16,.82);';
    host.appendChild(img);
    host.appendChild(bar);
    document.documentElement.appendChild(host);
  }, { src: pngBase64, href: url });
  await page.waitForTimeout(120);
}

// Imported here rather than at the top so the `slide` branch above reads in one
// place; ESM hoists it either way.
import { classifyFileUrl as classifyDestinationFile } from './navigation.ts';
