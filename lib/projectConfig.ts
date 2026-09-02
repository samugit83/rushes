// rushes.config.json: the one file that describes the application being filmed.
// It lives in the filmed project's repository, never in the skill (principle
// 10). Nothing in it is required except `baseUrl`; a public marketing site needs
// three lines.
//
// Values may interpolate ${ENV_VAR} from the AMBIENT environment. The skill's
// own .env never gains a key for another system's secret (principle 13), so a
// resolved value is registered with the scrubber the moment it is expanded.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv, type ErrorObject } from 'ajv';
import { SKILL_ROOT } from './env.ts';
import { projectRoot } from './paths.ts';
import { type Diagnostic, diag } from './diagnostics.ts';
import type { Locator } from './types.ts';

export type AuthKind = 'none' | 'storage-state' | 'form-login' | 'jwt-cookie' | 'basic' | 'header';

export interface AuthConfig {
  kind: AuthKind;
  statePath?: string;
  maxAgeHours?: number;
  signedInWhen?: Locator;
  signedOutWhen?: Locator;
  path?: string;
  fields?: Record<string, string>;
  csrfField?: string;
  submit?: Locator;
  cookie?: string;
  secretEnv?: string;
  alg?: 'HS256';
  claims?: Record<string, unknown>;
  ttlSeconds?: number;
  user?: string;
  pass?: string;
  name?: string;
  value?: string;
}

export interface RunnerConfig {
  start: string;
  cwd?: string;
  readyWhen: { http?: string; status?: number; log?: string; selector?: string };
  timeoutMs?: number;
  stopAfter?: boolean;
}

export interface PreflightEntry {
  method: 'GET' | 'HEAD' | 'PATCH' | 'POST';
  path: string;
  json?: unknown;
  restoreAfter?: boolean;
  /** Where to READ the prior value in the GET response (a dotted path). */
  restoreKey?: string;
  /** Where inside `json` the value lives, so the restore can be sent in the
   *  same shape the endpoint accepts. Without it the restore sends a bare
   *  key/value pair, which most endpoints reject. */
  restoreValuePath?: string;
}

export interface DismissEntry { locator: Locator; checkAllCheckboxes?: boolean; optional?: boolean }

export interface BrandConfig {
  name?: string;
  wordmark?: { text: string; color?: string }[];
  kicker?: string;
  logo?: string;
  accent?: string;
  background?: string;
  tokens?: string;
  disclaimer?: string;
  footerLine?: string;
  links?: Record<string, string>;
  closingTagline?: string;
}

export interface ExternalConfig {
  allow?: string[];
  readiness?: { quietMs?: number; timeoutMs?: number };
  dismiss?: { locator: Locator; optional?: boolean }[];
  volatile?: boolean;
  publishConsent?: string;
}

export interface ProjectConfig {
  schemaVersion?: 1;
  baseUrl: string;
  allowHosts?: string[];
  egress?: {
    /**
     * Refuse to resolve ANY name that was not classified, including
     * subresources. Off by default: a real app loads fonts, avatars and error
     * reporters from names nobody listed, and breaking those silently is worse
     * than the marginal gain over the navigation checks.
     */
    strictSubresources?: boolean;
  };
  recordingIdentity?: { label?: string; operatorAccounts?: string[] };
  runner?: RunnerConfig;
  auth?: AuthConfig;
  readiness?: { quietMs?: number; timeoutMs?: number; readySelector?: string | null; busySelector?: string | null };
  seed?: {
    localStorage?: Record<string, string>;
    sessionStorage?: Record<string, string>;
    cookies?: { name: string; value: string; path?: string }[];
  };
  preflight?: PreflightEntry[];
  dismiss?: DismissEntry[];
  colorScheme?: 'dark' | 'light' | 'no-preference';
  external?: ExternalConfig;
  redact?: string[];
  scanArtifacts?: boolean;
  neverShow?: string[];
  canvasConfirm?: Locator;
  brand?: BrandConfig;
  video?: { width?: number; height?: number; fps?: number; bitrate?: string };
  pronunciation?: Record<string, string>;
  assertBase?: string;
  publish?: {
    youtube?: {
      titlePrefix?: string;
      playlistId?: string;
      playlistTitle?: string;
      privacy?: 'public' | 'unlisted' | 'private';
      tags?: string[];
      categoryId?: string;
      footer?: string;
    };
  };
}

export const CONFIG_FILENAME = 'rushes.config.json';

export function configPath(root = projectRoot()): string {
  return join(root, CONFIG_FILENAME);
}

/** The neutral config a first run gets: film localhost:3000, no auth, no brand. */
export const DEFAULT_CONFIG: ProjectConfig = {
  schemaVersion: 1,
  baseUrl: 'http://localhost:3000',
  auth: { kind: 'none' },
};

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export interface ResolveResult<T> { value: T; unresolved: string[] }

/**
 * Expand every ${VAR} against the ambient environment. An unset variable is
 * reported, never silently emptied.
 *
 * This deliberately does NOT register the expanded values with the scrubber.
 * It used to, and the result was that `baseUrl` — which is almost always a
 * ${VAR} — came back as "[redacted]" in the receipt and in every diagnostic
 * URL. The receipt exists to answer "which target was filmed", and it answered
 * "[redacted]".
 *
 * Registration belongs at the SECRET POSITIONS instead, where the knowledge
 * that a value is a credential actually lives: each auth strategy registers its
 * own secret, its cookie values and its minted token. Redacting by value is
 * still the rule; the fix is knowing which values are secrets.
 */
export function resolveEnvRefs<T>(input: T): ResolveResult<T> {
  const unresolved: string[] = [];
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return v.replace(ENV_REF, (_m, name: string) => {
        const got = process.env[name];
        if (got === undefined || got === '') { unresolved.push(name); return `\${${name}}`; }
        return got;
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      // Keys are expanded too: a preference blob keyed by a tenant id is a real
      // shape, and `{ "${TENANT_ID}": { ... } }` is the only way to express it
      // without the engine knowing what a tenant is.
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[String(walk(k))] = walk(val);
      return o;
    }
    return v;
  };
  return { value: walk(input) as T, unresolved: [...new Set(unresolved)] };
}

// Compiled ONCE. Ajv refuses to register the same $id twice, so recompiling per
// call throws the second time a config is loaded in one process — which is
// exactly what a test that loads three configs does.
let compiled: ReturnType<Ajv['compile']> | null = null;
function validator() {
  if (!compiled) {
    const schema = JSON.parse(readFileSync(join(SKILL_ROOT, 'schemas', 'config.schema.json'), 'utf8'));
    compiled = new Ajv({ allErrors: true, strict: false }).compile(schema);
  }
  return compiled;
}

export function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim());
}

export interface LoadedConfig {
  config: ProjectConfig;
  /** Raw bytes as they were on disk, for the receipt hash (SP8). */
  raw: string;
  path: string;
  diagnostics: Diagnostic[];
}

/**
 * Read, validate and resolve the project config. A missing file is not an error:
 * a first run against a local app works with the defaults, which is what makes
 * the sixty-second first video possible.
 */
export function loadConfig(root = projectRoot()): LoadedConfig {
  const path = configPath(root);
  const diagnostics: Diagnostic[] = [];

  if (!existsSync(path)) {
    return { config: { ...DEFAULT_CONFIG }, raw: JSON.stringify(DEFAULT_CONFIG), path, diagnostics };
  }

  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    diagnostics.push(diag('input/json-parse', 'error', `${CONFIG_FILENAME} is not valid JSON: ${(e as Error).message}`,
      { path }, {}, ['fix the JSON syntax at the reported position']));
    return { config: { ...DEFAULT_CONFIG }, raw, path, diagnostics };
  }

  const validate = validator();
  if (!validate(parsed)) {
    for (const msg of formatAjvErrors(validate.errors)) {
      diagnostics.push(diag('config/schema', 'error', `${CONFIG_FILENAME}: ${msg}`, { path }, {},
        ['remove the unknown key', 'correct the value type', 'see references/config-contract.md']));
    }
  }

  const { value, unresolved } = resolveEnvRefs(parsed as ProjectConfig);
  for (const name of unresolved) {
    diagnostics.push(diag('config/env-ref-unresolved', 'error', `\${${name}} is not set in the environment`,
      { variable: name }, {}, [`export ${name} before running`, 'switch auth.kind to "storage-state" and run `rushes login`']));
  }

  return { config: { ...DEFAULT_CONFIG, ...value }, raw, path, diagnostics };
}

/** Effective readiness for the application origin. */
export function readinessOf(config: ProjectConfig) {
  return {
    quietMs: config.readiness?.quietMs ?? 500,
    timeoutMs: config.readiness?.timeoutMs ?? 20_000,
    readySelector: config.readiness?.readySelector ?? null,
    busySelector: config.readiness?.busySelector ?? null,
  };
}

/** Hosts a `goto` may leave the application origin for. Empty means: none (P16.1). */
export function externalAllow(config: ProjectConfig): string[] {
  return config.external?.allow ?? [];
}
