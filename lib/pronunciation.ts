// Pronunciation fixes applied ONLY to the text sent to the voice. The caption
// sidecars keep the real spelling ("AI", "CVE", "HTTP"); only the audio uses the
// phonetic alias, so the voice spells an acronym out instead of mangling it and
// the subtitle still reads correctly.
//
// Layered (P11): the skill ships a genuinely generic default, and a project
// extends or overrides it from rushes.config.json. Domain-specific entries
// belong in the project's adapter, not in the engine.
//
// R7: keys are sorted by DESCENDING LENGTH at load. The old code's comment
// claimed longer keys came first and the object literal did not order them that
// way — it worked by accident because every key carried a `\b` guard, and one
// added key without one would have broken it silently.

const GENERIC: Record<string, string> = {
  API: 'A.P.I.',
  APIs: 'A.P.I.s',
  CSV: 'C.S.V.',
  DNS: 'D.N.S.',
  HTTP: 'H.T.T.P.',
  HTTPS: 'H.T.T.P.S.',
  JSON: 'jason',
  JWT: 'J.W.T.',
  PDF: 'P.D.F.',
  SDK: 'S.D.K.',
  SQL: 'sequel',
  TLS: 'T.L.S.',
  UI: 'U.I.',
  URL: 'U.R.L.',
  UX: 'U.X.',
  '2D': 'two D',
  '3D': 'three D',
};

export function pronunciationMap(overrides?: Record<string, string>): [string, string][] {
  const merged = { ...GENERIC, ...(overrides ?? {}) };
  // Longest first, so "CVEs" wins over "CVE" even for a key added without a
  // boundary-safe shape.
  return Object.entries(merged).sort((a, b) => b[0].length - a[0].length);
}

export function applyPronunciation(text: string, overrides?: Record<string, string>): string {
  let out = text;
  for (const [word, say] of pronunciationMap(overrides)) {
    out = out.replace(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), say);
  }
  return out;
}

export { GENERIC as GENERIC_PRONUNCIATION };
