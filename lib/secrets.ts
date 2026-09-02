// Two different jobs, both about secrets, kept in one module because they share
// the pattern set.
//
//   1. The value scrubber (SP5). Every secret the run resolves — an expanded
//      ${VAR}, an auth header, a cookie value, the TTS key — is registered here
//      and scrubbed out of every diagnostic, receipt field and log line BEFORE
//      it is written. Redaction is by VALUE, not by key name, because a value
//      travels into fields nobody named.
//
//   2. The on-screen scanner (E5). Visible page text is matched against
//      key-shaped patterns; a hit is an error at every quality profile. This
//      publishes to a public channel, so a secret on screen is an incident.

const registered = new Set<string>();

/** Register a resolved secret value so it can never be written out. */
export function registerSecret(value: string | undefined | null): void {
  if (!value) return;
  const v = String(value);
  if (v.length < 6) return; // too short to redact without mangling ordinary text
  registered.add(v);
}

export function registeredSecrets(): string[] { return [...registered]; }

export const REDACTION = '[redacted]';

/** Deep-copy `input`, replacing every registered secret value with a marker. */
export function scrub<T>(input: T): T {
  if (registered.size === 0) return input;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      let out = v;
      for (const s of registered) if (out.includes(s)) out = out.split(s).join(REDACTION);
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = walk(val);
      return o;
    }
    return v;
  };
  return walk(input) as T;
}

/** True when `text` still carries a registered secret. Fails the build (SP5). */
export function containsSecret(text: string): string | null {
  for (const s of registered) if (text.includes(s)) return s;
  return null;
}

/** Test seam. */
export function resetSecrets(): void { registered.clear(); }

// ---------------------------------------------------------------------------
// Key-shaped patterns. Deliberately conservative: a false positive costs one
// look at a frame, a false negative costs a published credential.

export interface SecretPattern { name: string; re: RegExp }

export const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'github-token', re: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/ },
  { name: 'slack-token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'stripe-key', re: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}\b/ },
  { name: 'elevenlabs-key', re: /\bsk_[0-9a-f]{40,}\b/ },
  { name: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { name: 'bearer-header', re: /\bBearer\s+[A-Za-z0-9_\-.=]{24,}/ },
  { name: 'password-assignment', re: /\b(?:password|passwd|secret|api[_-]?key)\s*[:=]\s*["']?[^\s"']{8,}/i },
];

export interface SecretHit { name: string; excerpt: string }

/** Redacted excerpts of every secret-shaped match in `text`. */
export function scanText(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const p of SECRET_PATTERNS) {
    const m = text.match(p.re);
    if (!m) continue;
    const raw = m[0];
    // Never echo the match itself into a diagnostic: keep 4 characters of shape.
    const excerpt = raw.length <= 8 ? `${raw.slice(0, 2)}…` : `${raw.slice(0, 4)}…${raw.slice(-2)}`;
    hits.push({ name: p.name, excerpt });
  }
  return hits;
}

/** Terms from the standing brief that must never appear (S4 / never_show_clean). */
export function scanNeverShow(text: string, terms: string[]): string[] {
  const lower = text.toLowerCase();
  return terms.filter((t) => t.trim() && lower.includes(t.toLowerCase()));
}
