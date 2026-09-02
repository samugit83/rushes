// Pre-state the engine can set on any application without knowing what a
// preference is (P5), plus the two safety properties that were missing.
//
// SP2 — `preflight` issues HTTP through the SIGNED-IN context, so an unbounded
// one is authenticated request forgery by config. Only GET, HEAD, PATCH and
// POST are allowed; DELETE and PUT are refused outright. The path must be a
// same-origin relative path: absolute URLs, scheme-relative `//` and any `..`
// segment are refused.
//
// CF1 — the restore is a compare-and-set. The app's preference blob is a single
// JSON document written read-modify-write with no version, so a concurrent
// writer's change would be silently discarded by a blind restore. If the value
// changed under us, the restore is ABORTED and reported, never forced.
//
// CF2 — the restore is crash-safe. Pending restores are persisted before they
// are applied, signal handlers replay them, and the next run refuses to start
// while a leftover file exists. Before this, a Ctrl-C mid-recording left the
// operator's preferences permanently mutated with no message saying so.

import { writeFileSync, existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { APIRequestContext } from 'playwright';
import type { PreflightEntry, ProjectConfig } from '../projectConfig.ts';
import { statePaths } from '../paths.ts';
import { type Diagnostic, diag } from '../diagnostics.ts';

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'PATCH', 'POST']);

export function validatePreflight(entry: PreflightEntry): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!ALLOWED_METHODS.has(entry.method)) {
    out.push(diag('preflight/method-forbidden', 'error',
      `preflight method "${entry.method}" is not allowed`, { method: entry.method, path: entry.path },
      { allowed: [...ALLOWED_METHODS] },
      ['use GET, HEAD, PATCH or POST', 'do the mutation in the app before recording']));
  }
  const p = entry.path;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) || p.startsWith('//')) {
    out.push(diag('preflight/path-escape', 'error',
      'a preflight path must be same-origin and relative', { path: p }, {},
      ['use a path like "/api/..." with no scheme and no host']));
  }
  if (p.split('/').includes('..')) {
    out.push(diag('preflight/path-escape', 'error',
      'a preflight path may not contain a ".." segment', { path: p }, {},
      ['write the resolved path directly']));
  }
  return out;
}

export interface PendingRestore {
  path: string;
  method: 'PATCH' | 'POST';
  /** The body to send to put the prior value back, already in the app's shape. */
  json: unknown;
  /** The value we wrote, so the restore can compare before it overwrites. */
  wroteValue?: unknown;
  /** The value that was there before us, for the report if the restore aborts. */
  priorValue?: unknown;
  restoreKey?: string;
  writtenAt: string;
}

/** Set a dotted path inside a copy of `obj`. Used to rebuild the restore body. */
export function setJsonPath(obj: unknown, path: string, value: unknown): unknown {
  const segments = path.split('.');
  const clone = JSON.parse(JSON.stringify(obj ?? {})) as Record<string, unknown>;
  let cursor: Record<string, unknown> = clone;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
  return clone;
}

function pendingPath(): string { return statePaths().pendingRestore; }

export function readPendingRestores(): PendingRestore[] {
  const p = pendingPath();
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf8')) as PendingRestore[]; } catch { return []; }
}

export function writePendingRestores(items: PendingRestore[]): void {
  const p = pendingPath();
  if (!items.length) { rmSync(p, { force: true }); return; }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(items, null, 2));
}

export function clearPendingRestores(): void { rmSync(pendingPath(), { force: true }); }

/** A leftover file means a previous run died mid-recording. Fail closed. */
export function pendingRestoreDiagnostic(): Diagnostic | null {
  const items = readPendingRestores();
  if (!items.length) return null;
  return diag('preflight/restore-pending', 'error',
    `${items.length} preference restore(s) from a previous run were never applied`,
    { file: pendingPath() }, { pending: items.map((i) => `${i.method} ${i.path}`) },
    ['run `rushes doctor --replay-restores` to apply them', 'delete .rushes/pending-restore.json if the values are already correct']);
}

function pick(obj: unknown, key: string): unknown {
  return obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined;
}

/** Read a dotted path, for comparing what we wrote against what is there now. */
function readJsonPathLocal(obj: unknown, path: string): unknown {
  let cursor: unknown = obj;
  for (const segment of path.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

export interface PreflightRecord {
  method: string;
  path: string;
  status: number;
  restoreAfter: boolean;
}

export class PreflightRunner {
  readonly records: PreflightRecord[] = [];
  readonly diagnostics: Diagnostic[] = [];
  private pending: PendingRestore[] = [];

  private readonly request: APIRequestContext;
  private readonly config: ProjectConfig;

  constructor(request: APIRequestContext, config: ProjectConfig) {
    this.request = request;
    this.config = config;
  }

  private url(path: string): string { return new URL(path, this.config.baseUrl).toString(); }

  async run(entries: PreflightEntry[]): Promise<void> {
    for (const entry of entries) {
      const bad = validatePreflight(entry);
      if (bad.length) { this.diagnostics.push(...bad); continue; }

      let prior: unknown;
      if (entry.restoreAfter) {
        // Read the prior value first so the restore has something to put back
        // and something to compare against.
        try {
          const res = await this.request.get(this.url(entry.path));
          const body = await res.json().catch(() => ({}));
          prior = entry.restoreKey ? pick(body, entry.restoreKey) : body;
        } catch (e) {
          this.diagnostics.push(diag('preflight/restore-conflict', 'warning',
            `could not read the prior value of ${entry.path}: ${(e as Error).message}`,
            { path: entry.path }, {}, ['drop restoreAfter for this entry', 'check the endpoint answers GET']));
        }
      }

      let status = 0;
      try {
        const res = entry.method === 'GET' ? await this.request.get(this.url(entry.path))
          : entry.method === 'HEAD' ? await this.request.head(this.url(entry.path))
          : entry.method === 'PATCH' ? await this.request.patch(this.url(entry.path), { data: entry.json })
          : await this.request.post(this.url(entry.path), { data: entry.json });
        status = res.status();
      } catch (e) {
        this.diagnostics.push(diag('preflight/method-forbidden', 'error',
          `${entry.method} ${entry.path} failed: ${(e as Error).message}`,
          { path: entry.path, method: entry.method }, {},
          ['check the endpoint exists', 'check the recording identity may call it']));
        continue;
      }
      this.records.push({ method: entry.method, path: entry.path, status, restoreAfter: !!entry.restoreAfter });

      if (entry.restoreAfter && (entry.method === 'PATCH' || entry.method === 'POST')) {
        // The restore body must be in the SHAPE THE APP ACCEPTS, not a bare
        // key/value pair. An endpoint whose contract is { featureKey, value }
        // answers 400 to { theme: "light" }, and the earlier version sent
        // exactly that — so the restore never happened and never said so.
        //
        // `restoreValuePath` names where inside `json` the value lives, so the
        // restore re-sends the same request with the prior value substituted.
        const restoreBody = entry.restoreValuePath
          ? setJsonPath(entry.json, entry.restoreValuePath, prior)
          : (entry.restoreKey ? { [entry.restoreKey]: prior } : prior);
        const restore: PendingRestore = {
          path: entry.path,
          method: entry.method,
          json: restoreBody,
          wroteValue: entry.restoreValuePath
            ? readJsonPathLocal(entry.json, entry.restoreValuePath)
            : entry.json,
          priorValue: prior,
          restoreKey: entry.restoreKey,
          writtenAt: new Date().toISOString(),
        };
        this.pending.push(restore);
        // Persisted BEFORE the next mutation, so a crash leaves a replayable
        // record rather than an orphaned preference.
        writePendingRestores(this.pending);
      }
    }
  }

  /** Put every restoreAfter value back, comparing before writing (CF1). */
  async restore(): Promise<void> {
    for (const item of [...this.pending].reverse()) {
      try {
        const cur = await (await this.request.get(this.url(item.path))).json().catch(() => undefined);
        const currentValue = item.restoreKey ? pick(cur, item.restoreKey) : cur;
        const wrote = item.wroteValue;
        if (wrote !== undefined && currentValue !== undefined
            && JSON.stringify(currentValue) !== JSON.stringify(wrote)) {
          // Someone else wrote after us. Clobbering their change to restore ours
          // is a data-loss bug; report and leave it alone.
          this.diagnostics.push(diag('preflight/restore-conflict', 'error',
            `${item.path} changed under us; the restore was aborted rather than clobbering it`,
            { path: item.path },
            { restoreKey: item.restoreKey, weWrote: wrote, foundInstead: currentValue, wouldHaveRestored: item.priorValue },
            ['restore the value by hand if it matters',
             'record as a dedicated identity so nothing else writes to it']));
          continue;
        }
        const res = item.method === 'PATCH'
          ? await this.request.patch(this.url(item.path), { data: item.json })
          : await this.request.post(this.url(item.path), { data: item.json });
        // A restore the app REJECTED is the failure this whole mechanism exists
        // to prevent, and it used to pass unnoticed because nobody read the
        // status. Fail loudly: the operator's pre-state is still mutated.
        if (!res.ok()) {
          this.diagnostics.push(diag('preflight/restore-conflict', 'error',
            `restore of ${item.path} was rejected with ${res.status()}; the pre-state is still changed`,
            { path: item.path },
            { status: res.status(), sent: item.json, priorValue: item.priorValue },
            ['set restoreValuePath so the restore is sent in the shape the endpoint accepts',
             'put the value back by hand']));
        }
      } catch (e) {
        this.diagnostics.push(diag('preflight/restore-conflict', 'error',
          `restore of ${item.path} failed: ${(e as Error).message}`, { path: item.path },
          { priorValue: item.priorValue },
          ['apply the value by hand', 're-run once the app is reachable']));
      }
    }
    this.pending = [];
    clearPendingRestores();
  }
}
