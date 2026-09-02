// Repo-derived storyboard drafts (N1).
//
// The generation is not the differentiator — four other projects do it, and one
// commercial product. THE VERIFICATION IS. So the output of this stage is a
// draft whose every scene already carries an `expect` PRE-FILLED FROM THE
// ELEMENT THAT WAS ACTUALLY DISCOVERED, which is exactly what makes the rest of
// the pipeline able to check it.
//
// It never goes straight from a repository to a recording. The draft is a
// proposal a human approves at Gate 2.

import type { Page } from 'playwright';
import type { Storyboard, Scene, Locator } from '../types.ts';
import type { ProjectConfig } from '../projectConfig.ts';
import { settle } from '../engine/readiness.ts';
import { readinessOf } from '../projectConfig.ts';

export interface DiscoveredRoute {
  path: string;
  title: string;
  heading: string | null;
  /** The primary interactive elements, in the locator priority order. */
  actions: { label: string; locator: Locator }[];
  /** Something stable that is on the page, for the pre-filled expect. */
  anchor: Locator | null;
}

const SITE_MODEL = () => {
  const seen = new Set<string>();
  const links = [...document.querySelectorAll('a[href]')]
    .map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? '')
    .filter((h) => h && !h.startsWith('#') && !/^[a-z]+:/i.test(h) && !h.startsWith('//'))
    .filter((h) => (seen.has(h) ? false : (seen.add(h), true)))
    .slice(0, 25);

  const primary = [...document.querySelectorAll('button, [role="button"], a[href], input[type="submit"]')]
    .map((el) => {
      const e = el as HTMLElement;
      const r = e.getBoundingClientRect();
      const label = (e.getAttribute('aria-label') ?? e.innerText ?? '').trim();
      return { label, area: r.width * r.height, top: r.top, testId: e.getAttribute('data-testid') };
    })
    .filter((a) => a.label && a.label.length < 40 && a.area > 400 && a.top < innerHeight)
    .sort((a, b) => b.area - a.area)
    .slice(0, 6);

  const heading = document.querySelector('h1, h2')?.textContent?.trim() ?? null;
  return { links, primary, title: document.title, heading };
};

export async function discoverRoute(page: Page, config: ProjectConfig, path: string): Promise<DiscoveredRoute> {
  await page.goto(new URL(path, config.baseUrl).toString(), { waitUntil: 'domcontentloaded' });
  await settle(page, { ...readinessOf(config), label: 'discover' });
  const model = await page.evaluate(SITE_MODEL);
  return {
    path,
    title: model.title,
    heading: model.heading,
    actions: model.primary.map((p) => ({
      label: p.label,
      locator: p.testId ? { testId: p.testId } : { text: p.label },
    })),
    // The expect is pre-filled from something that was ACTUALLY SEEN on the
    // page, not from a guess about what should be there. That is the whole point.
    anchor: model.heading ? { text: model.heading } : null,
  };
}

export async function discoverSite(page: Page, config: ProjectConfig, entry = '/', maxRoutes = 6): Promise<DiscoveredRoute[]> {
  const queue = [entry];
  const done = new Set<string>();
  const out: DiscoveredRoute[] = [];
  while (queue.length && out.length < maxRoutes) {
    const path = queue.shift()!;
    if (done.has(path)) continue;
    done.add(path);
    try {
      const route = await discoverRoute(page, config, path);
      out.push(route);
      const model = await page.evaluate(SITE_MODEL);
      for (const href of model.links) {
        const next = href.startsWith('/') ? href : `/${href}`;
        if (!done.has(next) && queue.length + out.length < maxRoutes * 2) queue.push(next);
      }
    } catch { /* an unreachable route is not a discovery failure */ }
  }
  return out;
}

/** A draft, with every expect bound to something that was seen. Never recorded unattended. */
export function draftStoryboard(id: string, feature: string, routes: DiscoveredRoute[]): Storyboard {
  // An app with one shared <h1> across every route would otherwise produce six
  // scenes with the same id, which collapses the chapters and the audio cache.
  // Prefer the path, which is unique by construction, and fall back to a suffix.
  const used = new Set<string>();
  const slugFor = (r: DiscoveredRoute, i: number): string => {
    const fromPath = r.path.replace(/^\/+|\/+$/g, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const fromHeading = (r.heading ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    let base = (fromPath || fromHeading || `scene-${i + 1}`).slice(0, 30).replace(/^-|-$/g, '') || `scene-${i + 1}`;
    if (!/^[a-z0-9]/.test(base)) base = `s-${base}`;
    let slug = base;
    let n = 2;
    while (used.has(slug)) slug = `${base}-${n++}`;
    used.add(slug);
    return slug;
  };

  const scenes: Scene[] = routes.map((r, i) => ({
    id: slugFor(r, i),
    // Deliberately a placeholder that reads as one. A draft that looks finished
    // is worse than one that obviously is not.
    narration: `TODO: what does ${r.heading ?? r.title} let the viewer understand?`,
    expect: r.anchor ? [r.anchor] : [],
    steps: [
      { do: 'goto' as const, path: r.path },
      ...(r.anchor ? [{ do: 'waitFor' as const, ...r.anchor }] : []),
      ...r.actions.slice(0, 1).map((a) => ({ do: 'highlight' as const, ...a.locator, ms: 1600 })),
    ],
  }));

  return {
    schemaVersion: 1,
    id,
    feature,
    opening: {
      // Every field of a draft says TODO on purpose. A draft that looks finished
      // is worse than one that obviously is not, and a kicker is a brand fact
      // the engine has no business choosing.
      kicker: 'TODO: a kicker, or empty',
      title: `TODO: the title`,
      subtitle: `TODO: one line`,
      disclaimer: '',
      narration: `TODO: what is this, in one sentence?`,
    },
    scenes,
    closing: { title: 'TODO', subtitle: 'TODO', narration: 'TODO: the closing line.' },
  };
}
