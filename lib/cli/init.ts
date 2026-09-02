// `rushes init`: probe the application and scaffold a config (P14).
//
// Small, and it is the difference between a skill someone tries once and a skill
// someone adopts. Detect what can be detected, write it, and leave a TODO marker
// for what cannot.
//
// NOTE the boundary this respects: `init` may DETECT a framework in order to
// scaffold, but the engine must never branch on one at run time. Readiness is
// measured. The moment there is an `if (isNextJs)` in the engine, portability is
// a claim rather than a property.

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from 'playwright';
import { configPath, type ProjectConfig } from '../projectConfig.ts';
import { projectRoot } from '../paths.ts';
import { classifyHost, LOCAL_APP_POLICY } from '../egress.ts';

interface Detected {
  framework: string | null;
  loginPath: string | null;
  csrfField: string | null;
  consentText: string | null;
  busySelector: string | null;
  colorScheme: 'dark' | 'light';
}

export async function init(baseUrl: string): Promise<number> {
  const path = configPath();
  if (existsSync(path)) {
    process.stderr.write(`${path} already exists; edit it rather than re-scaffolding.\n`);
    return 1;
  }

  let host = '';
  try { host = new URL(baseUrl).hostname; } catch {
    process.stderr.write(`"${baseUrl}" is not a URL.\n`);
    return 1;
  }
  const cls = await classifyHost(host, LOCAL_APP_POLICY);
  if (!cls.allowed) {
    process.stderr.write(`refusing to probe ${host}: ${cls.reason}\n`);
    return 1;
  }

  process.stderr.write(`probing ${baseUrl}…\n`);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  let detected: Detected = {
    framework: null, loginPath: null, csrfField: null,
    consentText: null, busySelector: null, colorScheme: 'dark',
  };

  try {
    const res = await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    const headers = res?.headers() ?? {};
    detected = await page.evaluate(() => {
      const has = (sel: string) => !!document.querySelector(sel);
      const form = document.querySelector('form[action*="login" i], form[action*="signin" i], form#login');
      const csrf = document.querySelector('input[name="csrfmiddlewaretoken"], input[name="authenticity_token"], input[name="_csrf"], input[name="csrf_token"]');
      const consent = [...document.querySelectorAll('button, a')]
        .map((e) => (e.textContent ?? '').trim())
        .find((t) => /accept|agree|got it|continue|allow all/i.test(t) && t.length < 40);
      const bg = getComputedStyle(document.body).backgroundColor;
      const dark = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
      const lum = dark ? (Number(dark[1]) + Number(dark[2]) + Number(dark[3])) / 3 : 255;
      return {
        framework: has('#__next') ? 'next' : has('[data-turbo-body], meta[name="csrf-param"]') ? 'rails'
          : has('script[src*="/static/admin/"]') ? 'django' : null,
        loginPath: form ? (form.getAttribute('action') || '/login') : null,
        csrfField: csrf ? csrf.getAttribute('name') : null,
        consentText: consent ?? null,
        busySelector: has('[aria-busy="true"]') ? '[aria-busy="true"]' : has('.spinner') ? '.spinner' : null,
        colorScheme: (lum < 128 ? 'dark' : 'light') as 'dark' | 'light',
      };
    });
    if (!detected.framework) {
      const server = String(headers.server ?? '');
      const powered = String(headers['x-powered-by'] ?? '');
      detected.framework = /gunicorn|wsgi/i.test(server) ? 'python'
        : /puma|passenger/i.test(server) ? 'rails'
        : /express|next/i.test(powered) ? 'node' : null;
    }
  } catch (e) {
    process.stderr.write(`  could not reach it: ${(e as Error).message}\n`);
    process.stderr.write('  scaffolding anyway with TODO markers.\n');
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  const config: ProjectConfig = {
    schemaVersion: 1,
    baseUrl,
    allowHosts: [host],
    auth: detected.loginPath
      ? { kind: 'storage-state', statePath: '.rushes/state.json', maxAgeHours: 168 }
      : { kind: 'none' },
    readiness: {
      quietMs: 500,
      timeoutMs: 20000,
      readySelector: null,
      busySelector: detected.busySelector,
    },
    colorScheme: detected.colorScheme,
    ...(detected.consentText ? { dismiss: [{ locator: { text: detected.consentText }, optional: true }] } : {}),
  };

  // Create the project folder if it does not exist yet, so
  // `rushes init --project ~/rushes-projects/my-app` works in one step instead
  // of failing on a missing directory.
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
  process.stderr.write(`\n✓ wrote ${path}\n`);
  process.stderr.write(`  framework:  ${detected.framework ?? 'not detected (the engine does not care)'}\n`);
  process.stderr.write(`  auth:       ${config.auth?.kind}${detected.loginPath ? `  (a login form was found at ${detected.loginPath})` : ''}\n`);
  if (detected.csrfField) process.stderr.write(`  csrf field: ${detected.csrfField}  (for auth.kind "form-login")\n`);
  process.stderr.write(`  dismiss:    ${detected.consentText ?? '(no consent banner found)'}\n`);
  process.stderr.write(`  scheme:     ${detected.colorScheme}\n`);
  process.stderr.write(`\nnext: ${config.auth?.kind === 'storage-state' ? 'rushes login' : 'write a storyboard in demos/'}\n`);
  process.stderr.write(`      see references/config-contract.md for everything else.\n\n`);
  void projectRoot;
  return 0;
}
