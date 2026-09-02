// The connector composition detectors.
//
// These are pure functions over measured input, so the whole suite runs without
// a browser. That is deliberate: the browser's job is to report where the stroke
// actually went, and this file's job is to decide whether that is a defect.

import { test, assert, equal, near } from './harness.mjs';
import {
  analyseGeometry,
  polylineIntersectsRect,
  projectedTextPx,
  properSegmentIntersection,
  rectsOverlap,
  requiredSourceTextPx,
  sharedCorridorLength,
} from '../lib/slides/geometry.ts';

const box = (id, x, y, width = 100, height = 60) => ({ id, rect: { x, y, width, height } });

/** A straight route, sampled the way the deck runtime samples a drawn path. */
function straight(from, to, a, b, opts = {}) {
  const points = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    points.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return { from, to, label: opts.label ?? null, points, labelRect: opts.labelRect ?? null };
}

const scene = (nodes, connectors) => ({
  frame: { width: 1920, height: 1080 },
  nodes,
  connectors,
  unmeasurable: [],
});

test('a proper crossing is found, and a shared endpoint is not a crossing', () => {
  const hit = properSegmentIntersection([0, 0], [10, 10], [0, 10], [10, 0]);
  assert(hit !== null, 'the two diagonals cross');
  near(hit[0], 5, 0.001);
  near(hit[1], 5, 0.001);

  // Touching at an endpoint is a fan-out, which is real topology, not a defect.
  equal(properSegmentIntersection([0, 0], [10, 10], [10, 10], [20, 0]), null, 'endpoint touch');
  // Collinear overlap is the corridor detector's business, not this one's.
  equal(properSegmentIntersection([0, 0], [10, 0], [5, 0], [15, 0]), null, 'collinear');
});

test('a route through an unrelated box is reported, and one that only connects is not', () => {
  const nodes = [box('a', 0, 0), box('b', 300, 0), box('c', 600, 0)];
  // a -> c at the same y runs straight through b.
  const issues = analyseGeometry(scene(nodes, [straight('a', 'c', [100, 30], [600, 30])]));
  const through = issues.filter((i) => i.kind === 'edge-through-node');
  equal(through.length, 1, 'exactly one box was crossed');
  equal(through[0].evidence.node, 'b');

  // The same route drawn only between neighbours touches nothing else.
  const clean = analyseGeometry(scene(nodes, [straight('a', 'b', [100, 30], [300, 30])]));
  equal(clean.filter((i) => i.kind === 'edge-through-node').length, 0);
});

test('two unrelated routes that cross are reported, and a shared fan-out is not', () => {
  const nodes = [box('a', 0, 0), box('b', 0, 300), box('c', 600, 0), box('d', 600, 300)];
  const crossing = analyseGeometry(scene(nodes, [
    straight('a', 'd', [100, 30], [600, 330]),
    straight('b', 'c', [100, 330], [600, 30]),
  ]));
  equal(crossing.filter((i) => i.kind === 'route-crossing').length, 1);

  // Both leaving "a" is a fan-out: exempt, because it is authored topology.
  const fanOut = analyseGeometry(scene(nodes, [
    straight('a', 'd', [100, 30], [600, 330]),
    straight('a', 'c', [100, 30], [600, 30]),
  ]));
  equal(fanOut.filter((i) => i.kind === 'route-crossing').length, 0);
});

test('two unrelated routes running together share a corridor', () => {
  const a = straight('a', 'b', [0, 100], [400, 100]);
  const b = straight('c', 'd', [0, 103], [400, 103]);
  const shared = sharedCorridorLength(a.points, b.points, 8);
  assert(shared > 300, `expected a long shared run, got ${shared}`);

  const nodes = [box('a', -200, 80), box('b', 420, 80), box('c', -200, 200), box('d', 420, 200)];
  const issues = analyseGeometry(scene(nodes, [a, b]));
  equal(issues.filter((i) => i.kind === 'route-corridor').length, 1);

  // Far apart is not a corridor.
  const apart = straight('c', 'd', [0, 400], [400, 400]);
  equal(sharedCorridorLength(a.points, apart.points, 8), 0);
});

test('a label that covers a box, a route or another label is reported', () => {
  const nodes = [box('a', 0, 0), box('b', 600, 0), box('victim', 250, 0, 120, 60)];
  const labelOverBox = analyseGeometry(scene(nodes, [
    { ...straight('a', 'b', [100, 200], [600, 200]), label: 'writes', labelRect: { x: 260, y: 10, width: 90, height: 30 } },
  ]));
  equal(labelOverBox.filter((i) => i.kind === 'label-node').length, 1);

  const two = analyseGeometry(scene([box('a', 0, 0), box('b', 600, 0)], [
    { ...straight('a', 'b', [100, 200], [600, 200]), label: 'reads', labelRect: { x: 300, y: 150, width: 80, height: 30 } },
    { ...straight('c', 'd', [100, 400], [600, 400]), label: 'writes', labelRect: { x: 320, y: 160, width: 80, height: 30 } },
  ]));
  equal(two.filter((i) => i.kind === 'label-label').length, 1);
});

test('rect and polyline helpers agree with the obvious cases', () => {
  assert(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }));
  assert(!rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 0, width: 10, height: 10 }));
  // A gap turns a near miss into an overlap, which is how route clearance works.
  assert(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 12, y: 0, width: 10, height: 10 }, 4));
  assert(polylineIntersectsRect([[0, 5], [20, 5]], { x: 5, y: 0, width: 5, height: 10 }));
  assert(!polylineIntersectsRect([[0, 50], [20, 50]], { x: 5, y: 0, width: 5, height: 10 }));
});

test('readability is measured as projected, not as authored', () => {
  // 22px authored in a 1920 frame arrives as about 7px in a 640px player.
  near(projectedTextPx(22, 1920, 640), 7.33, 0.01);
  // So clearing a 10px floor there needs 30px authored.
  equal(requiredSourceTextPx(1920, 640, 10), 30);
  // A player at least as wide as the frame projects one to one.
  equal(projectedTextPx(22, 1920, 2560), 22);
});
