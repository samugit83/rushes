// Regression tests for the defects found in the hardening review.
//
// Each is named after the bug it prevents, so it cannot come back quietly.
// Every one of these FAILED before the corresponding fix; that is the only
// reason any of them is worth keeping.

import { test, assert, equal } from './harness.mjs';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// F1 — the value scrubber redacted the field the receipt exists to record.
//
// `resolveEnvRefs` registered EVERY expanded ${VAR} as a secret. `baseUrl` is
// almost always a ${VAR}, so the receipt recorded `"baseUrl": "[redacted]"` and
// every diagnostic URL came out mangled. The audit trail existed to answer
// "which target was filmed", and it answered "[redacted]".

await test('F1: expanding a non-secret ${VAR} does not redact it from the receipt', async () => {
  const { resolveEnvRefs } = await import('../lib/projectConfig.ts');
  const { scrub, resetSecrets } = await import('../lib/secrets.ts');
  resetSecrets();
  process.env.RUSHES_TEST_BASE = 'http://demo.internal:3000';
  const { value } = resolveEnvRefs({ baseUrl: '${RUSHES_TEST_BASE}' });
  equal(value.baseUrl, 'http://demo.internal:3000', 'the value must still expand');
  const receipt = scrub({ config: { baseUrl: value.baseUrl } });
  equal(receipt.config.baseUrl, 'http://demo.internal:3000',
    'the receipt must record which target was filmed, not "[redacted]"');
  resetSecrets();
});

await test('F1: a value in a SECRET position is still registered and scrubbed', async () => {
  const { scrub, registerSecret, resetSecrets } = await import('../lib/secrets.ts');
  resetSecrets();
  // This is what the auth strategies do at their own call sites, which is where
  // the knowledge that a value is a credential actually lives.
  registerSecret('a-real-signing-secret-value');
  const out = scrub({ evidence: { note: 'used a-real-signing-secret-value here' } });
  assert(!JSON.stringify(out).includes('a-real-signing-secret-value'),
    'a credential must never survive into a diagnostic');
  resetSecrets();
});

// ---------------------------------------------------------------------------
// F2 — `restoreAfter` never put the value back, and said nothing.
//
// The restore sent `{ theme: "light" }` to an endpoint whose contract is
// `{ featureKey, value }`. It 400'd, nothing checked the status, and the
// operator's preference stayed mutated with no message — which is the exact
// failure the crash-safe restore machinery was written to prevent.

function preferencesServer(store, seen) {
  return createServer((req, res) => {
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(store));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      seen.push({ method: req.method, body: parsed });
      // The real contract. Anything else is a 400, as it would be in the app.
      if (typeof parsed.featureKey !== 'string') {
        res.statusCode = 400;
        res.end('{"error":"featureKey required"}');
        return;
      }
      store[parsed.featureKey] = parsed.value;
      res.end('{"ok":true}');
    });
  });
}

async function withPreferences(fn) {
  const { chromium } = await import('playwright');
  const store = { theme: 'light' };
  const seen = [];
  const server = preferencesServer(store, seen);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext();
  try {
    return await fn({ store, seen, request: ctx.request, baseUrl: `http://127.0.0.1:${port}` });
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
    await new Promise((r) => server.close(r));
  }
}

await test('F2: restoreAfter puts the prior value back in the shape the app accepts', async () => {
  const { PreflightRunner } = await import('../lib/engine/preflight.ts');
  await withPreferences(async ({ store, request, baseUrl }) => {
    const runner = new PreflightRunner(request, { baseUrl });
    await runner.run([{
      method: 'PATCH', path: '/api/user/preferences',
      json: { featureKey: 'theme', value: 'dark' },
      restoreAfter: true, restoreKey: 'theme', restoreValuePath: 'value',
    }]);
    equal(store.theme, 'dark', 'the preflight must actually apply');
    await runner.restore();
    equal(store.theme, 'light', 'the prior value must be restored');
  });
});

await test('F2: a restore the app rejects is reported, never silent', async () => {
  // This isolates the STATUS check specifically. The compare-and-set must pass
  // (so it cannot be what produces the diagnostic) and the server must still
  // reject the restore — which is what a real endpoint does when the body is
  // wrong, and what used to go unnoticed because nobody read the status.
  const { chromium } = await import('playwright');
  const store = { theme: 'light' };
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(store));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      // Accept the set; reject the put-back. A read-only window, a revoked
      // permission or a validation rule all look like this.
      if (parsed.value === 'light') { res.statusCode = 403; res.end('{"error":"forbidden"}'); return; }
      store[parsed.featureKey] = parsed.value;
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext();
  try {
    const { PreflightRunner } = await import('../lib/engine/preflight.ts');
    const runner = new PreflightRunner(ctx.request, { baseUrl: `http://127.0.0.1:${server.address().port}` });
    await runner.run([{
      method: 'PATCH', path: '/api/user/preferences',
      json: { featureKey: 'theme', value: 'dark' },
      restoreAfter: true, restoreKey: 'theme', restoreValuePath: 'value',
    }]);
    equal(store.theme, 'dark', 'the set applied, so the compare-and-set will pass');
    await runner.restore();
    equal(store.theme, 'dark', 'the app refused the restore, so the pre-state is still changed');
    const conflicts = runner.diagnostics.filter((d) => d.code === 'preflight/restore-conflict');
    assert(conflicts.length > 0,
      `a rejected restore must be reported; got ${JSON.stringify(runner.diagnostics.map((d) => d.code))}`);
    assert(/403/.test(JSON.stringify(conflicts[0])),
      'and the diagnostic must carry the status the app answered with');
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
    await new Promise((r) => server.close(r));
  }
});

await test('F2: the restore is a compare-and-set, and aborts when the value moved', async () => {
  const { PreflightRunner } = await import('../lib/engine/preflight.ts');
  await withPreferences(async ({ store, request, baseUrl }) => {
    const runner = new PreflightRunner(request, { baseUrl });
    await runner.run([{
      method: 'PATCH', path: '/api/user/preferences',
      json: { featureKey: 'theme', value: 'dark' },
      restoreAfter: true, restoreKey: 'theme', restoreValuePath: 'value',
    }]);
    // Somebody else writes after us. Restoring "light" now would silently throw
    // their change away, which is the lost-update this guard exists to stop.
    store.theme = 'solarized';
    await runner.restore();
    equal(store.theme, 'solarized', 'a concurrent write must not be clobbered');
    assert(runner.diagnostics.some((d) => d.code === 'preflight/restore-conflict'),
      'and the abort must be reported');
  });
});

// ---------------------------------------------------------------------------
// F5 — the credential check could never fail.
//
// The engine emitted `external/credential-leak` only at severity `warning`; the
// check counted only `error`. It passed unconditionally, which is worse than not
// having it: a green line that measured nothing.

await test('F5: external_credential_free actually fails when a credential would travel', async () => {
  const { runChecks } = await import('../lib/check/index.ts');
  const base = {
    profile: 'showcase',
    story: { schemaVersion: 1, id: 'x', feature: 'x', scenes: [{ id: 'a', narration: 'n', steps: [] }],
             opening: { kicker: '', title: '', subtitle: '', disclaimer: '', narration: 'o' },
             closing: { title: '', subtitle: '', narration: 'c' } },
    config: { baseUrl: 'http://127.0.0.1' },
    mp4: '/nonexistent.mp4',
    timeline: [{ sceneId: 'a', startMs: 0, endMs: 1000, narration: 'n', audioPath: '/x.mp3', audioDurationMs: 900 }],
    introDurationMs: 0,
    publishConsent: 'yes',
  };
  const clean = runChecks({ ...base, problems: [] });
  assert(clean.checks.find((c) => c.name === 'external_credential_free').ok,
    'with no leak the check passes');

  const leaked = runChecks({
    ...base,
    problems: [{ code: 'external/credential-leak', severity: 'error', message: 'a bearer token would reach github.com',
                 subject: {}, evidence: {}, supportedFixes: [] }],
  });
  assert(!leaked.checks.find((c) => c.name === 'external_credential_free').ok,
    'a credential that would cross the boundary must fail the check');
});

// ---------------------------------------------------------------------------
// F6 — two checks reported a pass they never measured.

await test('F6: receipt_auditable measures the receipt instead of asserting true', async () => {
  const { runChecks } = await import('../lib/check/index.ts');
  const story = { schemaVersion: 1, id: 'x', feature: 'x', scenes: [{ id: 'a', narration: 'n', steps: [] }],
                  opening: { kicker: '', title: '', subtitle: '', disclaimer: '', narration: 'o' },
                  closing: { title: '', subtitle: '', narration: 'c' } };
  const base = {
    profile: 'showcase', story, config: { baseUrl: 'http://127.0.0.1', auth: { kind: 'storage-state' } },
    mp4: '/nonexistent.mp4',
    timeline: [{ sceneId: 'a', startMs: 0, endMs: 1000, narration: 'n', audioPath: '/x.mp3', audioDurationMs: 900 }],
    introDurationMs: 0, problems: [],
  };
  // No consent recorded and no identity resolved: the receipt would not be
  // reconstructable, so the check must say so.
  const bad = runChecks({ ...base, publishConsent: null, identity: null });
  assert(!bad.checks.find((c) => c.name === 'receipt_auditable').ok,
    'a receipt missing its auditable fields must fail the check');

  // A genuinely complete receipt: consent, the identity that recorded, and the
  // host actually contacted with the address it resolved to. All three are what
  // "which target was filmed, as whom, with whose approval" is made of.
  const good = runChecks({
    ...base,
    publishConsent: 'yes, a seeded demo tenant',
    identity: 'recorder@example',
    hostsContacted: [{ host: '127.0.0.1', ip: '127.0.0.1', external: false }],
  });
  const row = good.checks.find((c) => c.name === 'receipt_auditable');
  assert(row.ok, `a complete receipt passes; instead: ${JSON.stringify(row.details)}`);

  // And each field is load-bearing on its own, not just in aggregate.
  const noHost = runChecks({ ...base, publishConsent: 'yes', identity: 'recorder@example' });
  assert(!noHost.checks.find((c) => c.name === 'receipt_auditable').ok,
    'a receipt that does not say which host was contacted is not reconstructable');
});

// ---------------------------------------------------------------------------
// F10 — the hand-rolled IPv6 matcher missed real internal addresses.
//
// `0:0:0:0:0:0:0:1` is loopback written the long way, and a NAT64 prefix carries
// an IPv4 address inside an IPv6 one. Both were classified as public.

await test('F10: every written form of IPv6 loopback is blocked', async () => {
  const { isInternalIp, STRICT_POLICY } = await import('../lib/egress.ts');
  for (const ip of ['::1', '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001']) {
    assert(isInternalIp(ip, STRICT_POLICY), `${ip} must be classified as internal`);
  }
});

await test('F10: NAT64-embedded internal addresses are blocked', async () => {
  const { isInternalIp, STRICT_POLICY } = await import('../lib/egress.ts');
  assert(isInternalIp('64:ff9b::7f00:1', STRICT_POLICY), 'NAT64 of 127.0.0.1 must be internal');
  assert(isInternalIp('64:ff9b::a00:1', STRICT_POLICY), 'NAT64 of 10.0.0.1 must be internal');
});

await test('F10: genuinely public addresses stay reachable', async () => {
  const { isInternalIp, STRICT_POLICY } = await import('../lib/egress.ts');
  for (const ip of ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946', '8.8.8.8']) {
    assert(!isInternalIp(ip, STRICT_POLICY), `${ip} must remain reachable`);
  }
});

// ---------------------------------------------------------------------------
// F7 — the crash-safe restore handler was installed once per PROCESS.
//
// `rehearse` boots twice. The second session got no handler, and the one that
// existed closed over the first session, so a Ctrl-C during pass two restored
// nothing.

await test('F7: every session registers its own restore, and closing deregisters it', async () => {
  const { pendingRestores, registerSessionRestore, deregisterSessionRestore } = await import('../lib/engine/session.ts');
  const a = { restore: async () => {} };
  const b = { restore: async () => {} };
  const before = pendingRestores();
  registerSessionRestore(a);
  registerSessionRestore(b);
  equal(pendingRestores(), before + 2, 'two live sessions, two registered restores');
  deregisterSessionRestore(a);
  deregisterSessionRestore(b);
  equal(pendingRestores(), before, 'closing a session deregisters it');
});

// ---------------------------------------------------------------------------
// F8 — `check` and `evidence` called the voice provider to recompute a duration
// they could have read off disk. A command that only measures must never spend.

await test('F8: the intro duration is persisted, so measuring never bills the voice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rushes-tl-'));
  try {
    const { readIntroDurationMs } = await import('../lib/cli/misc.ts');
    const path = join(dir, 'timeline.json');
    writeFileSync(path, JSON.stringify({ durationMs: 1000, leadTrimMs: 0, introDurationMs: 4321, timeline: [] }));
    equal(readIntroDurationMs(path), 4321, 'the recorded intro duration must be read back');
    writeFileSync(path, JSON.stringify({ durationMs: 1000, leadTrimMs: 0, timeline: [] }));
    equal(readIntroDurationMs(path), null, 'an old timeline without it reports null, so the caller can fall back');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F6b — making receipt_auditable real created a false failure in `check`.
//
// `check` re-runs the checker over what is on disk. It never collected the
// consent or the hosts itself, so a naive re-run reported them as absent and
// called a good delivery unreconstructable. It has to read the delivery's own
// record of how it was made.

await test('F6b: re-checking a delivery reads its receipt instead of inventing a failure', async () => {
  const { runChecks } = await import('../lib/check/index.ts');
  const story = { schemaVersion: 1, id: 'x', feature: 'x', scenes: [{ id: 'a', narration: 'n', steps: [] }],
                  opening: { kicker: '', title: '', subtitle: '', disclaimer: '', narration: 'o' },
                  closing: { title: '', subtitle: '', narration: 'c' } };
  const base = {
    profile: 'showcase', story, config: { baseUrl: 'http://127.0.0.1', auth: { kind: 'none' } },
    mp4: '/nonexistent.mp4',
    timeline: [{ sceneId: 'a', startMs: 0, endMs: 1000, narration: 'n', audioPath: '/x.mp3', audioDurationMs: 900 }],
    introDurationMs: 0, problems: [],
  };
  // What `check` now passes through from the receipt on disk.
  const fromReceipt = runChecks({
    ...base,
    publishConsent: 'recorded at delivery time',
    hostsContacted: [{ host: '127.0.0.1', ip: '127.0.0.1', external: false }],
  });
  assert(fromReceipt.checks.find((c) => c.name === 'receipt_auditable').ok,
    're-checking a complete delivery must not invent an auditability failure');
});

// ---------------------------------------------------------------------------
// F11 — `stopAfter` left the application running.
//
// The start command runs through a shell, so the child is `/bin/sh -c "..."` and
// the real server is its grandchild. Signalling the child killed the shell and
// reparented the server, which kept the port. The next run then binds nothing —
// or worse, films a STALE instance from a previous checkout, and nothing says so.

await test('F11: stopping the runner stops the app, not just the shell around it', async () => {
  const { startApp, grantConsent, configSha256 } = await import('../lib/runner/index.ts');
  const { join } = await import('node:path');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');

  const root = mkdtempSync(join(tmpdir(), 'rushes-runner-'));
  const previous = process.env.RUSHES_PROJECT_ROOT;
  process.env.RUSHES_PROJECT_ROOT = root;
  try {
    const port = 8799;
    const skillRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    const runner = {
      start: `node ${JSON.stringify(join(skillRoot, 'test', 'fixtures', 'static', 'server.mjs'))} ${port}`,
      cwd: skillRoot,
      readyWhen: { http: `http://127.0.0.1:${port}/`, status: 200 },
      timeoutMs: 20000,
      stopAfter: true,
    };
    const raw = JSON.stringify({ runner });
    grantConsent(configSha256(raw), runner);

    const app = await startApp(runner, raw, false);
    equal(app.diagnostics.map((d) => d.code), [], 'the app must start');

    const answering = async () => {
      try { const r = await fetch(`http://127.0.0.1:${port}/`); return r.ok; } catch { return false; }
    };
    assert(await answering(), 'the app must be reachable while it is running');

    await app.stop();
    // Give the signal a moment to take effect through the process group.
    for (let i = 0; i < 20 && await answering(); i++) await new Promise((r) => setTimeout(r, 150));
    assert(!(await answering()),
      `stopAfter must stop the app; it is still answering on ${port}`);
  } finally {
    if (previous === undefined) delete process.env.RUSHES_PROJECT_ROOT;
    else process.env.RUSHES_PROJECT_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

void readFileSync; void existsSync;

// ---------------------------------------------------------------------------
// The setup remedies. The rule under test is not "does it install things" but
// WHICH HALF IT IS WILLING TO RUN: a tool that runs `sudo` because you typed an
// unrelated command is executing privileged commands you never read.

// F12 — `doctor --fix` installed the engine's browser and the `chrome` probe
// looked only on PATH, so it reported success and then still said no browser was
// found. Two consumers, two different installs, one of them invisible to the
// check that was supposed to confirm it.

await test('F12: one browser install satisfies both the recorder and the renderers', async () => {
  const { findChrome, chromeSource, resetChromeCache } = await import('../lib/chrome.ts');
  resetChromeCache();
  const found = findChrome();
  assert(found, 'a browser must be findable when the engine has one');
  assert(['path', 'bundled'].includes(chromeSource()),
    'and the source must be reportable, so `doctor` can say which one it will use');
  // The renderers shell out to this path; if it is not a real executable they
  // fail at card-render time, long after setup claimed success.
  const { existsSync } = await import('node:fs');
  if (chromeSource() === 'bundled') {
    assert(existsSync(found), `the bundled path must be a real executable: ${found}`);
  }
  resetChromeCache();
});

await test('setup: the browser is auto-installable, ffmpeg is never run for you', async () => {
  const { browserRemedy, ffmpegRemedy } = await import('../lib/cli/remedies.ts');
  const browser = browserRemedy();
  assert(!browser.needsSudo, 'the browser goes into a user cache and must not need privileges');
  assert(!/\bsudo\b/.test(browser.command), `the browser command must not use sudo: ${browser.command}`);

  for (const pm of ['apt', 'dnf', 'pacman', 'zypper', 'apk']) {
    const remedy = ffmpegRemedy(pm);
    assert(remedy.needsSudo, `${pm} installs system-wide and must be flagged as privileged`);
    assert(/^sudo /.test(remedy.command), `${pm} must be presented as a sudo command: ${remedy.command}`);
  }
  // Homebrew installs into a prefix the user owns, so it is the exception.
  const brew = ffmpegRemedy('brew');
  assert(!brew.needsSudo, 'brew owns its prefix and must not be flagged privileged');
  assert(!/\bsudo\b/.test(brew.command), `brew must not be given a sudo prefix: ${brew.command}`);
});

await test('setup: the printed command matches the package manager, not the OS family', async () => {
  const { ffmpegRemedy } = await import('../lib/cli/remedies.ts');
  equal(ffmpegRemedy('apt').command, 'sudo apt install -y ffmpeg');
  equal(ffmpegRemedy('pacman').command, 'sudo pacman -S --noconfirm ffmpeg');
  equal(ffmpegRemedy('brew').command, 'brew install ffmpeg');
  // An unknown machine gets advice, never a command that would fail confusingly.
  const unknown = ffmpegRemedy('unknown');
  assert(!/^sudo /.test(unknown.command), 'do not invent a package manager');
  assert(unknown.note, 'and say why there is no exact command');
});

// The anti-scatter guardrail: running with no --project inside someone's repo
// must refuse rather than turning that repo into a rushes project. This is the
// single most common way the tool made a mess — a session ran it from a product
// checkout and rushes.config.json, demos/, slides/ and out/ rained down.
await test('a project command refuses to scatter into an existing repo', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'rushes.mjs');

  const repo = mkdtempSync(join(tmpdir(), 'rushes-repo-'));
  mkdirSync(join(repo, '.git')); // it looks like a checkout, not a rushes project
  try {
    const cleanEnv = { ...process.env };
    delete cleanEnv.RUSHES_PROJECT_ROOT; // exercise the true cwd fallback
    const r = spawnSync('node', [bin, 'init'], { cwd: repo, encoding: 'utf8', env: cleanEnv });
    const out = (r.stderr || '') + (r.stdout || '');
    assert(r.status !== 0, 'init must exit non-zero inside a foreign repo');
    assert(/will not scatter/.test(out), 'and say why, naming the scatter');
    assert(/--project/.test(out), 'and point at the --project escape hatch');
    assert(!existsSync(join(repo, 'rushes.config.json')), 'and write nothing into the repo');
    // The escape hatch itself must still work: --project into a clean dir.
    const proj = join(repo, 'nested-clean');
    const ok = spawnSync('node', [bin, 'init', '--project', proj], { encoding: 'utf8', env: cleanEnv });
    assert(ok.status === 0 && existsSync(join(proj, 'rushes.config.json')),
      '--project into a clean folder still works');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
