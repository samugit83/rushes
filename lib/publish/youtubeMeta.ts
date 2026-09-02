// The YouTube title and description, and the reviewable text file they are
// written to. Nothing here uploads; that is a separate, confirmed step.
//
// Every brand fact — the title prefix, the links, the footer, the tags — comes
// from the project config (P8). With none configured the description is just the
// hook, the summary and the chapters, which is a complete and honest listing.
//
// out/<id>/<id>.youtube.txt: first non-empty line is the TITLE, the rest is the
// DESCRIPTION. The uploader parses it back with the same rule.

import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { projectRoot } from '../paths.ts';
import type { Storyboard, TimelineEntry } from '../types.ts';
import type { ProjectConfig } from '../projectConfig.ts';

export interface YoutubeMeta { title: string; description: string }

export const TITLE_MAX = 100;

/**
 * One title layout per project: "<prefix><sentence>". A storyboard supplies only
 * the sentence, and any prefix it carries anyway is stripped first, so the
 * function is idempotent across re-runs.
 */
export function brandTitle(title: string, prefix: string): string {
  let sentence = title.trim();
  if (prefix) {
    const escaped = prefix.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
    sentence = sentence.replace(new RegExp(`^\\s*${escaped}\\s*[-:|]?\\s*`, 'i'), '').trim();
  }
  return `${prefix}${sentence}`.slice(0, TITLE_MAX);
}

function stamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** intro card + each scene + outro card -> "0:00 Label" lines (merge under 10s). */
export function buildChapters(
  introMs: number,
  timeline: TimelineEntry[],
  outroStartMs: number,
  labels: Record<string, string>,
): string[] {
  const raw: { start: number; label: string }[] = [
    { start: 0, label: labels.intro ?? 'Intro' },
    ...timeline.map((e) => ({ start: (introMs + e.startMs) / 1000, label: labels[e.sceneId] ?? e.sceneId })),
    { start: outroStartMs / 1000, label: labels.outro ?? 'Get started' },
  ];
  const kept: { start: number; label: string }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const next = i + 1 < raw.length ? raw[i + 1].start : raw[i].start + 999;
    if (i === 0 || next - raw[i].start >= 10 || i === raw.length - 1) kept.push(raw[i]);
  }
  if (kept.length) kept[0].start = 0;
  return kept.length >= 3 ? kept.map((c) => `${stamp(c.start)} ${c.label}`) : [];
}

function footerMarkdown(config: ProjectConfig): string {
  const path = config.publish?.youtube?.footer;
  if (!path) return '';
  const abs = isAbsolute(path) ? path : join(projectRoot(), path);
  return existsSync(abs) ? readFileSync(abs, 'utf8').trim() : '';
}

function linksBlock(config: ProjectConfig): string {
  const links = config.brand?.links ?? {};
  const rows = Object.entries(links).map(([k, v]) => `• ${k}: ${v}`);
  return rows.length ? ['🔗 LINKS', ...rows].join('\n') : '';
}

export function buildYoutubeMeta(story: Storyboard, chapters: string[], config: ProjectConfig): YoutubeMeta {
  const yt = story.youtube ?? {};
  const prefix = config.publish?.youtube?.titlePrefix ?? '';
  const title = brandTitle(yt.title ?? story.feature, prefix);
  const product = config.brand?.name ? ` in ${config.brand.name}` : '';
  const hook = yt.hook ?? `A short, guided tour of ${story.feature}${product}, driven live in the browser.`;
  const summary = yt.summary ?? `Walkthrough of ${story.feature}${product}.`;

  const parts: string[] = [];
  const links = linksBlock(config);
  if (links) parts.push(links, '');
  parts.push(hook, '', summary);
  if (chapters.length) parts.push('', '⏱️ CHAPTERS', ...chapters);
  const footer = footerMarkdown(config);
  if (footer) parts.push('', footer);
  const tags = config.publish?.youtube?.tags ?? [];
  if (tags.length) parts.push('', tags.map((t) => `#${t.replace(/^#/, '')}`).join(' '));
  return { title, description: parts.join('\n') };
}

export function metaToTxt(m: YoutubeMeta): string { return `${m.title}\n\n${m.description}\n`; }

export function txtToMeta(txt: string): YoutubeMeta {
  const lines = txt.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  const title = (lines[i] ?? '').trim();
  const description = lines.slice(i + 1).join('\n').replace(/^\n+/, '').trimEnd();
  return { title, description };
}
