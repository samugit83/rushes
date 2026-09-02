// Extract the application's own design tokens and write them as the slide
// palette (P15).
//
// This is what turns "the slides and the live UI share one visual language" from
// a rule somebody has to remember into a property of the build. Load the app,
// read the computed styles of real rendered elements — not just `:root`, because
// most apps declare tokens they do not use — and derive a palette from what is
// actually on screen.
//
// The agent never asks "what visual style do you want". It extracts, shows the
// six colours and the font it found, and asks for a yes.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { slidePaths, projectRoot } from '../paths.ts';
import { type Diagnostic, diag } from '../diagnostics.ts';

export interface ExtractedTokens {
  bg: string;
  surface: string;
  surface2: string;
  fg: string;
  fgMuted: string;
  border: string;
  accent: string;
  font: string;
  radius: string;
  /** Whatever the app itself declares as custom properties, for reference. */
  declared: Record<string, string>;
}

const EXTRACT = () => {
  const seen = new Map<string, number>();
  const count = (c: string, weight: number) => {
    if (!c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent') return;
    seen.set(c, (seen.get(c) ?? 0) + weight);
  };
  const area = (e: Element) => { const r = e.getBoundingClientRect(); return Math.max(0, r.width * r.height); };

  const els = [...document.querySelectorAll('body *')].slice(0, 4000);
  const textColours = new Map<string, number>();
  const fonts = new Map<string, number>();
  const radii = new Map<string, number>();
  let accentGuess = '';
  let accentScore = 0;

  for (const el of els) {
    const cs = getComputedStyle(el);
    const a = area(el);
    if (a <= 0) continue;
    count(cs.backgroundColor, a);
    if ((el.textContent ?? '').trim()) {
      textColours.set(cs.color, (textColours.get(cs.color) ?? 0) + a);
      const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
      if (fam) fonts.set(fam, (fonts.get(fam) ?? 0) + a);
    }
    if (cs.borderRadius && cs.borderRadius !== '0px') {
      radii.set(cs.borderRadius.split(' ')[0], (radii.get(cs.borderRadius.split(' ')[0]) ?? 0) + 1);
    }
    // The accent is the most saturated colour used on a SMALL area: a button, a
    // badge, a link. A large saturated area is a hero image, not a token.
    for (const c of [cs.backgroundColor, cs.color, cs.borderColor]) {
      const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) continue;
      const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx < 70) continue;
      const sat = (mx - mn) / mx;
      if (sat < 0.45) continue;
      const score = sat * mx * Math.min(1, 40000 / Math.max(400, a));
      if (score > accentScore) { accentScore = score; accentGuess = `rgb(${r}, ${g}, ${b})`; }
    }
  }

  const byArea = [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const text = [...textColours.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const font = [...fonts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const radius = [...radii.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

  const declared: Record<string, string> = {};
  const root = getComputedStyle(document.documentElement);
  for (let i = 0; i < root.length; i++) {
    const name = root[i];
    if (name.startsWith('--')) declared[name] = root.getPropertyValue(name).trim();
  }

  return {
    bg: byArea[0] ?? '',
    surface: byArea[1] ?? byArea[0] ?? '',
    surface2: byArea[2] ?? byArea[1] ?? '',
    fg: text[0] ?? '',
    fgMuted: text[1] ?? text[0] ?? '',
    border: '',
    accent: accentGuess,
    font,
    radius,
    declared,
  };
};

export async function extractTokens(page: Page): Promise<{ tokens: ExtractedTokens | null; diagnostics: Diagnostic[] }> {
  const raw = await page.evaluate(EXTRACT).catch(() => null);
  if (!raw || !raw.bg || !raw.fg) {
    return {
      tokens: null,
      diagnostics: [diag('style/tokens-unreadable', 'warning',
        'the app yielded no usable palette; the neutral fallback will be used',
        { url: page.url() }, {},
        ['point the extraction at a content page rather than a splash screen',
         'set brand.tokens to a hand-written tokens.css',
         'choose a shipped preset'])],
    };
  }
  return { tokens: raw as ExtractedTokens, diagnostics: [] };
}

/** Write the project's tokens.css, overriding only what was actually measured. */
export function writeProjectTokens(tokens: ExtractedTokens, root = projectRoot()): string {
  const base = readFileSync(join(slidePaths().runtime, 'tokens.css'), 'utf8');
  const overrides = [
    ['--bg', tokens.bg],
    ['--surface', tokens.surface],
    ['--surface-2', tokens.surface2],
    ['--fg', tokens.fg],
    ['--fg-muted', tokens.fgMuted],
    ['--accent', tokens.accent],
    ['--radius', tokens.radius],
  ].filter(([, v]) => v);

  const block = `\n/* Derived from the running application by \`rushes slides tokens\`.\n` +
    ` * Regenerate rather than hand-editing: the point is that the slides and the\n` +
    ` * live UI in the same video cannot drift apart. */\n:root {\n` +
    overrides.map(([k, v]) => `  ${k}: ${v};`).join('\n') +
    (tokens.font ? `\n  --font: '${tokens.font}', system-ui, sans-serif;` : '') +
    `\n}\n`;

  const dir = join(root, 'slides', 'runtime');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'tokens.css');
  writeFileSync(out, base + block);
  return out;
}

/** The six colours and the font, for the Gate 1 echo. */
export function summarise(tokens: ExtractedTokens): string[] {
  return [
    `background  ${tokens.bg}`,
    `surface     ${tokens.surface}`,
    `foreground  ${tokens.fg}`,
    `muted       ${tokens.fgMuted}`,
    `accent      ${tokens.accent}`,
    `radius      ${tokens.radius || '(none found)'}`,
    `font        ${tokens.font || '(none found)'}`,
  ];
}
