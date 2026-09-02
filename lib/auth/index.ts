// Six interchangeable ways into an application, behind one interface. The
// engine knows only `apply(context)`; which one runs is a config decision.
//
// `storage-state` is the universal answer and the recommended default: the user
// signs in by hand once, however their app requires (password manager, TOTP,
// SSO), and the skill saves the resulting cookies + localStorage. It works with
// Django sessions, Rails, Laravel, Next.js and anything else, and the skill
// never sees the credential (principle 13).
//
// SP5: no screenshot is taken while a strategy is running, and never of a page
// whose URL matches the configured login path — a screenshot cannot be redacted.
// SP6: the state file is a bearer credential; it is written 0600, never copied
// into out/, and never enters the packaged payload.

import { readFileSync, existsSync, writeFileSync, statSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { createHmac } from 'node:crypto';
import type { BrowserContext, Page } from 'playwright';
import type { AuthConfig, ProjectConfig } from '../projectConfig.ts';
import { projectRoot, statePaths } from '../paths.ts';
import { registerSecret } from '../secrets.ts';
import { type Diagnostic, diag } from '../diagnostics.ts';
import { resolveLocator } from '../engine/locators.ts';

export interface AuthApplyResult {
  diagnostics: Diagnostic[];
  /** Context-wide credentials that must be stripped at an origin boundary (SP11). */
  contextCredentials: { headers?: Record<string, string>; basic?: { username: string; password: string } } | null;
  /** Who the recording will be acting as, for the receipt (SP8) and CF3. */
  identity: string | null;
}

export interface AuthStrategy {
  readonly kind: string;
  /** Applied to a fresh context before the first navigation. */
  apply(context: BrowserContext, config: ProjectConfig): Promise<AuthApplyResult>;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** HS256 over the configured claims. Kept here so `jwt-cookie` is one adapter. */
export function mintToken(claims: Record<string, unknown>, secret: string, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ ...claims, iat: now, exp: now + ttlSeconds }));
  const data = `${header}.${payload}`;
  return `${data}.${b64url(createHmac('sha256', secret).update(data).digest())}`;
}

export function statePathOf(auth: AuthConfig | undefined): string {
  const p = auth?.statePath;
  if (!p) return statePaths().browserState;
  return isAbsolute(p) ? p : join(projectRoot(), p);
}

const ok = (identity: string | null = null, creds: AuthApplyResult['contextCredentials'] = null): AuthApplyResult =>
  ({ diagnostics: [], contextCredentials: creds, identity });

class NoneStrategy implements AuthStrategy {
  readonly kind = 'none';
  async apply(): Promise<AuthApplyResult> { return ok('anonymous'); }
}

class StorageStateStrategy implements AuthStrategy {
  readonly kind = 'storage-state';
  async apply(context: BrowserContext, config: ProjectConfig): Promise<AuthApplyResult> {
    const auth = config.auth!;
    const path = statePathOf(auth);
    if (!existsSync(path)) {
      return {
        diagnostics: [diag('auth/state-missing', 'error', `no saved browser state at ${path}`, { path }, {},
          ['run `rushes login` and sign in once', 'set auth.kind to "none" for a public site'])],
        contextCredentials: null, identity: null,
      };
    }
    const ageHours = (Date.now() - statSync(path).mtimeMs) / 3_600_000;
    const maxAge = auth.maxAgeHours ?? 168;
    if (ageHours > maxAge) {
      // Filming a logged-out app produces a complete, correctly narrated video
      // of a login screen. Refuse instead.
      return {
        diagnostics: [diag('auth/state-expired', 'error',
          `saved state is ${ageHours.toFixed(0)}h old, over the ${maxAge}h limit`, { path },
          { ageHours: Math.round(ageHours), maxAgeHours: maxAge },
          ['run `rushes login` again', 'raise auth.maxAgeHours if the session really lasts longer'])],
        contextCredentials: null, identity: null,
      };
    }
    const state = JSON.parse(readFileSync(path, 'utf8')) as {
      cookies?: Parameters<BrowserContext['addCookies']>[0];
      origins?: { origin: string; localStorage?: { name: string; value: string }[] }[];
    };
    for (const c of state.cookies ?? []) registerSecret(String((c as { value?: string }).value ?? ''));
    if (state.cookies?.length) await context.addCookies(state.cookies);
    for (const origin of state.origins ?? []) {
      const entries = origin.localStorage ?? [];
      if (!entries.length) continue;
      await context.addInitScript(({ o, items }) => {
        if (location.origin !== o) return;
        try { for (const it of items) localStorage.setItem(it.name, it.value); } catch { /* storage disabled */ }
      }, { o: origin.origin, items: entries });
    }
    return ok(`storage-state:${path}`);
  }
}

class JwtCookieStrategy implements AuthStrategy {
  readonly kind = 'jwt-cookie';
  async apply(context: BrowserContext, config: ProjectConfig): Promise<AuthApplyResult> {
    const auth = config.auth!;
    const secret = auth.secretEnv ? process.env[auth.secretEnv] : undefined;
    if (!auth.cookie || !auth.secretEnv) {
      return { diagnostics: [diag('auth/strategy-unsupported', 'error',
        'jwt-cookie needs both "cookie" and "secretEnv"', { kind: 'jwt-cookie' }, {},
        ['set auth.cookie to the cookie name', 'set auth.secretEnv to the env var holding the signing secret'])],
        contextCredentials: null, identity: null };
    }
    if (!secret) {
      return { diagnostics: [diag('config/env-ref-unresolved', 'error',
        `${auth.secretEnv} is not set in the environment`, { variable: auth.secretEnv }, {},
        [`export ${auth.secretEnv}`, 'switch to auth.kind "storage-state" and run `rushes login`'])],
        contextCredentials: null, identity: null };
    }
    registerSecret(secret);
    const token = mintToken(auth.claims ?? {}, secret, auth.ttlSeconds ?? 3 * 3600);
    registerSecret(token);
    const url = new URL(config.baseUrl);
    await context.addCookies([{
      name: auth.cookie, value: token, domain: url.hostname, path: '/',
      httpOnly: true, sameSite: 'Lax',
    }]);
    const sub = (auth.claims ?? {}).sub;
    return ok(typeof sub === 'string' ? sub : `jwt:${auth.cookie}`);
  }
}

class BasicStrategy implements AuthStrategy {
  readonly kind = 'basic';
  async apply(_context: BrowserContext, config: ProjectConfig): Promise<AuthApplyResult> {
    const auth = config.auth!;
    if (!auth.user || !auth.pass) {
      return { diagnostics: [diag('auth/strategy-unsupported', 'error', 'basic needs "user" and "pass"',
        { kind: 'basic' }, {}, ['set auth.user and auth.pass, both as ${ENV_VAR} references'])],
        contextCredentials: null, identity: null };
    }
    registerSecret(auth.pass);
    // Applied when the context is created, not here: Playwright's
    // httpCredentials is a context option, and it is unscoped, which is exactly
    // why it must be stripped at an origin boundary (SP11 / F32).
    return ok(auth.user, { basic: { username: auth.user, password: auth.pass } });
  }
}

class HeaderStrategy implements AuthStrategy {
  readonly kind = 'header';
  async apply(context: BrowserContext, config: ProjectConfig): Promise<AuthApplyResult> {
    const auth = config.auth!;
    if (!auth.name || !auth.value) {
      return { diagnostics: [diag('auth/strategy-unsupported', 'error', 'header needs "name" and "value"',
        { kind: 'header' }, {}, ['set auth.name and auth.value, the value as ${ENV_VAR}'])],
        contextCredentials: null, identity: null };
    }
    registerSecret(auth.value);
    await context.setExtraHTTPHeaders({ [auth.name]: auth.value });
    return ok(`header:${auth.name}`, { headers: { [auth.name]: auth.value } });
  }
}

class FormLoginStrategy implements AuthStrategy {
  readonly kind = 'form-login';
  async apply(context: BrowserContext, config: ProjectConfig): Promise<AuthApplyResult> {
    const auth = config.auth!;
    if (!auth.path || !auth.fields) {
      return { diagnostics: [diag('auth/strategy-unsupported', 'error', 'form-login needs "path" and "fields"',
        { kind: 'form-login' }, {}, ['set auth.path to the login route', 'set auth.fields to the input names'])],
        contextCredentials: null, identity: null };
    }
    for (const v of Object.values(auth.fields)) registerSecret(v);
    // A separate page, closed before recording starts: SP5 forbids screenshotting
    // a login surface, and the simplest guarantee is that it never coexists with
    // the recorded page.
    const page = await context.newPage();
    const diagnostics: Diagnostic[] = [];
    try {
      await page.goto(new URL(auth.path, config.baseUrl).toString(), { waitUntil: 'domcontentloaded' });
      if (auth.csrfField) {
        const token = await page.locator(`[name="${auth.csrfField}"]`).first()
          .getAttribute('value').catch(() => null);
        if (!token) {
          diagnostics.push(diag('auth/csrf-token-missing', 'error',
            `no field named "${auth.csrfField}" on ${auth.path}`, { field: auth.csrfField }, { url: page.url() },
            ['check the field name in the rendered form', 'remove auth.csrfField if the app does not use one']));
        }
      }
      for (const [name, value] of Object.entries(auth.fields)) {
        await page.locator(`[name="${name}"]`).first().fill(value);
      }
      if (auth.submit) await resolveLocator(page, auth.submit).click();
      else await page.keyboard.press('Enter');
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    } catch (e) {
      diagnostics.push(diag('auth/not-signed-in', 'error', `form login failed: ${(e as Error).message}`,
        { path: auth.path }, {}, ['check the field names', 'switch to auth.kind "storage-state"']));
    } finally {
      await page.close().catch(() => {});
    }
    const user = auth.fields.username ?? auth.fields.user ?? auth.fields.email ?? null;
    return { diagnostics, contextCredentials: null, identity: user };
  }
}

const STRATEGIES: Record<string, AuthStrategy> = {
  none: new NoneStrategy(),
  'storage-state': new StorageStateStrategy(),
  'form-login': new FormLoginStrategy(),
  'jwt-cookie': new JwtCookieStrategy(),
  basic: new BasicStrategy(),
  header: new HeaderStrategy(),
};

export function strategyFor(config: ProjectConfig): AuthStrategy | Diagnostic {
  const kind = config.auth?.kind ?? 'none';
  const s = STRATEGIES[kind];
  if (!s) {
    return diag('auth/strategy-unsupported', 'error', `unknown auth strategy "${kind}"`, { kind },
      { supported: Object.keys(STRATEGIES) }, Object.keys(STRATEGIES).map((k) => `use auth.kind "${k}"`));
  }
  return s;
}

/**
 * Confirm the app is actually signed in after the strategy ran. Without this a
 * recording of a login screen is a complete, correctly narrated video of the
 * wrong thing.
 */
export async function verifySignedIn(page: Page, config: ProjectConfig): Promise<Diagnostic[]> {
  const auth = config.auth;
  if (!auth || auth.kind === 'none') return [];
  const out: Diagnostic[] = [];
  if (auth.signedOutWhen) {
    const visible = await resolveLocator(page, auth.signedOutWhen).isVisible({ timeout: 1500 }).catch(() => false);
    if (visible) {
      out.push(diag('auth/not-signed-in', 'error', 'the app still presents a sign-in surface', { url: page.url() },
        { signedOutWhen: auth.signedOutWhen },
        ['run `rushes login` again', 'check the credentials the strategy uses']));
    }
  }
  if (auth.signedInWhen) {
    const visible = await resolveLocator(page, auth.signedInWhen).isVisible({ timeout: 4000 }).catch(() => false);
    if (!visible) {
      out.push(diag('auth/not-signed-in', 'error', 'the signed-in marker never appeared', { url: page.url() },
        { signedInWhen: auth.signedInWhen },
        ['run `rushes login` again', 'correct auth.signedInWhen to something the signed-in app shows']));
    }
  }
  return out;
}

/** Write a captured browser state 0600 (SP6). */
export function writeState(path: string, json: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, json, { mode: 0o600 });
  chmodSync(path, 0o600);
}
