// Where a recording is allowed to point the browser (P16, SP11).
//
// External navigation is a real, shipped capability: a video may film a public
// GitHub wiki, a docs site or a release page. What it must not be is an
// accident of a regex. Before this module, ANY absolute URL was passed through
// unscoped, which accepted `file:///home/you/.ssh/id_rsa`, `file:///etc/passwd`,
// `http://169.254.169.254/latest/meta-data/` and `http://localhost:7474/browser/`
// — and everything it reached was recorded into a video destined for YouTube.
//
// Four rules, none of them configurable away:
//
//   1. An off-origin host must be in `external.allow` AND pass the resolved-IP
//      classification. Two allowlists, two purposes (CF9): `allowHosts` governs
//      the application origin, `external.allow` governs leaving it. Neither
//      widens the other.
//   2. Credentials are stripped at the origin boundary. Cookies and localStorage
//      are already origin-scoped; `extraHTTPHeaders` and `httpCredentials` are
//      not, and a scene that visits a third party would otherwise hand them the
//      bearer token (F32).
//   3. Every redirect hop is re-classified with its own pinned address. An
//      allowed public host that redirects into a private range or to the
//      instance metadata service is refused mid-flight; checking only the
//      entered URL does not close redirect or rebinding bypasses.
//   4. `file://` is allowed by PATH, not by scheme: only files inside the
//      compiled slide directory, with `..`, symlinks and absolute escapes
//      resolved first.

import { realpathSync, existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Response as PwResponse } from 'playwright';
import { type Diagnostic, diag } from '../diagnostics.ts';
import { classifyHost, hostAllowed, LOCAL_APP_POLICY, STRICT_POLICY } from '../egress.ts';
import type { ProjectConfig } from '../projectConfig.ts';
import { slidePaths } from '../paths.ts';
import { CASE_INSENSITIVE_FS } from '../platform.ts';

export type Destination =
  | { kind: 'app'; url: string; host: string }
  | { kind: 'external'; url: string; host: string }
  | { kind: 'file'; url: string; path: string };

export interface NavDecision {
  allowed: boolean;
  destination: Destination | null;
  pinnedIp: string | null;
  diagnostics: Diagnostic[];
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export function isAbsoluteUrl(s: string): boolean { return SCHEME.test(s); }

/**
 * Is `candidate` inside `root` after both are fully resolved? Symlinks are
 * resolved first, so a link inside the slide directory cannot point out of it.
 *
 * The comparison follows the FILESYSTEM's own rule about case. On Linux paths
 * are case-sensitive and so is this. On macOS and Windows the default
 * filesystems are not, so `C:\Slides\deck.html` and `C:\slides\deck.html` are
 * one file — comparing them case-sensitively there does not tighten the
 * boundary, it just refuses a path that is genuinely inside it. Matching the
 * filesystem is what makes the check mean what it says on all three.
 */
export function withinDirectory(candidate: string, root: string): boolean {
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const fold = (p: string) => (CASE_INSENSITIVE_FS ? p.toLowerCase() : p);
  const c = fold(real(resolve(candidate)));
  const r = fold(real(resolve(root)));
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** Decide whether a `file://` URL may be navigated to. Slide directory only. */
export function classifyFileUrl(url: string): NavDecision {
  let path: string;
  try {
    path = fileURLToPath(url);
  } catch {
    return { allowed: false, destination: null, pinnedIp: null, diagnostics: [diag('external/file-scope', 'error',
      'not a usable file:// URL', { url }, {}, ['use a { "do": "slide", "slide": "<id>" } step'])] };
  }
  const deckRoot = slidePaths().root;
  if (!withinDirectory(path, deckRoot)) {
    return { allowed: false, destination: null, pinnedIp: null, diagnostics: [diag('external/file-scope', 'error',
      'a file:// target outside the compiled slide directory is refused',
      { path }, { allowedRoot: deckRoot },
      ['use a { "do": "slide", "slide": "<id>" } step', 'move the file into slides/'])] };
  }
  if (!existsSync(path)) {
    return { allowed: false, destination: null, pinnedIp: null, diagnostics: [diag('external/file-scope', 'error',
      'the slide file does not exist', { path }, {}, ['run `rushes slides build` first'])] };
  }
  return { allowed: true, destination: { kind: 'file', url, path }, pinnedIp: null, diagnostics: [] };
}

/**
 * Classify one navigation target. `raw` is either a same-origin relative path,
 * an explicit `external` URL, or a `file://` slide URL.
 */
export async function classifyDestination(
  raw: string,
  config: ProjectConfig,
  intent: 'app' | 'external' | 'file',
): Promise<NavDecision> {
  if (intent === 'file' || raw.startsWith('file://')) return classifyFileUrl(raw);

  const base = new URL(config.baseUrl);
  const url = isAbsoluteUrl(raw) ? new URL(raw) : new URL(raw, config.baseUrl);
  const sameOrigin = url.origin === base.origin;

  if (intent === 'app' && !sameOrigin) {
    return { allowed: false, destination: null, pinnedIp: null, diagnostics: [diag('external/host-not-allowed', 'error',
      'an off-origin navigation must be declared with "external"', { url: url.toString(), host: url.hostname },
      { baseOrigin: base.origin },
      ['move the URL to the step\'s "external" field', 'use a relative path for the application origin'])] };
  }

  if (sameOrigin) {
    // The application origin: `allowHosts` narrows, the resolved-IP rule decides.
    // Loopback and RFC1918 are reachable here because filming a local dev server
    // is the normal case; link-local and CGNAT stay blocked at every profile.
    const allow = config.allowHosts ?? [];
    if (!hostAllowed(url.hostname, allow)) {
      return { allowed: false, destination: null, pinnedIp: null, diagnostics: [diag('config/host-not-allowed', 'error',
        `"${url.hostname}" is not in allowHosts`, { host: url.hostname }, { allowHosts: allow },
        [`add "${url.hostname}" to allowHosts`, 'correct baseUrl'])] };
    }
    const c = await classifyHost(url.hostname, LOCAL_APP_POLICY);
    if (!c.allowed) {
      return { allowed: false, destination: null, pinnedIp: null, diagnostics: [diag('config/host-not-allowed', 'error',
        `"${url.hostname}" failed the resolved-IP classification: ${c.reason}`,
        { host: url.hostname }, { reason: c.reason },
        ['point baseUrl at the application, not at an internal service'])] };
    }
    return { allowed: true, destination: { kind: 'app', url: url.toString(), host: url.hostname }, pinnedIp: c.pinnedIp, diagnostics: [] };
  }

  // Off-origin. Both lists must agree, and the strict IP policy applies: nothing
  // a public page needs lives on a private address.
  const allow = config.external?.allow ?? [];
  if (!allow.length || !hostAllowed(url.hostname, allow)) {
    return { allowed: false, destination: null, pinnedIp: null, diagnostics: [diag('external/host-not-allowed', 'error',
      `"${url.hostname}" is not in external.allow`, { host: url.hostname }, { allow },
      [`add "${url.hostname}" to external.allow in rushes.config.json`, 'remove the external step'])] };
  }
  const c = await classifyHost(url.hostname, STRICT_POLICY);
  if (!c.allowed) {
    return { allowed: false, destination: null, pinnedIp: null, diagnostics: [diag('external/redirect-refused', 'error',
      `"${url.hostname}" resolved to an address that must not be reached: ${c.reason}`,
      { host: url.hostname }, { reason: c.reason },
      ['remove the external step', 'point it at a genuinely public page'])] };
  }
  return { allowed: true, destination: { kind: 'external', url: url.toString(), host: url.hostname }, pinnedIp: c.pinnedIp, diagnostics: [] };
}

/**
 * Re-classify every redirect hop. An allowed public host that 302s into a
 * private range must be refused mid-flight; the initial-URL check alone does not
 * close that.
 */
export async function classifyRedirectChain(response: PwResponse | null): Promise<Diagnostic[]> {
  const out: Diagnostic[] = [];
  let r: PwResponse | null = response;
  const seen = new Set<string>();
  while (r) {
    const url = r.url();
    if (seen.has(url)) break;
    seen.add(url);
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        const c = await classifyHost(u.hostname, STRICT_POLICY);
        if (!c.allowed && !/^(localhost|127\.|0\.0\.0\.0|\[?::1)/.test(u.hostname)) {
          out.push(diag('external/redirect-refused', 'error',
            `redirect hop "${u.hostname}" resolved to an address that must not be reached: ${c.reason}`,
            { host: u.hostname, hop: url }, { reason: c.reason },
            ['remove the external step', 'point it at a page that does not redirect off the public internet']));
        }
      }
    } catch { /* opaque hop */ }
    r = r.request().redirectedFrom()?.response ? await r.request().redirectedFrom()!.response() : null;
  }
  return out;
}

/**
 * Leaving the origin is leaving the trust boundary.
 *
 * The first version of this only cleared `extraHTTPHeaders`, which covered the
 * `header` strategy and nothing else. `httpCredentials` — the `basic` strategy —
 * is a CONTEXT-CREATION option that cannot be unset afterwards, and Playwright
 * answers any 401 Basic challenge with it regardless of origin. A third party
 * that replied `401 WWW-Authenticate: Basic` received the operator's username
 * and password in cleartext, base64 of `user:pass` and nothing else.
 *
 * So the boundary is a SEPARATE CONTEXT that was never given a credential,
 * rather than an attempt to take one away from a context that has it. There is
 * nothing to strip, which is the only version of this that is actually true.
 */
export interface ExternalVisit {
  page: Page;
  close(): Promise<void>;
}

export class CredentialBoundary {
  private readonly page: Page;
  private readonly headers: Record<string, string> | null;
  private readonly hasContextCredentials: boolean;

  constructor(page: Page, headers: Record<string, string> | null, hasContextCredentials = false) {
    this.page = page;
    this.headers = headers;
    this.hasContextCredentials = hasContextCredentials;
  }

  /** True when a credential would have travelled off-origin without this. */
  get hadCredentials(): boolean {
    return this.hasContextCredentials || (!!this.headers && Object.keys(this.headers).length > 0);
  }

  /**
   * A page in a brand-new context that carries no cookies, no storage, no
   * headers and no HTTP credentials. Cookies and localStorage were already
   * origin-scoped; this is what makes the other two true as well.
   */
  async open(viewport: { width: number; height: number }): Promise<ExternalVisit> {
    const browser = this.page.context().browser();
    if (!browser) throw new Error('cannot open a credential-free context: the browser is gone');
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      // Deliberately nothing else. Every option omitted here is a credential
      // that cannot cross the boundary because it was never granted.
    });
    const page = await context.newPage();
    return {
      page,
      async close() {
        await context.close().catch(() => {});
      },
    };
  }
}
