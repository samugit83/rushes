// Resolving a declarative locator descriptor to a real element, and explaining
// itself when it fails.
//
// Priority order is text > role > testId > css, and that order is deliberate: a
// storyboard written against visible text and ARIA roles survives a UI refactor
// that renames every class. `css` still works and is still last.

import type { Page, Locator as PwLocator } from 'playwright';
import type { Locator } from '../types.ts';

export function resolveLocator(page: Page, d: Locator): PwLocator {
  let loc: PwLocator;
  if (d.text) loc = page.getByText(d.text, { exact: d.exact ?? false });
  else if (d.role) loc = page.getByRole(d.role as Parameters<Page['getByRole']>[0], d.name ? { name: d.name } : undefined);
  else if (d.testId) loc = page.getByTestId(d.testId);
  else if (d.css) loc = page.locator(d.css);
  else throw new Error(`step has no locator (need css/text/role/testId): ${JSON.stringify(d)}`);
  if (d.css && (d.text || d.role || d.testId)) loc = loc.and(page.locator(d.css));
  return d.nth != null ? loc.nth(d.nth) : loc.first();
}

export function describeLocator(d: Locator): string {
  const parts: string[] = [];
  if (d.text) parts.push(`text=${JSON.stringify(d.text)}${d.exact ? ' (exact)' : ''}`);
  if (d.role) parts.push(`role=${d.role}${d.name ? ` name=${JSON.stringify(d.name)}` : ''}`);
  if (d.testId) parts.push(`testId=${d.testId}`);
  if (d.css) parts.push(`css=${d.css}`);
  if (d.nth != null) parts.push(`nth=${d.nth}`);
  return parts.join(' ') || '(none)';
}

export function locatorOf(step: Partial<Locator>): Locator | null {
  const { css, text, exact, role, name, testId, nth } = step;
  if (css == null && text == null && role == null && testId == null) return null;
  return { css, text, exact, role, name, testId, nth };
}

function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

export interface FixEvidence {
  supportedFixes: string[];
  evidence: Record<string, unknown>;
}

/**
 * The thirty lines that collapse most repair rounds to one.
 *
 * When a `text` locator misses, look at the text that IS on screen and offer the
 * three closest by edit distance. When a `css` locator misses, say how many
 * nodes matched: zero and several are different bugs with different fixes. And
 * dump a trimmed accessibility tree, so an agent can author the next locator
 * from evidence instead of guessing.
 */
export async function suggestFixes(page: Page, d: Locator | null): Promise<FixEvidence> {
  const evidence: Record<string, unknown> = {};
  const fixes: string[] = [];
  if (!d) return { supportedFixes: ['add a locator (text / role+name / testId / css)'], evidence };

  try {
    if (d.css) {
      const count = await page.locator(d.css).count();
      evidence.cssMatchCount = count;
      if (count === 0) fixes.push('the css selector matched nothing: use text or role instead');
      else if (count > 1) fixes.push(`the css selector matched ${count} elements: add "nth"`);
    }

    if (d.text) {
      const visible = await page.evaluate(() => {
        const out: string[] = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        let n = walker.currentNode as HTMLElement | null;
        while (n && out.length < 900) {
          const el = n as HTMLElement;
          if (el.children.length === 0) {
            const t = (el.innerText ?? el.textContent ?? '').trim();
            const r = el.getBoundingClientRect();
            if (t && t.length < 90 && r.width > 0 && r.height > 0) out.push(t);
          }
          n = walker.nextNode() as HTMLElement | null;
        }
        return [...new Set(out)];
      });
      const want = d.text.toLowerCase();
      const near = visible
        .map((t) => ({ t, d: editDistance(want, t.toLowerCase()) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 3)
        .map((x) => x.t);
      evidence.visibleAlternatives = near;
      for (const alt of near) fixes.push(`use "text": ${JSON.stringify(alt)}`);
    }

    if (d.role) {
      const names = await page.evaluate((role: string) => {
        const els = [...document.querySelectorAll(`[role="${role}"], ${role}`)] as HTMLElement[];
        return els.slice(0, 12)
          .map((e) => (e.getAttribute('aria-label') ?? e.innerText ?? '').trim())
          .filter(Boolean);
      }, d.role);
      evidence.roleNames = names;
      for (const n of names.slice(0, 3)) fixes.push(`use "role": ${JSON.stringify(d.role)}, "name": ${JSON.stringify(n)}`);
    }

    // The accessibility tree is how an agent authors a locator from evidence
    // rather than from a guess: roles and accessible names, which is exactly the
    // vocabulary the locator priority order prefers.
    const ax = await page.locator('body').ariaSnapshot().catch(() => null);
    if (ax) evidence.accessibilityTree = ax.split('\n').slice(0, 40).join('\n');
  } catch { /* the page may be mid-navigation; partial evidence is still useful */ }

  if (!fixes.length) fixes.push('nothing similar was on screen: check the previous step actually navigated');
  return { supportedFixes: [...new Set(fixes)].slice(0, 6), evidence };
}

