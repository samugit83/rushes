// The catalogue index (S3). One line per demo: what was built, when, from which
// storyboard, and where it was published.
//
// It answers the question that actually matters once there are dozens of
// published videos and an application under active development: WHICH PUBLISHED
// VIDEOS WERE BUILT FROM A STORYBOARD THAT HAS SINCE CHANGED. Without it, the
// day the UI moves you either re-record everything or leave wrong videos up.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { statePaths } from '../paths.ts';
import { storyboardPath } from '../storyboard.ts';

export interface CatalogueEntry {
  id: string;
  feature: string;
  builtAt: string;
  profile: string;
  verdict: 'passed' | 'failed';
  storyboardSha256: string;
  artifactSha256: string;
  publishedUrl?: string;
  publishedAt?: string;
}

export type Catalogue = Record<string, CatalogueEntry>;

export function readCatalogue(): Catalogue {
  const p = statePaths().index;
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')) as Catalogue; } catch { return {}; }
}

export function writeCatalogue(cat: Catalogue): void {
  const p = statePaths().index;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cat, null, 2));
}

export function recordBuild(entry: CatalogueEntry): void {
  const cat = readCatalogue();
  cat[entry.id] = { ...cat[entry.id], ...entry };
  writeCatalogue(cat);
}

export function recordPublish(id: string, url: string): void {
  const cat = readCatalogue();
  if (!cat[id]) return;
  cat[id].publishedUrl = url;
  cat[id].publishedAt = new Date().toISOString();
  writeCatalogue(cat);
}

/** Published videos whose storyboard has changed since they were built. */
export function staleEntries(): { id: string; url?: string }[] {
  const cat = readCatalogue();
  const out: { id: string; url?: string }[] = [];
  for (const e of Object.values(cat)) {
    const path = storyboardPath(e.id);
    if (!existsSync(path)) continue;
    const now = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (now !== e.storyboardSha256) out.push({ id: e.id, url: e.publishedUrl });
  }
  return out;
}
