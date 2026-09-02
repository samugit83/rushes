// Branding as data (P8). Every compiled-in brand fact — a wordmark, an accent,
// a kicker, a title prefix, a description footer, a set of links — used to live
// in five source files. It now lives in the `brand` block of the project config,
// and the renderers read it from there.
//
// With no `brand` configured the cards fall back to a neutral, unbranded look,
// so a first run produces something usable rather than something wearing
// someone else's logo.

import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { SKILL_ROOT } from '../env.ts';
import { projectRoot } from '../paths.ts';
import type { BrandConfig, ProjectConfig } from '../projectConfig.ts';

export interface ResolvedBrand {
  name: string;
  wordmark: { text: string; color: string }[];
  kicker: string;
  accent: string;
  background: string;
  surface: string;
  foreground: string;
  muted: string;
  logoDataUri: string | null;
  disclaimer: string;
  footerLine: string;
  links: Record<string, string>;
  closingTagline: string;
  titlePrefix: string;
}

const NEUTRAL = {
  accent: '#f59e0b',
  background: '#0b0a10',
  surface: '#151320',
  foreground: '#e7e5ea',
  muted: 'rgba(231,229,234,.62)',
};

function resolveAsset(p: string): string {
  return isAbsolute(p) ? p : join(projectRoot(), p);
}

export function resolveBrand(config: ProjectConfig): ResolvedBrand {
  const b: BrandConfig = config.brand ?? {};
  const name = b.name ?? '';
  const logoPath = b.logo ? resolveAsset(b.logo) : join(SKILL_ROOT, 'assets', 'mark.svg');
  let logoDataUri: string | null = null;
  if (existsSync(logoPath)) {
    const bytes = readFileSync(logoPath);
    const mime = logoPath.endsWith('.svg') ? 'image/svg+xml' : logoPath.endsWith('.jpg') ? 'image/jpeg' : 'image/png';
    logoDataUri = `data:${mime};base64,${bytes.toString('base64')}`;
  }
  return {
    name,
    wordmark: (b.wordmark ?? (name ? [{ text: name }] : [])).map((w) => ({
      text: w.text, color: w.color ?? (b.accent ?? NEUTRAL.foreground),
    })),
    // No default: a kicker is a brand fact, and an unbranded card shows none
    // rather than a label someone else chose.
    kicker: b.kicker ?? '',
    accent: b.accent ?? NEUTRAL.accent,
    background: b.background ?? NEUTRAL.background,
    surface: NEUTRAL.surface,
    foreground: NEUTRAL.foreground,
    muted: NEUTRAL.muted,
    logoDataUri,
    disclaimer: b.disclaimer ?? '',
    footerLine: b.footerLine ?? Object.values(b.links ?? {}).join(' · '),
    links: b.links ?? {},
    closingTagline: b.closingTagline ?? '',
    titlePrefix: config.publish?.youtube?.titlePrefix ?? '',
  };
}

/** The one embedded typeface, base64 at render time so nothing hits the network. */
export function embeddedFontCss(family = 'Poppins'): string {
  const dir = join(SKILL_ROOT, 'slides', 'runtime', 'fonts');
  const faces: [number, string][] = [[400, 'poppins_400.woff2'], [600, 'poppins_600.woff2'], [800, 'poppins_800.woff2']];
  return faces
    .filter(([, f]) => existsSync(join(dir, f)))
    .map(([w, f]) =>
      `@font-face{font-family:'${family}';font-style:normal;font-weight:${w};font-display:block;` +
      `src:url(data:font/woff2;base64,${readFileSync(join(dir, f)).toString('base64')}) format('woff2');}`)
    .join('');
}

export const FONT_STACK = `'Poppins',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif`;

export function wordmarkHtml(brand: ResolvedBrand): string {
  if (!brand.wordmark.length) return '';
  return `<span class="n">${brand.wordmark
    .map((w) => `<span style="color:${w.color}">${escapeHtml(w.text)}</span>`)
    .join('')}</span>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
