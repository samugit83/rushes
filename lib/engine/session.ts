// ONE boot path (principle 8). `validate`, `rehearse`, `build` and `evidence`
// all open the app through this function. A validator that boots differently
// from the recorder produces the worst kind of green: steps that pass in the
// check and fail in the take.
//
// The order is fixed and each step is off the clock:
//   launch -> auth -> seed -> overlay + redaction -> navigate -> settle ->
//   dismissers -> preflight -> verify signed in -> prep -> asserts

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import type { Storyboard, Step } from '../types.ts';
import { VIDEO, TIMING } from '../config.ts';
import { isIP } from 'node:net';
import { type ProjectConfig, readinessOf } from '../projectConfig.ts';
import { classifyHost, LOCAL_APP_POLICY, STRICT_POLICY, type IpPolicy } from '../egress.ts';
import { demoPaths, slidePaths, skillAsset } from '../paths.ts';
import { type Diagnostic, diag } from '../diagnostics.ts';
import { strategyFor, verifySignedIn, type AuthApplyResult } from '../auth/index.ts';
import { overlayInit, redactionInit } from './overlay.ts';
import { settle } from './readiness.ts';
import { resolveLocator } from './locators.ts';
import { PreflightRunner, pendingRestoreDiagnostic } from './preflight.ts';
import { runStep, type StepContext, resetCursor } from './actions.ts';
import { classifyDestination } from './navigation.ts';
import { runAssertions } from './assertions.ts';

export interface BootOptions {
  story: Storyboard;
  config: ProjectConfig;
  /** Record a screencast. Off for validate/rehearse, on for build. */
  record?: boolean;
  /** Headed for `rushes login` and for debugging. */
  headed?: boolean;
  /** Skip the storyboard's own `prep` steps (validate does its own walk). */
  skipPrep?: boolean;
  /** Skip assert metrics (rehearsal runs them once, not twice). */
  skipAsserts?: boolean;
}

export interface Session {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  stepContext: StepContext;
  preflight: PreflightRunner | null;
  diagnostics: Diagnostic[];
  identity: string | null;
  hostsContacted: { host: string; ip: string; external: boolean }[];
  /** Wall clock at which the context (and so the screencast) was created. */
  recordStart: number;
  /**
   * The resolver pinning this browser was launched with, or null when nothing
   * could be pinned. Recorded in the receipt: "which address did this actually
   * connect to" is part of reconstructing a publish, and it is also the only way
   * to tell from the outside that the pinning was applied at all.
   */
  hostRules: string | null;
  videoDir: string | null;
  close(): Promise<void>;
}

/**
 * Pin every host the recording is allowed to reach to the address that passed
 * classification, and refuse to resolve anything else.
 *
 * Classifying a name and then letting the browser resolve it again is a check
 * that does not hold: the second answer can differ from the first, which is DNS
 * rebinding, and it is the exact bypass the resolved-IP rule exists to close.
 * The Python original this rule was ported from says so in as many words:
 * callers must connect to the pinned address rather than re-resolving.
 *
 * Chromium takes `--host-resolver-rules`, which is where the pin can actually be
 * enforced. Each classified host gets `MAP <host> <address that passed>`, so the
 * name the browser connects to cannot resolve differently from the name that was
 * checked. That is the whole of the rebinding fix, and it is always on.
 *
 * The optional extra is `MAP * ~NOTFOUND`: nothing else resolves at all. It is
 * OFF by default and deliberately so — a real application legitimately loads
 * subresources from names nobody listed (a font host, an avatar CDN, an error
 * reporter), and turning those into DNS failures would silently break real
 * recordings to close a hole that navigation checks already cover. Turn it on
 * with `egress.strictSubresources` when filming something that should be
 * reaching nothing else, and expect to add hosts.
 *
 * Ordering matters: the first matching rule wins, so the catch-all goes last.
 * `EXCLUDE *` is NOT this — it means "resolve this host normally, ignoring the
 * MAP rules", which is the opposite, and an earlier build shipped it believing
 * otherwise. `test/security.test.mjs` reaches a second name for this machine
 * with the rules off and cannot with them on, which is what caught it.
 */
export async function resolvedHostRules(config: ProjectConfig): Promise<string | null> {
  const rules: string[] = [];
  const seen = new Set<string>();

  const pin = async (host: string, policy: IpPolicy) => {
    const h = host.trim().toLowerCase();
    if (!h || seen.has(h)) return;
    seen.add(h);
    if (isIP(h)) { rules.push(`MAP ${h} ${h}`); return; }
    const c = await classifyHost(h, policy);
    if (c.allowed && c.pinnedIp) rules.push(`MAP ${h} ${c.pinnedIp}`);
  };

  try {
    await pin(new URL(config.baseUrl).hostname, LOCAL_APP_POLICY);
  } catch {
    return null; // an unusable baseUrl is reported by the config validation
  }
  for (const host of config.allowHosts ?? []) await pin(host, LOCAL_APP_POLICY);
  for (const host of config.external?.allow ?? []) await pin(host.replace(/^\./, ''), STRICT_POLICY);

  if (!rules.length) return null;
  if (config.egress?.strictSubresources) rules.push('MAP * ~NOTFOUND');
  return rules.join(',');
}

/** Chromium flags that are safe headless and useful headed under Xvfb. */
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage', // avoid /dev/shm-tied renderer crashes on long runs
  '--disable-gpu-sandbox',   // headed GPU under Xvfb is unstable with it on
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
];

function firstAppGoto(story: Storyboard): string {
  // Boot on the first SAME-ORIGIN navigation. An external page must never
  // become the boot URL, or the opening scenes record against someone else's
  // site; a `slide` step must not either.
  const step = story.scenes.flatMap((s) => s.steps).find((st) => st.do === 'goto' && st.path && !st.external);
  return step?.path ?? '/';
}

export async function boot(opts: BootOptions): Promise<Session> {
  const { story, config } = opts;
  const diagnostics: Diagnostic[] = [];

  // CF2: a leftover restore file means a previous run died holding someone's
  // preferences. Refuse before opening a browser.
  const pending = pendingRestoreDiagnostic();
  if (pending) diagnostics.push(pending);

  const video = { width: config.video?.width ?? VIDEO.width, height: config.video?.height ?? VIDEO.height };
  const P = demoPaths(story.id);
  let videoDir: string | null = null;
  if (opts.record) {
    videoDir = join(P.dir, '_vid');
    rmSync(videoDir, { recursive: true, force: true });
    mkdirSync(videoDir, { recursive: true });
  }

  // Resolve and pin BEFORE the browser exists, so there is no window in which
  // it could resolve a name for itself.
  const hostRules = await resolvedHostRules(config);
  const browser = await chromium.launch({
    headless: !opts.headed,
    args: hostRules ? [...LAUNCH_ARGS, `--host-resolver-rules=${hostRules}`] : LAUNCH_ARGS,
  });

  const auth = strategyFor(config);
  if (!('kind' in auth)) {
    await browser.close();
    return failFast(diagnostics.concat(auth));
  }

  // `basic` sets an unscoped context credential; it is applied here and dropped
  // again at every origin boundary (SP11).
  const basic = config.auth?.kind === 'basic' && config.auth.user && config.auth.pass
    ? { username: config.auth.user, password: config.auth.pass }
    : undefined;

  // Headless honours the exact viewport, so the captured page fills the frame.
  // Headed on a multi-monitor X display caps the page to the window's inner
  // size, which leaves the app in a corner of the recording.
  const context = await browser.newContext({
    viewport: video,
    deviceScaleFactor: 1,
    colorScheme: config.colorScheme === 'no-preference' ? 'no-preference' : (config.colorScheme ?? 'dark'),
    httpCredentials: basic,
    ...(videoDir ? { recordVideo: { dir: videoDir, size: video } } : {}),
  });

  const applied: AuthApplyResult = await auth.apply(context, config);
  diagnostics.push(...applied.diagnostics);

  // Seed storage before any app script runs. P7's hard-won lesson: when an app
  // reads its own storage key before it reads a server preference, seed BOTH or
  // the recording silently comes back in the wrong theme.
  const seedLocal = { ...(config.seed?.localStorage ?? {}), ...(story.seed ?? {}) };
  const seedSession = config.seed?.sessionStorage ?? {};
  if (Object.keys(seedLocal).length || Object.keys(seedSession).length) {
    await context.addInitScript(({ l, s }) => {
      try {
        for (const [k, v] of Object.entries(l)) localStorage.setItem(k, v);
        for (const [k, v] of Object.entries(s)) sessionStorage.setItem(k, v);
      } catch { /* private mode / storage disabled */ }
    }, { l: seedLocal, s: seedSession });
  }
  if (config.seed?.cookies?.length) {
    const host = new URL(config.baseUrl).hostname;
    await context.addCookies(config.seed.cookies.map((c) => ({
      name: c.name, value: c.value, domain: host, path: c.path ?? '/',
    })));
  }

  await context.addInitScript(overlayInit(config.brand?.accent));
  const redactSelectors = [...(config.redact ?? []), ...(story.redact ?? [])];
  if (redactSelectors.length) await context.addInitScript(redactionInit(redactSelectors));

  const recordStart = Date.now(); // ~when the screencast begins (page creation)
  const page = await context.newPage();

  const hostsContacted: { host: string; ip: string; external: boolean }[] = [];
  const noteHost = (host: string, ip: string, external: boolean) => {
    if (!hostsContacted.some((h) => h.host === host && h.external === external)) {
      hostsContacted.push({ host, ip, external });
    }
  };

  const deckPath = slidePaths().deck;
  const stepContext: StepContext = {
    page,
    config,
    scopePath: (p) => p,
    contextHeaders: applied.contextCredentials?.headers ?? null,
    // httpCredentials cannot be unset once a context has them, so the engine has
    // to know it has them in order to leave the context behind at a boundary.
    hasContextCredentials: !!applied.contextCredentials?.basic,
    noteHost,
    deckUrl: existsSync(deckPath) ? pathToFileURL(deckPath).toString() : null,
    deckOpen: false,
    diagnostics,
  };

  resetCursor();

  // First paint and any onboarding cleanup happen BEFORE the clock starts, so
  // the trimmed body opens on the settled app: no blank flash, no modals.
  const bootPath = firstAppGoto(story);
  const dest = await classifyDestination(stepContext.scopePath(bootPath), config, 'app');
  diagnostics.push(...dest.diagnostics);
  if (dest.allowed && dest.destination) {
    noteHost((dest.destination as { host: string }).host, dest.pinnedIp ?? '', false);
    await page.goto(dest.destination.url, { waitUntil: 'domcontentloaded' }).catch((e: Error) => {
      diagnostics.push(diag('readiness/timeout', 'error', `the app did not open: ${e.message}`,
        { url: dest.destination!.url }, {},
        ['start the app', 'correct baseUrl', 'add a runner block so rushes can start it']));
    });
    const s = await settle(page, { ...readinessOf(config), label: 'boot' });
    diagnostics.push(...s.diagnostics);
  }

  // Declarative dismissers, off the clock, each optional and each logged (P6).
  // Also covers the cookie walls a public-URL recording hits constantly.
  for (const d of config.dismiss ?? []) {
    try {
      const loc = resolveLocator(page, d.locator);
      if (await loc.isVisible({ timeout: 800 }).catch(() => false)) {
        if (d.checkAllCheckboxes) {
          const cbs = page.locator('input[type=checkbox]');
          const n = await cbs.count();
          for (let i = 0; i < n; i++) await cbs.nth(i).check({ timeout: 500 }).catch(() => {});
        }
        await loc.click({ timeout: 1500 }).catch(() => {});
        await page.waitForTimeout(400);
      } else if (!d.optional) {
        diagnostics.push(diag('step/locator-unresolved', 'warning',
          'a required dismisser was never visible', { locator: d.locator }, {},
          ['mark it "optional": true', 'correct the locator']));
      }
    } catch { /* a dismisser is best-effort by construction */ }
  }

  // Pre-state through the authenticated request context, before the clock.
  let preflight: PreflightRunner | null = null;
  if (config.preflight?.length) {
    preflight = new PreflightRunner(context.request, config);
    await preflight.run(config.preflight);
    diagnostics.push(...preflight.diagnostics);
    // A preference change only lands after a reload for most apps.
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    const s = await settle(page, { ...readinessOf(config), label: 'post-preflight' });
    diagnostics.push(...s.diagnostics);
  }

  diagnostics.push(...await verifySignedIn(page, config));

  if (!opts.skipPrep) {
    for (const step of story.prep ?? []) {
      try {
        await runStep(stepContext, step as Step);
      } catch (e) {
        // Prep is setup, not content: a failure is a warning with evidence, and
        // the scene-level gate decides whether the take is usable.
        diagnostics.push(diag('step/failed', 'warning', `prep ${step.do} failed: ${(e as Error).message}`,
          { do: step.do }, { url: page.url() }, ['correct the prep step', 'move it into a scene so it is checked']));
      }
    }
  }

  if (!opts.skipAsserts && story.assert?.length) {
    diagnostics.push(...await runAssertions(context.request, config, story.assert));
  }

  const restorable: RestorableSession = {
    async restore() { if (preflight) await preflight.restore(); },
  };

  const session: Session = {
    browser, context, page, stepContext, preflight, diagnostics,
    identity: applied.identity, hostsContacted, recordStart, videoDir, hostRules,
    async close() {
      // Deregister FIRST, so a signal arriving mid-close does not run the same
      // restore twice against an app that has already been put back.
      deregisterSessionRestore(restorable);
      if (preflight) await preflight.restore().catch(() => {});
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };

  // A recording runs for minutes. Ctrl-C must not leave the operator's
  // preferences mutated with no message saying so.
  registerSessionRestore(restorable);
  return session;

  function failFast(ds: Diagnostic[]): Session {
    return {
      browser: null as unknown as Browser, context: null as unknown as BrowserContext,
      page: null as unknown as Page, stepContext: null as unknown as StepContext,
      preflight: null, diagnostics: ds, identity: null, hostsContacted: [],
      recordStart: Date.now(), videoDir: null, hostRules: null,
      async close() { /* nothing opened */ },
    };
  }
}

/**
 * Live sessions that still hold pre-state, and the process-wide signal handlers
 * that put it back.
 *
 * These used to be a single boolean and a single captured session. `rehearse`
 * boots TWICE in one process, so the second session registered nothing and the
 * handler that did exist closed over the first — meaning a Ctrl-C during the
 * second pass restored an already-restored session and left the live one's
 * preferences mutated. The registry is a set because the number of live
 * sessions is not one.
 */
interface RestorableSession { restore(): Promise<void> }

const liveRestores = new Set<RestorableSession>();
let signalHandlersInstalled = false;

export function pendingRestores(): number { return liveRestores.size; }

export function registerSessionRestore(session: RestorableSession): void {
  liveRestores.add(session);
  installSignalHandlers();
}

export function deregisterSessionRestore(session: RestorableSession): void {
  liveRestores.delete(session);
}

async function restoreAll(): Promise<void> {
  for (const session of [...liveRestores]) {
    try { await session.restore(); } catch { /* each is independent; try them all */ }
    liveRestores.delete(session);
  }
}

function installSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  const bail = (signal: string, code: number) => async () => {
    if (!liveRestores.size) process.exit(code);
    process.stderr.write(`\n${signal}: restoring pre-state for ${liveRestores.size} session(s) before exit…\n`);
    await restoreAll();
    process.exit(code);
  };
  process.once('SIGINT', bail('SIGINT', 130));
  process.once('SIGTERM', bail('SIGTERM', 143));
  process.once('uncaughtException', async (e) => {
    process.stderr.write(`\nuncaught: ${(e as Error).message}\n`);
    if (liveRestores.size) {
      process.stderr.write('restoring pre-state before exit…\n');
      await restoreAll();
    }
    process.exit(1);
  });
}

/** The neutral dark frame the recorder parks on before the clock starts. */
export function holdPageUrl(): string {
  return pathToFileURL(skillAsset('hold.html')).toString();
}

export { TIMING };
