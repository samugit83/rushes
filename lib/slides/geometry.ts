// Composition analysis for the drawn connectors.
//
// Until this existed the slide half measured text carefully (face, size,
// contrast, overflow, safe area) and measured NOTHING about the arrows. A
// connector could run straight through an unrelated box, two could sit on top of
// each other, and a label could cover a route, and every check stayed green.
//
// The detectors here are ported in spirit from `tt-a1i/archify` (MIT), whose
// `renderers/shared/geometry.mjs` names each of these as a distinct, measurable
// defect rather than a matter of taste. Two deliberate differences:
//
//   1. Archify PREDICTS geometry, because it emits a static file with no layout
//      pass. This measures the stroke the browser actually drew, sampled off the
//      SVG path. There is nothing to predict, so there is nothing to be wrong
//      about.
//   2. Archify routes orthogonally, so it can enforce a minimum straight-segment
//      length ("route rhythm"). Our connectors are curves, which have no
//      segments, so that check is deliberately absent rather than approximated.
//      A curve's real failure modes are the four below.
//
// Every function is pure and takes measured input, so the whole module is
// testable without a browser.

export type Point = [number, number];

export interface Rect { x: number; y: number; width: number; height: number }

export interface MeasuredNode { id: string; rect: Rect }

export interface MeasuredConnector {
  from: string;
  to: string;
  label: string | null;
  /** The drawn stroke, sampled off the SVG path in the deck runtime. */
  points: Point[];
  /** The label's rendered box, already inflated by its mask padding. */
  labelRect: Rect | null;
}

export interface SlideGeometry {
  frame: { width: number; height: number };
  nodes: MeasuredNode[];
  connectors: MeasuredConnector[];
  /** Connector anchors that resolved to no element. */
  unmeasurable: string[];
}

export type IssueKind =
  | 'edge-through-node'
  | 'route-crossing'
  | 'route-corridor'
  | 'label-node'
  | 'label-label'
  | 'label-route';

export interface GeometryIssue {
  kind: IssueKind;
  /** Human sentence, already naming both parties. */
  message: string;
  evidence: Record<string, unknown>;
}

export interface AnalyseOptions {
  /** Clearance demanded between a route and a box it does not connect to. */
  nodeGapPx?: number;
  /** Two routes closer than this are considered to share a corridor. */
  corridorGapPx?: number;
  /** Shared corridor shorter than this is rounding, not a defect. */
  corridorMinPx?: number;
}

const DEFAULTS = { nodeGapPx: 2, corridorGapPx: 8, corridorMinPx: 40 };

// --- primitives ----------------------------------------------------------

export function rectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.width + gap
    && b.x < a.x + a.width + gap
    && a.y < b.y + b.height + gap
    && b.y < a.y + a.height + gap;
}

function orientation(a: Point, b: Point, c: Point): number {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(v) < 1e-9) return 0;
  return v > 0 ? 1 : -1;
}

/**
 * A PROPER crossing only: four strictly opposite orientations. Touching
 * endpoints and collinear overlap return null on purpose, because a fan-out
 * from a shared box is real topology and a shared corridor is a different
 * defect with its own detector.
 */
export function properSegmentIntersection(a: Point, b: Point, c: Point, d: Point): Point | null {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 === 0 || o2 === 0 || o3 === 0 || o4 === 0) return null;
  if (o1 === o2 || o3 === o4) return null;

  const denominator = (a[0] - b[0]) * (c[1] - d[1]) - (a[1] - b[1]) * (c[0] - d[0]);
  if (Math.abs(denominator) < 1e-9) return null;
  const pre = a[0] * b[1] - a[1] * b[0];
  const post = c[0] * d[1] - c[1] * d[0];
  return [
    (pre * (c[0] - d[0]) - (a[0] - b[0]) * post) / denominator,
    (pre * (c[1] - d[1]) - (a[1] - b[1]) * post) / denominator,
  ];
}

function onSegment(a: Point, b: Point, p: Point): boolean {
  return Math.min(a[0], b[0]) - 1e-9 <= p[0] && p[0] <= Math.max(a[0], b[0]) + 1e-9
    && Math.min(a[1], b[1]) - 1e-9 <= p[1] && p[1] <= Math.max(a[1], b[1]) + 1e-9;
}

/**
 * The degenerate half of a crossing: two segments that meet at a point without
 * four strictly opposite orientations.
 *
 * This is not a corner case in practice, it is the COMMON case. Both routes are
 * sampled at the same fixed fraction of their length, so two straight routes
 * that cross at their midpoints land a vertex on the intersection exactly, every
 * orientation test reads zero, and a real crossing measures as clean. The first
 * version of this module shipped that hole and the test caught it.
 *
 * Fully collinear pairs return null: an overlap is the corridor detector's
 * business, and reporting it here would name the wrong defect.
 */
export function segmentTouchPoint(a: Point, b: Point, c: Point, d: Point): Point | null {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 === 0 && o2 === 0 && o3 === 0 && o4 === 0) return null; // collinear
  if (o1 === 0 && onSegment(a, b, c)) return c;
  if (o2 === 0 && onSegment(a, b, d)) return d;
  if (o3 === 0 && onSegment(c, d, a)) return a;
  if (o4 === 0 && onSegment(c, d, b)) return b;
  return null;
}

export function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export function pointPolylineDistance(p: Point, points: Point[]): number {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    best = Math.min(best, pointSegmentDistance(p, points[i], points[i + 1]));
    if (best === 0) return 0;
  }
  return best;
}

/** Clip-free segment/rect test: either end inside, or a side is crossed. */
export function segmentIntersectsRect(a: Point, b: Point, rect: Rect, gap = 0): boolean {
  const box = {
    x: rect.x - gap, y: rect.y - gap,
    width: rect.width + gap * 2, height: rect.height + gap * 2,
  };
  const inside = (p: Point) => p[0] >= box.x && p[0] <= box.x + box.width
    && p[1] >= box.y && p[1] <= box.y + box.height;
  if (inside(a) || inside(b)) return true;

  const corners: Point[] = [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x + box.width, box.y + box.height],
    [box.x, box.y + box.height],
  ];
  for (let i = 0; i < 4; i++) {
    if (properSegmentIntersection(a, b, corners[i], corners[(i + 1) % 4])) return true;
  }
  return false;
}

export function polylineIntersectsRect(points: Point[], rect: Rect, gap = 0): boolean {
  for (let i = 0; i < points.length - 1; i++) {
    if (segmentIntersectsRect(points[i], points[i + 1], rect, gap)) return true;
  }
  return false;
}

// --- the detectors -------------------------------------------------------

function sharesEndpoint(a: MeasuredConnector, b: MeasuredConnector): boolean {
  return a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to;
}

function name(c: MeasuredConnector): string {
  return `"${c.from}" to "${c.to}"`;
}

function polylineLength(points: Point[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
  }
  return total;
}

/**
 * Two unrelated routes running side by side read as one authored branch even
 * when neither crosses the other. On an orthogonal renderer this is collinear
 * overlap; on a curve it is sustained proximity, so it is measured as the arc
 * length over which one route stays within `corridorGapPx` of the other.
 */
export function sharedCorridorLength(a: Point[], b: Point[], gapPx: number): number {
  let shared = 0;
  for (let i = 0; i < a.length - 1; i++) {
    const midpoint: Point = [(a[i][0] + a[i + 1][0]) / 2, (a[i][1] + a[i + 1][1]) / 2];
    if (pointPolylineDistance(midpoint, b) <= gapPx) {
      shared += Math.hypot(a[i + 1][0] - a[i][0], a[i + 1][1] - a[i][1]);
    }
  }
  return shared;
}

export function analyseGeometry(geometry: SlideGeometry, opts: AnalyseOptions = {}): GeometryIssue[] {
  const nodeGap = opts.nodeGapPx ?? DEFAULTS.nodeGapPx;
  const corridorGap = opts.corridorGapPx ?? DEFAULTS.corridorGapPx;
  const corridorMin = opts.corridorMinPx ?? DEFAULTS.corridorMinPx;

  const issues: GeometryIssue[] = [];
  const routes = geometry.connectors.filter((c) => Array.isArray(c.points) && c.points.length >= 2);

  // 1. A route through a box it does not connect. Archify calls this a hard
  //    failure at every profile, and it is: the picture states a relationship
  //    that the source never declared.
  for (const route of routes) {
    for (const node of geometry.nodes) {
      if (node.id === route.from || node.id === route.to) continue;
      // A collapsed box paints nothing, so a route across it is not a defect a
      // viewer could ever see. The runtime filters these out too; the analyser
      // repeats the rule because it is a public function over measured input.
      if (!(node.rect.width > 0) || !(node.rect.height > 0)) continue;
      if (!polylineIntersectsRect(route.points, node.rect, nodeGap)) continue;
      issues.push({
        kind: 'edge-through-node',
        message: `the connector ${name(route)} passes through the unrelated box "${node.id}"`,
        evidence: { from: route.from, to: route.to, node: node.id, rect: node.rect },
      });
    }
  }

  // 2. Two unrelated routes that actually cross.
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const left = routes[i];
      const right = routes[j];
      if (sharesEndpoint(left, right)) continue;

      let hit: Point | null = null;
      for (let a = 0; a < left.points.length - 1 && !hit; a++) {
        for (let b = 0; b < right.points.length - 1 && !hit; b++) {
          hit = properSegmentIntersection(
            left.points[a], left.points[a + 1],
            right.points[b], right.points[b + 1],
          ) ?? segmentTouchPoint(
            left.points[a], left.points[a + 1],
            right.points[b], right.points[b + 1],
          );
        }
      }
      if (hit) {
        issues.push({
          kind: 'route-crossing',
          message: `the connector ${name(left)} crosses ${name(right)}`,
          evidence: {
            at: [Math.round(hit[0]), Math.round(hit[1])],
            first: [left.from, left.to],
            second: [right.from, right.to],
          },
        });
        continue;
      }

      // 3. No crossing, but the same corridor.
      const shared = Math.max(
        sharedCorridorLength(left.points, right.points, corridorGap),
        sharedCorridorLength(right.points, left.points, corridorGap),
      );
      if (shared >= corridorMin) {
        issues.push({
          kind: 'route-corridor',
          message: `the connectors ${name(left)} and ${name(right)} share ${Math.round(shared)}px of corridor`,
          evidence: {
            sharedPx: Math.round(shared),
            gapPx: corridorGap,
            first: [left.from, left.to],
            second: [right.from, right.to],
            firstLengthPx: Math.round(polylineLength(left.points)),
          },
        });
      }
    }
  }

  // 4. Labels. A label is semantic data, so a collision is repaired by moving
  //    it or shortening the wording, never by deleting the meaning.
  const labelled = routes.filter((c) => c.labelRect && c.label);
  for (const route of labelled) {
    for (const node of geometry.nodes) {
      if (!rectsOverlap(route.labelRect!, node.rect)) continue;
      issues.push({
        kind: 'label-node',
        message: `the label "${route.label}" on ${name(route)} covers the box "${node.id}"`,
        evidence: { label: route.label, node: node.id, labelRect: route.labelRect },
      });
    }
    for (const other of routes) {
      if (other === route) continue;
      if (sharesEndpoint(route, other)) continue;
      if (!polylineIntersectsRect(other.points, route.labelRect!)) continue;
      issues.push({
        kind: 'label-route',
        message: `the label "${route.label}" on ${name(route)} masks the connector ${name(other)}`,
        evidence: { label: route.label, masked: [other.from, other.to], labelRect: route.labelRect },
      });
    }
  }
  for (let i = 0; i < labelled.length; i++) {
    for (let j = i + 1; j < labelled.length; j++) {
      if (!rectsOverlap(labelled[i].labelRect!, labelled[j].labelRect!)) continue;
      issues.push({
        kind: 'label-label',
        message: `the labels "${labelled[i].label}" and "${labelled[j].label}" overlap`,
        evidence: {
          first: labelled[i].label, second: labelled[j].label,
          firstRect: labelled[i].labelRect, secondRect: labelled[j].labelRect,
        },
      });
    }
  }

  return issues;
}

/**
 * The size a viewer actually sees, which is the only size that matters.
 *
 * A slide is authored in a 1920-wide frame and checked against a 22px floor
 * there, but it is watched inside a video player that is often 640px wide or
 * less. Archify measures the same thing for its desktop reader; for a video the
 * projection is harsher, so the check earns more.
 */
export function projectedTextPx(sourcePx: number, frameWidth: number, viewingWidth: number): number {
  if (![sourcePx, frameWidth, viewingWidth].every(Number.isFinite) || frameWidth <= 0 || viewingWidth <= 0) {
    return Number.NaN;
  }
  return sourcePx * Math.min(1, viewingWidth / frameWidth);
}

/** The authored size needed to clear `minProjectedPx` once projected. */
export function requiredSourceTextPx(frameWidth: number, viewingWidth: number, minProjectedPx: number): number {
  const scale = Math.min(1, viewingWidth / frameWidth);
  if (!Number.isFinite(scale) || scale <= 0) return Number.NaN;
  return Math.ceil(minProjectedPx / scale);
}
