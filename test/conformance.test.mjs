// The framework conformance suite (P13).
//
// The claim is narrow and easy to overstate: "works with any framework". So
// state it, then build the harness that can falsify it. Three shapes, three
// auth strategies, three readiness profiles, one engine and one storyboard
// vocabulary.
//
// These fixtures are NOT Django and NOT Next.js, and the table says so. What
// they reproduce is the BEHAVIOUR that breaks a framework assumption: a full
// document per request with a CSRF form login, and an empty shell that fills in
// after a fetch. An engine that survives both survives the frameworks that have
// those shapes, and one that fails either fails them too.
//
// The fourth case is the one that matters most: an app that never settles must
// produce `readiness/timeout` naming the condition, not a video of a spinner.

import { test, assert, equal } from './harness.mjs';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome } from '../lib/chrome.ts';

const CASES = [
  {
    name: 'static site',
    proves: 'no framework at all; full page loads',
    module: './fixtures/static/server.mjs',
    auth: { kind: 'none' },
    readiness: { quietMs: 300, timeoutMs: 10000 },
    scenes: [{
      id: 'overview',
      narration: 'The overview lists the entries.',
      expect: [{ text: 'Entries' }, { text: 'INV-1001' }],
      steps: [
        { do: 'goto', path: '/' },
        { do: 'waitFor', text: 'Entries' },
        { do: 'type', css: '#q', value: 'operations' },
        { do: 'click', role: 'button', name: 'Apply filter' },
      ],
    }],
  },
  {
    name: 'server-rendered + CSRF form login',
    proves: 'the Django/Rails shape: a document per request, a hidden CSRF field, a session cookie',
    module: './fixtures/ssr/server.mjs',
    auth: {
      kind: 'form-login',
      path: '/accounts/login/',
      fields: { username: 'demo', password: 'demo' },
      csrfField: 'csrfmiddlewaretoken',
      submit: { role: 'button', name: 'Log in' },
      signedInWhen: { text: 'Sign out' },
    },
    readiness: { quietMs: 300, timeoutMs: 10000 },
    scenes: [{
      id: 'records',
      narration: 'The records table is behind the login.',
      expect: [{ text: 'REC-2001' }, { text: 'Sign out' }],
      steps: [{ do: 'goto', path: '/' }, { do: 'waitFor', text: 'Records' }],
    }],
  },
  {
    name: 'client-hydrated shell',
    proves: 'the SPA shape: an empty first document, content after a fetch, routes that never reload',
    module: './fixtures/spa/server.mjs',
    auth: { kind: 'none' },
    // The data arrives ~700 ms after first paint. A fixed 400 ms wait films the
    // shell; the settle predicate waits for the network to go quiet.
    readiness: { quietMs: 400, timeoutMs: 12000, busySelector: '[aria-busy="true"]' },
    scenes: [{
      id: 'list',
      narration: 'The console lists three items once its data arrives.',
      // The expect is asserted at the END of the scene, so it must describe the
      // state the route change leaves behind, not the one it started from.
      expect: [{ text: 'Detail for alpha' }],
      steps: [
        { do: 'goto', path: '/' },
        { do: 'waitFor', text: 'gamma' },
        { do: 'click', text: 'Detail', exact: true },
      ],
    }],
  },
];

function storyboard(scenes) {
  return {
    schemaVersion: 1,
    id: 'conformance',
    feature: 'the conformance fixture',
    opening: { kicker: 'TEST', title: 'T', subtitle: 'S', disclaimer: '', narration: 'One.' },
    scenes,
    closing: { title: 'T', subtitle: 'S', narration: 'Two.' },
  };
}

async function runCase(c) {
  const { serve } = await import(c.module);
  // An ephemeral port: a conformance run must not collide with a fixture someone
  // left running in another terminal, and a test that dies on EADDRINUSE tells
  // you nothing about the engine.
  const server = await serve(0);
  const port = server.address().port;
  const root = mkdtempSync(join(tmpdir(), 'rushes-conf-'));
  const previous = process.env.RUSHES_PROJECT_ROOT;
  process.env.RUSHES_PROJECT_ROOT = root;
  try {
    mkdirSync(join(root, 'demos'), { recursive: true });
    writeFileSync(join(root, 'rushes.config.json'), JSON.stringify({
      schemaVersion: 1,
      baseUrl: `http://127.0.0.1:${port}`,
      allowHosts: ['127.0.0.1'],
      auth: c.auth,
      readiness: c.readiness,
    }, null, 2));

    const { loadConfig } = await import('../lib/projectConfig.ts');
    const { boot } = await import('../lib/engine/session.ts');
    const { runStep } = await import('../lib/engine/actions.ts');
    const { resolveLocator } = await import('../lib/engine/locators.ts');

    const { config } = loadConfig(root);
    const story = storyboard(c.scenes);
    const session = await boot({ story, config, record: false, skipAsserts: true });
    const problems = [...session.diagnostics];
    try {
      for (const scene of story.scenes) {
        for (const step of scene.steps) {
          try { await runStep(session.stepContext, step); }
          catch (e) { problems.push({ code: 'step/failed', severity: 'error', message: e.message, subject: { do: step.do } }); }
        }
        for (const want of scene.expect ?? []) {
          const ok = await resolveLocator(session.page, want).isVisible({ timeout: 4000 }).catch(() => false);
          if (!ok) problems.push({ code: 'scene/expect-failed', severity: 'error', message: JSON.stringify(want), subject: {} });
        }
      }
    } finally {
      await session.close();
    }
    return problems.filter((p) => p.severity === 'error');
  } finally {
    if (previous === undefined) delete process.env.RUSHES_PROJECT_ROOT;
    else process.env.RUSHES_PROJECT_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
    await new Promise((r) => server.close(r));
  }
}

for (const c of CASES) {
  await test(`conformance: ${c.name} — ${c.proves}`, async () => {
    if (!findChrome()) { process.stderr.write('    · skipped: no browser on PATH\n'); return; }
    const errors = await runCase(c);
    equal(errors.map((e) => `${e.code}: ${e.message}`), [], `${c.name} produced errors`);
  });
}

await test('conformance: an app that never settles reports which condition failed', async () => {
  if (!findChrome()) { process.stderr.write('    · skipped: no browser on PATH\n'); return; }
  const { createServer } = await import('node:http');
  // Never goes quiet: a request every 100 ms, forever. This is the fourth
  // fixture, and the one that proves the engine refuses rather than filming a
  // spinner for four minutes.
  const server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/beacon')) { res.end('{}'); return; }
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><html><body><h1>Busy</h1><div aria-busy="true">forever</div>
      <script>setInterval(function(){fetch('/beacon')},100)</script></body></html>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const busyPort = server.address().port;

  const { settle } = await import('../lib/engine/readiness.ts');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${busyPort}/`, { waitUntil: 'domcontentloaded' });
    const r = await settle(page, { quietMs: 500, timeoutMs: 3000, busySelector: '[aria-busy="true"]' });
    assert(!r.settled, 'a page that never goes quiet must not report settled');
    assert(r.diagnostics.length === 1, 'it must say which condition failed');
    assert(['networkQuiet', 'busySelector'].includes(r.failed), `named "${r.failed}"`);
    assert(r.diagnostics[0].supportedFixes.length > 0, 'and offer a fix to pick from');
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});
