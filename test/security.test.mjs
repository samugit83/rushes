// The boundary tests. These need a real browser, because every one of them is
// about what the BROWSER does with a credential or a name — not about what the
// engine believes it does.

import { test, assert, equal } from './harness.mjs';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome } from '../lib/chrome.ts';

const skipIfNoBrowser = () => {
  if (findChrome()) return false;
  process.stderr.write('    · skipped: no browser on PATH\n');
  return true;
};

function html(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

function project(config) {
  const root = mkdtempSync(join(tmpdir(), 'rushes-sec-'));
  mkdirSync(join(root, 'demos'), { recursive: true });
  writeFileSync(join(root, 'rushes.config.json'), JSON.stringify(config, null, 2));
  return root;
}

async function withProjectRoot(root, fn) {
  const previous = process.env.RUSHES_PROJECT_ROOT;
  process.env.RUSHES_PROJECT_ROOT = root;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.RUSHES_PROJECT_ROOT;
    else process.env.RUSHES_PROJECT_ROOT = previous;
  }
}

const storyOf = (steps, expect = []) => ({
  schemaVersion: 1, id: 'sec', feature: 'security fixture',
  opening: { kicker: '', title: 't', subtitle: 's', disclaimer: '', narration: 'One.' },
  scenes: [{ id: 'only', narration: 'One scene.', steps, expect }],
  closing: { title: 't', subtitle: 's', narration: 'Two.' },
});

// ---------------------------------------------------------------------------
// F3 — `basic` credentials crossed the origin boundary.
//
// Playwright's httpCredentials is a CONTEXT option and is not origin-scoped.
// Stripping extraHTTPHeaders did nothing for it, so a third party that answers
// with a 401 Basic challenge received the operator's username and password in
// cleartext, base64 of `user:pass` and nothing more.

await test('F3: the boundary context answers a Basic challenge with nothing', async () => {
  if (skipIfNoBrowser()) return;
  const { chromium } = await import('playwright');
  const { CredentialBoundary } = await import('../lib/engine/navigation.ts');

  const seen = [];
  const third = await listen((req, res) => {
    seen.push(req.headers.authorization ?? null);
    if (!req.headers.authorization) {
      res.statusCode = 401;
      res.setHeader('www-authenticate', 'Basic realm="collect"');
      res.end('challenge');
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(html('<h1>Third party</h1>'));
  });

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    // The signed-in context, exactly as `auth.kind: "basic"` builds it.
    const app = await browser.newContext({ httpCredentials: { username: 'demo', password: 'hunter2' } });
    const page = await app.newPage();

    // First: prove the credential is real and that the mechanism is load-bearing
    // rather than decorative. Navigating the SIGNED-IN context at a challenging
    // third party hands over the password.
    await page.goto(`http://127.0.0.1:${third.port}/`).catch(() => {});
    await page.waitForTimeout(200);
    const viaAppContext = seen.filter(Boolean);
    assert(viaAppContext.length > 0,
      'the app context must answer the challenge, or this test proves nothing');
    equal(Buffer.from(viaAppContext[0].split(' ')[1], 'base64').toString(), 'demo:hunter2');

    // Now the boundary: a context that was never given the credential.
    seen.length = 0;
    const boundary = new CredentialBoundary(page, null, true);
    assert(boundary.hadCredentials, 'the boundary must know a credential is in play');
    const visit = await boundary.open({ width: 800, height: 600 });
    try {
      await visit.page.goto(`http://127.0.0.1:${third.port}/`).catch(() => {});
      await visit.page.waitForTimeout(200);
    } finally {
      await visit.close();
    }
    equal(seen.filter(Boolean), [],
      'the boundary context must have nothing to answer the challenge with');
    await app.close();
  } finally {
    await browser.close();
    await third.close();
  }
});

await test('F3: the boundary context carries no header credential and no cookies either', async () => {
  if (skipIfNoBrowser()) return;
  const { chromium } = await import('playwright');
  const { CredentialBoundary } = await import('../lib/engine/navigation.ts');

  const seen = [];
  const third = await listen((req, res) => {
    seen.push({ key: req.headers['x-api-key'] ?? null, cookie: req.headers.cookie ?? null });
    res.setHeader('content-type', 'text/html');
    res.end(html('<h1>Third</h1>'));
  });

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const app = await browser.newContext({ extraHTTPHeaders: { 'x-api-key': 'SECRET-HEADER-VALUE' } });
    await app.addCookies([{ name: 'sid', value: 'SESSION-VALUE', domain: '127.0.0.1', path: '/' }]);
    const page = await app.newPage();

    const boundary = new CredentialBoundary(page, { 'x-api-key': 'SECRET-HEADER-VALUE' }, false);
    assert(boundary.hadCredentials, 'a header credential counts as a credential in play');
    const visit = await boundary.open({ width: 800, height: 600 });
    try {
      await visit.page.goto(`http://127.0.0.1:${third.port}/`).catch(() => {});
      await visit.page.waitForTimeout(200);
    } finally {
      await visit.close();
    }
    equal(seen.map((r) => r.key).filter(Boolean), [], 'no header credential may cross');
    equal(seen.map((r) => r.cookie).filter(Boolean), [], 'and no session cookie either');
    await app.close();
  } finally {
    await browser.close();
    await third.close();
  }
});

await test('F3: an off-origin host that is not allow-listed is refused before any request', async () => {
  if (skipIfNoBrowser()) return;
  const seen = [];
  const app = await listen((req, res) => { res.setHeader('content-type', 'text/html'); res.end(html('<h1>App</h1>')); });
  const third = await listen((req, res) => { seen.push(req.url); res.end('should never be reached'); });

  const root = project({
    schemaVersion: 1,
    baseUrl: `http://127.0.0.1:${app.port}`,
    allowHosts: ['127.0.0.1'],
    auth: { kind: 'none' },
    readiness: { quietMs: 200, timeoutMs: 8000 },
    // No `external` block at all: off-origin navigation is forbidden by default.
  });

  try {
    await withProjectRoot(root, async () => {
      const { loadConfig } = await import('../lib/projectConfig.ts');
      const { boot } = await import('../lib/engine/session.ts');
      const { runStep } = await import('../lib/engine/actions.ts');
      const { config } = loadConfig(root);
      const session = await boot({ story: storyOf([{ do: 'goto', path: '/' }]), config, record: false, skipAsserts: true });
      let refused = false;
      try {
        await runStep(session.stepContext, { do: 'goto', external: `http://127.0.0.1:${third.port}/` });
      } catch { refused = true; }
      assert(refused, 'an un-allow-listed external host must be refused');
      equal(seen, [], 'and no request may be made to it');
      assert(session.stepContext.diagnostics.some((d) => d.code === 'external/host-not-allowed'),
        'the refusal must be a named diagnostic');
      await session.close();
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    await app.close();
    await third.close();
  }
});

await test('F3: an off-origin page stays interactive, so a scroll is not a no-op', async () => {
  if (skipIfNoBrowser()) return;
  // A shipped storyboard navigates to a public wiki and scrolls it four times.
  // Filming that as ONE screenshot would have turned every later step into a
  // no-op and produced ten seconds of a still image with nothing saying so.
  const { chromium } = await import('playwright');
  const { CredentialBoundary } = await import('../lib/engine/navigation.ts');
  const { repaintExternal, closeExternalVisit } = await import('../lib/engine/actions.ts');

  const tall = await listen((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(html('<div style="height:4000px">'
      + '<p id="top">top of the page</p>'
      + '<p id="bottom" style="margin-top:3600px">bottom of the page</p></div>'));
  });
  const app = await listen((req, res) => { res.setHeader('content-type', 'text/html'); res.end(html('<h1>App</h1>')); });

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${app.port}/`);

    const ctx = { page, config: {}, diagnostics: [], externalVisit: null };
    const visit = await new CredentialBoundary(page, null, false).open({ width: 800, height: 600 });
    ctx.externalVisit = visit;
    await visit.page.goto(`http://127.0.0.1:${tall.port}/`);

    const before = await visit.page.evaluate(() => window.scrollY);
    await visit.page.mouse.wheel(0, 1200);
    await visit.page.waitForTimeout(300);
    const after = await visit.page.evaluate(() => window.scrollY);
    assert(after > before, `a scroll must move the off-origin page: ${before} -> ${after}`);

    // And the recording must show the moved page, not the first frame.
    await repaintExternal(ctx);
    const painted = await page.evaluate(() => {
      const img = document.querySelector('#__rushes_external__ img');
      return img ? img.getAttribute('src').length : 0;
    });
    assert(painted > 1000, 'the scrolled page must be painted into the recording');

    await closeExternalVisit(ctx);
    const gone = await page.evaluate(() => !document.getElementById('__rushes_external__'));
    assert(gone, 'the overlay must come down when the visit ends');
    await context.close();
  } finally {
    await browser.close();
    await tall.close();
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// F4 — a schema-valid storyboard could escape the recording loop.
//
// `expect: [{ "nth": 0 }]` satisfies the schema (minProperties is 1) but has no
// addressable field, so resolveLocator throws. The scene loop had no
// try/finally, so the browser was never closed and the preflight restore never
// ran — leaving the operator's preferences mutated with no message.

await test('F4: a locator with no addressable field cannot leak the browser or the pre-state', async () => {
  if (skipIfNoBrowser()) return;
  // A real store, not a stub that always answers the same thing: the restore is
  // a compare-and-set, so a fake that never applies the write looks exactly like
  // a concurrent writer and the restore correctly refuses.
  const prefs = { theme: 'light' };
  const writes = [];
  const app = await listen((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/api/prefs')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(prefs));
      return;
    }
    if (req.method === 'PATCH') {
      let b = ''; req.on('data', (c) => { b += c; });
      req.on('end', () => {
        const body = JSON.parse(b || '{}');
        writes.push(body);
        if (typeof body.featureKey === 'string') prefs[body.featureKey] = body.value;
        res.end('{"ok":true}');
      });
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(html('<h1>App</h1>'));
  });

  const root = project({
    schemaVersion: 1,
    baseUrl: `http://127.0.0.1:${app.port}`,
    allowHosts: ['127.0.0.1'],
    auth: { kind: 'none' },
    readiness: { quietMs: 200, timeoutMs: 8000 },
    preflight: [{ method: 'PATCH', path: '/api/prefs', json: { featureKey: 'theme', value: 'dark' },
                  restoreAfter: true, restoreKey: 'theme', restoreValuePath: 'value' }],
  });

  try {
    await withProjectRoot(root, async () => {
      const { loadConfig } = await import('../lib/projectConfig.ts');
      const { record } = await import('../lib/engine/driver.ts');
      const { config } = loadConfig(root);
      // `nth` alone is schema-valid and unaddressable: the exact shape that escaped.
      const story = storyOf([{ do: 'goto', path: '/' }], [{ nth: 0 }]);
      story.scenes[0].audio = { path: '', durationMs: 0 };

      let threw = null;
      try {
        const result = await record({ story, config });
        assert(result.problems.some((p) => p.severity === 'error'),
          'an unaddressable expect must be reported as a diagnostic');
      } catch (e) {
        threw = e;
      }
      assert(!threw, `the recording loop must not throw out: ${threw?.message}`);
      // The pre-state must have been put back whatever happened inside the loop.
      assert(writes.length >= 2, `the restore must run; saw ${writes.length} PATCH(es)`);
      equal(prefs.theme, 'light', 'the operator\'s preference must be back where it was');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// F9 — the resolved address was recorded but never used.
//
// The classifier resolved a name, checked every address, and pinned one. Then
// the browser navigated by NAME and resolved it again. A name that answers
// public once and internal the second time — DNS rebinding — walked straight
// through, while the docs claimed the address was pinned for the connection.

await test('F9: the resolved address is turned into resolver rules', async () => {
  const { resolvedHostRules } = await import('../lib/engine/session.ts');
  // The pin is always on: this is the rebinding fix.
  const rules = await resolvedHostRules({ baseUrl: 'http://localhost:8787' });
  assert(typeof rules === 'string', 'the launcher must produce host-resolver rules');
  assert(/MAP localhost 127\.0\.0\.1/.test(rules),
    `the app host must be pinned to the address that passed; got: ${rules}`);
  assert(!/~NOTFOUND/.test(rules),
    'the deny-all catch-all must be opt-in, so a normal recording is not broken');

  // The catch-all is opt-in, and must come LAST because the first match wins.
  const strict = await resolvedHostRules({ baseUrl: 'http://localhost:8787', egress: { strictSubresources: true } });
  assert(/MAP \* ~NOTFOUND$/.test(strict),
    `the catch-all must come last, or the first-match rule makes it dead: ${strict}`);
});

await test('F9: a name the classifier never approved cannot be resolved by the browser', async () => {
  if (skipIfNoBrowser()) return;
  const os = await import('node:os');
  const dns = await import('node:dns/promises');

  // A second name for this machine, resolvable from /etc/hosts and therefore
  // deterministic without any network. It is NOT the app host, so the pinning
  // must make it unreachable — which is the whole point: a name that was never
  // classified cannot be reached, so it cannot rebind into one that was.
  const otherName = os.hostname();
  let resolvable = false;
  try { await dns.lookup(otherName); resolvable = true; } catch { /* fall through */ }
  if (!resolvable) {
    process.stderr.write('    · skipped: this machine has no second locally-resolvable name\n');
    return;
  }

  // Bound to every interface, so the second name reaches it too when it is
  // allowed to resolve. Without that the test could not tell "excluded by the
  // pinning" from "nothing listening there".
  const server = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(html('<h1>App</h1>')); });
  await new Promise((r) => server.listen(0, '0.0.0.0', r));
  const port = server.address().port;

  const root = project({
    schemaVersion: 1,
    baseUrl: `http://localhost:${port}`,
    allowHosts: ['localhost'],
    egress: { strictSubresources: true },
    auth: { kind: 'none' },
    readiness: { quietMs: 200, timeoutMs: 8000 },
  });

  const reach = (page, url) => page.evaluate(async (u) => {
    try { const r = await fetch(u, { mode: 'no-cors' }); return { ok: true, status: r.status }; }
    catch (e) { return { ok: false, error: String(e) }; }
  }, url);

  try {
    await withProjectRoot(root, async () => {
      const { loadConfig } = await import('../lib/projectConfig.ts');
      const { boot } = await import('../lib/engine/session.ts');
      const { chromium } = await import('playwright');
      const { config } = loadConfig(root);

      // First, prove the discriminator: an UNPINNED browser reaches the second
      // name. Without this the assertion below could pass for any reason.
      const plain = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
      const plainPage = await plain.newPage();
      await plainPage.goto(`http://localhost:${port}/`);
      const baseline = await reach(plainPage, `http://${otherName}:${port}/`);
      await plain.close();
      assert(baseline.ok, `an unpinned browser must reach ${otherName}; got ${JSON.stringify(baseline)}`);

      // Now the recording browser, launched through boot().
      const session = await boot({ story: storyOf([{ do: 'goto', path: '/' }]), config, record: false, skipAsserts: true });
      try {
        assert(session.hostRules, 'the session must report the pinning it applied');
        assert(/App/.test(await session.page.content()), 'the app must still load through the pinned address');
        const pinned = await reach(session.page, `http://${otherName}:${port}/`);
        assert(!pinned.ok,
          `an unclassified name must not resolve inside the recording browser; got ${JSON.stringify(pinned)}`);
      } finally {
        await session.close();
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    await new Promise((r) => server.close(r));
  }
});

void existsSync; void readFileSync;
