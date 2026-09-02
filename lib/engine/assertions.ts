// Falsifiable narration claims (S1).
//
// A storyboard can narrate "this project already holds well over a thousand
// nodes" as a hardcoded string, publish it on a public channel, and be wrong the
// day the demo data is reseeded smaller. Nothing catches that after upload.
//
// An `assert` binds the sentence to live data. CF8: a metric declares the
// endpoint AND the JSON path it reads. A path that is absent or non-numeric
// fails with `assert/metric-unavailable`; a metric that cannot be read is never
// treated as satisfied.

import type { APIRequestContext } from 'playwright';
import type { Assertion } from '../types.ts';
import type { ProjectConfig } from '../projectConfig.ts';
import { type Diagnostic, diag } from '../diagnostics.ts';
import { validatePreflight } from './preflight.ts';

/** Dotted path with numeric segments for arrays: "data.items.0.count". */
export function readJsonPath(body: unknown, path: string): unknown {
  let cur: unknown = body;
  for (const seg of path.split('.')) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(seg);
      if (!Number.isInteger(i)) return undefined;
      cur = cur[i];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

export async function runAssertions(
  request: APIRequestContext,
  config: ProjectConfig,
  assertions: Assertion[],
): Promise<Diagnostic[]> {
  const out: Diagnostic[] = [];
  for (const a of assertions) {
    // An assert endpoint is a same-origin GET; it inherits SP2's path bounds.
    const bad = validatePreflight({ method: 'GET', path: a.endpoint });
    if (bad.length) { out.push(...bad); continue; }

    let body: unknown;
    try {
      const url = new URL((config.assertBase ?? '') + a.endpoint, config.baseUrl).toString();
      const res = await request.get(url);
      if (!res.ok()) {
        out.push(diag('assert/metric-unavailable', 'error',
          `${a.metric}: ${a.endpoint} answered ${res.status()}`,
          { metric: a.metric, endpoint: a.endpoint }, { status: res.status(), because: a.because },
          ['correct the endpoint', 'check the recording identity may read it']));
        continue;
      }
      body = await res.json();
    } catch (e) {
      out.push(diag('assert/metric-unavailable', 'error',
        `${a.metric}: could not read ${a.endpoint}: ${(e as Error).message}`,
        { metric: a.metric, endpoint: a.endpoint }, { because: a.because },
        ['correct the endpoint', 'check the response is JSON']));
      continue;
    }

    const value = readJsonPath(body, a.jsonPath);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      out.push(diag('assert/metric-unavailable', 'error',
        `${a.metric}: "${a.jsonPath}" is ${value === undefined ? 'absent' : 'not numeric'}`,
        { metric: a.metric, endpoint: a.endpoint, jsonPath: a.jsonPath },
        { got: value, because: a.because },
        ['correct the jsonPath against the real response shape', 'remove the claim from the narration']));
      continue;
    }

    if (a.min !== undefined && value < a.min) {
      out.push(diag('assert/metric-unmet', 'error',
        `${a.metric} is ${value}, below the claimed minimum ${a.min}`,
        { metric: a.metric }, { value, min: a.min, because: a.because },
        ['reword the narration to match the live value', 'seed the demo data so the claim is true']));
    }
    if (a.max !== undefined && value > a.max) {
      out.push(diag('assert/metric-unmet', 'error',
        `${a.metric} is ${value}, above the claimed maximum ${a.max}`,
        { metric: a.metric }, { value, max: a.max, because: a.because },
        ['reword the narration to match the live value']));
    }
  }
  return out;
}
