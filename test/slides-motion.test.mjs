// The styled/animated diagrams (glow, flowing edges, beat pulse) must not move
// a box's geometry. Motion is opacity and glow only; the moment an effect
// translates or scales a box, the connectors — measured once at the settled
// size — detach from it. That regression shipped once (a 10px entrance offset
// on every arrow in every diagram) and was invisible except under measurement.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, assert } from './harness.mjs';
import { fileURLToPath } from 'node:url';

const CONFIG = { schemaVersion: 1, baseUrl: 'http://127.0.0.1:8787', allowHosts: ['127.0.0.1'], auth: { kind: 'none' } };

async function measure(slide) {
  const root = mkdtempSync(join(tmpdir(), 'rushes-motion-'));
  const prev = process.env.RUSHES_PROJECT_ROOT;
  process.env.RUSHES_PROJECT_ROOT = root;
  try {
    mkdirSync(join(root, 'slides', 'src'), { recursive: true });
    writeFileSync(join(root, 'rushes.config.json'), JSON.stringify(CONFIG));
    writeFileSync(join(root, 'slides', 'src', `${slide.id}.slide.json`), JSON.stringify(slide));
    const { loadConfig } = await import('../lib/projectConfig.ts');
    const { compileDeck } = await import('../lib/slides/compile.ts');
    const { renderSlides } = await import('../lib/slides/render.ts');
    const { config } = loadConfig(root);
    const compiled = compileDeck({ config, root });
    const [r] = await renderSlides({ slides: compiled.slides, measureOnly: true });
    return r.measurement;
  } finally {
    if (prev === undefined) delete process.env.RUSHES_PROJECT_ROOT; else process.env.RUSHES_PROJECT_ROOT = prev;
    rmSync(root, { recursive: true, force: true });
  }
}

const flow = {
  schemaVersion: 1, id: 'motion', mode: 'composed', block: 'flow-row', title: 'Motion',
  items: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }, { id: 'c', label: 'Gamma' }],
  connectors: [{ from: 'a', to: 'b', label: 'one' }, { from: 'b', to: 'c', label: 'two' }],
};

await test('regression: no beat or entrance effect moves a box (connectors would detach)', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'slides', 'runtime', 'blocks.css'),
    'utf8');

  // Connectors are measured once, at the settled box size, and never redrawn
  // while a scene holds. So any transform on a node-state or entrance effect
  // moves the box out from under its arrows — invisible in the still (which
  // freezes to settled) but wrong for the whole recorded scene. This is the
  // 10px entrance offset that shipped once; it is caught at the source because
  // the render path re-settles and hides it.
  const region = (name) => {
    const i = css.indexOf(name);
    assert(i >= 0, `${name} exists in blocks.css`);
    // the rule/keyframes body: from the name to the matching close of its block
    const open = css.indexOf('{', i);
    let depth = 0, j = open;
    for (; j < css.length; j++) { if (css[j] === '{') depth++; else if (css[j] === '}') { depth--; if (depth === 0) break; } }
    return css.slice(open, j + 1);
  };
  for (const name of ['@keyframes node-enter', '@keyframes node-pulse',
    '[data-node][data-focus]', '[data-node][data-highlight]']) {
    assert(!/transform\s*:/.test(region(name)),
      `${name} must not use transform — motion is opacity and glow only, never geometry`);
  }
});

await test('the settled render has connectors on their box centres', async () => {
  const m = await measure(flow);
  const g = m.geometry;
  const centre = (id) => { const n = g.nodes.find((x) => x.id === id); return n.rect.y + n.rect.height / 2; };
  for (const c of g.connectors) {
    assert(Math.abs(c.points[0][1] - centre(c.from)) <= 3, `${c.from}->${c.to} start off centre`);
    assert(Math.abs(c.points[c.points.length - 1][1] - centre(c.to)) <= 3, `${c.from}->${c.to} end off centre`);
  }
});

await test('the styled render is deterministic (motion frozen to a settled frame)', async () => {
  const a = await measure(flow);
  const b = await measure(flow);
  // Same geometry both times: connector count, node count, and every endpoint.
  assert(a.geometry.connectors.length === b.geometry.connectors.length, 'same connector count');
  const flat = (m) => m.geometry.connectors.flatMap((c) => [c.points[0], c.points.at(-1)]).map((p) => p.map(Math.round));
  assert(JSON.stringify(flat(a)) === JSON.stringify(flat(b)),
    'the two renders resolved every endpoint to the same pixel');
});

// --- Tier 3: the layers block (lanes) ------------------------------------
await test('the layers block counts nodes across lanes and renders each with a data-node', async () => {
  const { itemCount, renderBlock } = await import('../lib/slides/blocks.ts');
  const { CAPACITY } = await import('../lib/slides/types.ts');
  const slide = {
    mode: 'composed', block: 'layers',
    lanes: [
      { id: 'a', label: 'A', items: [{ id: 'x', label: 'X' }] },
      { id: 'b', label: 'B', items: [{ id: 'y', label: 'Y' }, { id: 'z', label: 'Z' }] },
    ],
  };
  // capacity is a whole-slide count across every lane
  assert(itemCount(slide) === 3, 'three nodes across two lanes');
  assert(CAPACITY.layers >= 3, 'layers has a real capacity');
  const html = renderBlock(slide);
  assert(/class="block-layers"/.test(html), 'renders a layers block');
  assert(/class="lane"/.test(html) && html.match(/class="lane"/g).length === 2, 'one band per lane');
  for (const id of ['x', 'y', 'z']) {
    assert(html.includes(`data-node="${id}"`), `node ${id} is addressable (beats + connectors)`);
  }
  assert(/lane-label">A</.test(html) && /lane-label">B</.test(html), 'lanes carry their labels');
});
