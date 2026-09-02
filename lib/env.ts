// The skill's own environment. Two keys, both about the voice (principle 13):
// ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID. A credential the *filmed*
// application needs is never stored here — it is named by `${VAR}` in
// rushes.config.json and read from the ambient environment, or captured once
// into a browser state file the user owns.
//
// The `.env` is parsed once and memoized (F10: this used to do a readFileSync
// plus five regex scans per narration line).

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const SKILL_ROOT = join(dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '..');

/** The complete allowlist of keys the skill's own .env may carry (X2 / config/env-leak). */
export const ENV_ALLOWLIST = ['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'] as const;

export interface SkillEnv {
  elevenKey: string;
  voiceId: string;
}

function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

let dotenvCache: Record<string, string> | null = null;

/** Raw parse of the skill's .env (empty when absent). Memoized. */
export function dotenv(): Record<string, string> {
  if (dotenvCache) return dotenvCache;
  const path = join(SKILL_ROOT, '.env');
  dotenvCache = existsSync(path) ? parseDotenv(readFileSync(path, 'utf8')) : {};
  return dotenvCache;
}

let envCache: SkillEnv | null = null;

/** The two TTS keys. Throws once, on first call, if either is missing. */
export function env(): SkillEnv {
  if (envCache) return envCache;
  const d = dotenv();
  const elevenKey = process.env.ELEVENLABS_API_KEY || d.ELEVENLABS_API_KEY || '';
  const voiceId = process.env.ELEVENLABS_VOICE_ID || d.ELEVENLABS_VOICE_ID || '';
  if (!elevenKey || !voiceId) {
    throw new Error('ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID missing (.env or environment). Run `rushes doctor`.');
  }
  envCache = { elevenKey, voiceId };
  return envCache;
}

/** True when the voice keys are present, without throwing. For `doctor`. */
export function hasVoiceKeys(): boolean {
  try { env(); return true; } catch { return false; }
}

/**
 * Keys in the skill's .env outside the two-key allowlist. A non-empty result is
 * `config/env-leak`: the skill has started storing another system's secret,
 * which is the one thing principle 13 forbids.
 */
export function envLeakKeys(): string[] {
  return Object.keys(dotenv()).filter((k) => !(ENV_ALLOWLIST as readonly string[]).includes(k));
}

/** Ambient-environment lookup used by ${VAR} expansion in the project config. */
export function ambient(name: string): string | undefined {
  return process.env[name];
}

/** Test seam: forget the memoized parse. */
export function resetEnvCache(): void { dotenvCache = null; envCache = null; }
