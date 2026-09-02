// Failures are structured data, not prose (principle 2). A diagnostic carries a
// stable `code`, the exact `subject` it is about, the `evidence` that was
// measured, and an enumerated list of `supportedFixes`.
//
// `supportedFixes` is the load-bearing field: the repairing agent picks from it
// and never invents a value. That is what makes a repair loop converge instead
// of thrash.
//
// The full code registry is in references/delivery-contract.md.

import { scrub } from './secrets.ts';

export type Severity = 'error' | 'warning';

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  subject: Record<string, unknown>;
  evidence: Record<string, unknown>;
  supportedFixes: string[];
}

export function diag(
  code: string,
  severity: Severity,
  message: string,
  subject: Record<string, unknown> = {},
  evidence: Record<string, unknown> = {},
  supportedFixes: string[] = [],
): Diagnostic {
  return { code, severity, message, subject, evidence, supportedFixes };
}

/**
 * Collects diagnostics, de-duplicating by (code + message + subject). One root
 * cause that touches forty elements should produce one line, not forty.
 */
export class Diagnostics {
  private readonly seen = new Set<string>();
  private readonly items: Diagnostic[] = [];

  add(d: Diagnostic): Diagnostic {
    const key = `${d.code}::${d.message}::${JSON.stringify(d.subject)}`;
    if (!this.seen.has(key)) {
      this.seen.add(key);
      this.items.push(d);
    }
    return d;
  }

  push(
    code: string,
    severity: Severity,
    message: string,
    subject?: Record<string, unknown>,
    evidence?: Record<string, unknown>,
    supportedFixes?: string[],
  ): Diagnostic {
    return this.add(diag(code, severity, message, subject, evidence, supportedFixes));
  }

  merge(others: Iterable<Diagnostic>): void { for (const d of others) this.add(d); }

  get all(): Diagnostic[] { return this.items; }
  get errors(): Diagnostic[] { return this.items.filter((d) => d.severity === 'error'); }
  get warnings(): Diagnostic[] { return this.items.filter((d) => d.severity === 'warning'); }
  get ok(): boolean { return this.errors.length === 0; }
  get length(): number { return this.items.length; }

  /** SP5: never serialise a resolved secret value into a diagnostic. */
  toJSON(): Diagnostic[] { return scrub(this.items) as Diagnostic[]; }
}

const CODE_WIDTH = 34;

export function formatDiagnostic(d: Diagnostic): string {
  const mark = d.severity === 'error' ? '✗' : '⚠';
  const subject = Object.entries(d.subject)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  const lines = [`  ${mark} ${d.code.padEnd(CODE_WIDTH)} ${d.message}`];
  if (subject) lines.push(`      at   ${subject}`);
  for (const [k, v] of Object.entries(d.evidence)) {
    lines.push(`      ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  for (const fix of d.supportedFixes) lines.push(`      fix: ${fix}`);
  return lines.join('\n');
}

export function printDiagnostics(items: Diagnostic[], stream: NodeJS.WriteStream = process.stderr): void {
  for (const d of scrub(items) as Diagnostic[]) stream.write(formatDiagnostic(d) + '\n');
}

/** Turn a thrown error into a step diagnostic code. */
export function classifyStepError(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  if (/no element matched|no locator|not visible \(no bounding box\)|resolved to 0 elements/i.test(msg)) {
    return 'step/locator-unresolved';
  }
  if (/timeout|exceeded|waiting for/i.test(msg)) return 'step/timeout';
  return 'step/failed';
}
