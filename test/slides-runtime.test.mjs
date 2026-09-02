// The connector pass, exercised in a real browser.
//
// Port spread and label placement are pure runtime JavaScript inside the deck,
// so nothing else in the suite touches them. They are also exactly the kind of
// code that looks right and is not: the previous version drew two arrows leaving
// one box from the identical point, and nothing said so, because nothing looked.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, assert, equal } from './harness.mjs';

const CONFIG = {
  schemaVersion: 1,
  baseUrl: 'http://127.0.0.1:8787',
  allowHosts: ['127.0.0.1'],
  auth: { kind: 'none' },
};

/** A throwaway project with one slide, rendered and measured. */
async function measure(slide) {
  const root = mkdtempSync(join(tmpdir(), 'rushes-deck-'));
  const previous = process.env.RUSHES_PROJECT_ROOT;
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
    const [rendered] = await renderSlides({ slides: compiled.slides, measureOnly: true });
    return rendered.measurement;
  } finally {
    if (previous === undefined) delete process.env.RUSHES_PROJECT_ROOT;
    else process.env.RUSHES_PROJECT_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

const flow = (connectors) => ({
  schemaVersion: 1,
  id: 'ports',
  mode: 'composed',
  block: 'flow-row',
  title: 'Ports',
  items: [
    { id: 'hub', label: 'Broker' },
    { id: 'one', label: 'Worker one' },
    { id: 'two', label: 'Worker two' },
  ],
  connectors,
});

await test('the deck publishes the stroke it actually drew', async () => {
  const m = await measure(flow([{ from: 'hub', to: 'one' }]));
  assert(m, 'the slide was measured');
  assert(m.geometry, 'geometry was published');
  equal(m.geometry.connectors.length, 1);
  const route = m.geometry.connectors[0];
  assert(route.points.length > 10, `expected a sampled polyline, got ${route.points.length} points`);
  assert(route.points.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])), 'every sample is finite');
  // Every addressable box is reported, so the checker can ask what a route ran through.
  assert(m.geometry.nodes.some((n) => n.id === 'two'), 'boxes with no connector are still measured');
});

await test('two routes leaving one box do not leave from the same point', async () => {
  const m = await measure(flow([{ from: 'hub', to: 'one' }, { from: 'hub', to: 'two' }]));
  const [a, b] = m.geometry.connectors;
  const startA = a.points[0];
  const startB = b.points[0];
  const apart = Math.hypot(startA[0] - startB[0], startA[1] - startB[1]);
  assert(apart > 1, `the two ports coincide (${apart.toFixed(2)}px apart); port spread did not run`);
  // They still leave the same side of the same box, so they share an x.
  assert(Math.abs(startA[0] - startB[0]) < 1, 'both still leave the same side');
});

await test('a single route is not spread, so an ordinary diagram is unchanged', async () => {
  const m = await measure(flow([{ from: 'one', to: 'two' }]));
  const route = m.geometry.connectors[0];
  const box = m.geometry.nodes.find((n) => n.id === 'one');
  const centreY = box.rect.y + box.rect.height / 2;
  assert(Math.abs(route.points[0][1] - centreY) < 1.5,
    `a lone route should leave the side midpoint, left from ${route.points[0][1]} not ${centreY}`);
});

await test('a connector label is measured and reported with its box', async () => {
  const m = await measure(flow([{ from: 'one', to: 'two', label: 'publishes' }]));
  const route = m.geometry.connectors[0];
  equal(route.label, 'publishes');
  assert(route.labelRect, 'the label reported a measured box');
  assert(route.labelRect.width > 0 && route.labelRect.height > 0, 'the box has real dimensions');
});

await test('an anchor naming no item is reported, not silently dropped', async () => {
  const m = await measure(flow([{ from: 'hub', to: 'nowhere' }]));
  equal(m.geometry.connectors.length, 0, 'nothing was drawn');
  equal(m.unmeasurable, ['hub->nowhere']);
});
