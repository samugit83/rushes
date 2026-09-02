/* The deck runtime. One hash-routed page holds every slide, which is what makes
 * four things possible at once: one embedded font and one stylesheet instead of
 * twenty copies, shared-element morphing between slides that share a box,
 * persistent state so a later slide can add a layer to an earlier one instead of
 * redrawing the system from scratch, and a crossfade instead of a hard cut.
 *
 * The recorder talks to exactly three things, and nothing else is public:
 *   window.__slide.beat(n, beat)  fire beat n; returns false if it could not
 *   window.__slide.beats          how many beats the current slide declares
 *   window.__slide.reset()        put the slide back to its initial state
 *
 * Connectors are drawn AFTER layout from getBoundingClientRect(), never
 * predicted. Routing stays trivial because each block constrains topology:
 * flow-row connects adjacent boxes, sequence connects participant to
 * participant, hub connects centre to satellite. There is never an obstacle to
 * route around, which is the entire reason this needs no solver.
 *
 * Three things the connector pass does beyond drawing a line:
 *   - ports that would coincide fan out across their own side (spreadPorts), so
 *     two relationships leaving one box read as two, not as one thick arrow;
 *   - a label is measured and placed where it covers nothing, trying four
 *     alternatives before it gives up;
 *   - the drawn stroke is SAMPLED off the path and published as
 *     window.__slideGeometry, so the checker can measure crossings, corridors
 *     and routes through unrelated boxes against the picture rather than
 *     against a prediction of it.
 */
(function () {
  'use strict';

  var current = null;

  function slides() {
    return Array.prototype.slice.call(document.querySelectorAll('.slide'));
  }

  function byId(id) {
    return document.querySelector('.slide[data-slide="' + CSS.escape(id) + '"]');
  }

  function layoutHub(slide) {
    var hub = slide.querySelector('.block-hub');
    if (!hub) return;
    var sats = Array.prototype.slice.call(hub.querySelectorAll('.satellite'));
    var rect = hub.getBoundingClientRect();
    // Push satellites well clear of the centre. The vertical reach is the tight
    // one on a wide frame, so it gets a smaller inset than the horizontal —
    // otherwise a due-north or due-south satellite hugs the centre box while the
    // east/west ones float free, which is the cramped four-node cross this
    // avoids.
    var rx = rect.width / 2 - 150;
    var ry = rect.height / 2 - 60;
    sats.forEach(function (el, i) {
      var a = (-Math.PI / 2) + (i * 2 * Math.PI) / sats.length;
      el.style.left = (50 + (Math.cos(a) * rx * 100) / rect.width) + '%';
      el.style.top = (50 + (Math.sin(a) * ry * 100) / rect.height) + '%';
    });
  }

  /* Where a route leaves a box. A side is a direction contract: the stroke
   * starts perpendicular to the named side and ends perpendicular to the
   * other, so a reader can tell at a glance which way the relationship runs. */
  function connectorSides(ra, rb) {
    if (Math.abs(rb.left - ra.left) >= Math.abs(rb.top - ra.top)) {
      var leftFirst = ra.left <= rb.left;
      return { from: leftFirst ? 'right' : 'left', to: leftFirst ? 'left' : 'right', horizontal: true };
    }
    var topFirst = ra.top <= rb.top;
    return { from: topFirst ? 'bottom' : 'top', to: topFirst ? 'top' : 'bottom', horizontal: false };
  }

  function isVerticalSide(side) { return side === 'left' || side === 'right'; }

  /* A port, offset along its own side and expressed in the SVG's coordinate
   * space (which is the body box, because the layer is inset:0 inside it). */
  function portPoint(rect, side, offset, origin) {
    var cx = rect.left + rect.width / 2 - origin.left;
    var cy = rect.top + rect.height / 2 - origin.top;
    switch (side) {
      case 'right':  return { x: rect.right - origin.left, y: cy + offset };
      case 'left':   return { x: rect.left - origin.left, y: cy + offset };
      case 'bottom': return { x: cx + offset, y: rect.bottom - origin.top };
      default:       return { x: cx + offset, y: rect.top - origin.top };
    }
  }

  /* Automatic port spread.
   *
   * Two routes leaving the same box used to start at the identical midpoint and
   * draw on top of each other, which reads as one thick arrow rather than two
   * relationships. Shared ports now fan out deterministically across their own
   * side, keeping a corner gutter so a port never lands on a rounded corner.
   * Ported from archify's `automaticPortSpread`; the numbers are theirs because
   * they are tuned against the same problem. */
  var PORT_GUTTER = 16;
  var PORT_MAX_SPACING = 14;

  function spreadPorts(endpoints) {
    var groups = {};
    endpoints.forEach(function (e) {
      var key = e.nodeId + '|' + e.side;
      (groups[key] = groups[key] || []).push(e);
    });
    Object.keys(groups).forEach(function (key) {
      var group = groups[key];
      if (group.length < 2) return;
      // Order by where the other end sits on the cross axis, so the fan does
      // not braid: the topmost target gets the topmost port.
      group.sort(function (a, b) { return a.cross - b.cross; });
      var rect = group[0].rect;
      var extent = isVerticalSide(group[0].side) ? rect.height : rect.width;
      var span = Math.max(0, extent - PORT_GUTTER * 2);
      if (span <= 0) return;
      var spacing = Math.min(PORT_MAX_SPACING, span / (group.length - 1));
      var total = spacing * (group.length - 1);
      group.forEach(function (e, i) { e.offset = -total / 2 + i * spacing; });
    });
  }

  /* Sample the stroke the browser actually drew. Predicting a curve's path and
   * then checking the prediction would measure the prediction; asking the path
   * element measures the picture. */
  var ROUTE_SAMPLES = 48;

  function samplePath(pathEl) {
    var points = [];
    var length = 0;
    try { length = pathEl.getTotalLength(); } catch (e) { return points; }
    if (!isFinite(length) || length <= 0) return points;
    for (var i = 0; i <= ROUTE_SAMPLES; i++) {
      try {
        var p = pathEl.getPointAtLength((length * i) / ROUTE_SAMPLES);
        points.push([p.x, p.y]);
      } catch (e) { break; }
    }
    return points;
  }

  function rectsOverlap(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width
      && a.y < b.y + b.height && b.y < a.y + a.height;
  }

  /* Does a box sit on a drawn route? Sampled points are dense enough that a
   * point test is equivalent to a segment test at label scale. */
  function rectHitsPolyline(rect, points) {
    for (var i = 0; i < points.length; i++) {
      var x = points[i][0];
      var y = points[i][1];
      if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) return true;
    }
    return false;
  }

  var LABEL_PAD = 6;

  function labelBox(textEl) {
    var b;
    try { b = textEl.getBBox(); } catch (e) { return null; }
    if (!b || !isFinite(b.width) || !b.width) return null;
    return { x: b.x - LABEL_PAD, y: b.y - LABEL_PAD, width: b.width + LABEL_PAD * 2, height: b.height + LABEL_PAD * 2 };
  }

  /* Place a connector label where it does not cover something else.
   *
   * The old code dropped every label at the midpoint minus 26px and hoped. Two
   * things are searched now, and the second one matters more than it looks:
   *
   *   ALONG the route, which handles a long route crowded at one end, and
   *   AWAY from it, which is the only thing that helps the commonest case of
   *   all. A label between two adjacent boxes is wider than the gap between
   *   them, so every position along that short stroke overlaps the same two
   *   boxes; sliding it sideways can never clear anything. It has to move out
   *   of the row.
   *
   * A label that still collides after both searches becomes a diagnostic rather
   * than a thing you notice on the fourth viewing. */
  var LABEL_STOPS = [0.5, 0.38, 0.62, 0.28, 0.72];
  var LABEL_AWAY = [22, 52, 84, 118, -52, -84];

  function placeLabel(svg, pathEl, text, obstacles, routes) {
    var length = 0;
    try { length = pathEl.getTotalLength(); } catch (e) { return null; }
    if (!isFinite(length) || length <= 0) return null;

    var el = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    el.setAttribute('class', 'conn-label');
    el.setAttribute('text-anchor', 'middle');
    el.textContent = text;
    svg.appendChild(el);

    var best = null;
    for (var a = 0; a < LABEL_AWAY.length; a++) {
      for (var i = 0; i < LABEL_STOPS.length; i++) {
        var at = pathEl.getPointAtLength(length * LABEL_STOPS[i]);
        var ahead = pathEl.getPointAtLength(Math.min(length, length * LABEL_STOPS[i] + 8));
        var horizontal = Math.abs(ahead.x - at.x) >= Math.abs(ahead.y - at.y);
        var away = LABEL_AWAY[a];
        // Perpendicular to the run: above or below a horizontal stroke, left or
        // right of a vertical one.
        el.setAttribute('x', String(horizontal ? at.x : at.x + away + 12));
        el.setAttribute('y', String(horizontal ? at.y - away : at.y + 5));
        var box = labelBox(el);
        if (!box) { a = LABEL_AWAY.length; break; }
        if (!best) best = { box: box, x: el.getAttribute('x'), y: el.getAttribute('y') };
        var clear = true;
        for (var j = 0; j < obstacles.length; j++) {
          if (rectsOverlap(box, obstacles[j])) { clear = false; break; }
        }
        // A label placed on top of a route it does not belong to reads as that
        // route's label. Avoiding boxes but not strokes left the checker
        // reporting collisions that placement had never even tried to dodge.
        if (clear) {
          for (var k = 0; k < routes.length; k++) {
            if (routes[k].path !== pathEl && rectHitsPolyline(box, routes[k].points)) { clear = false; break; }
          }
        }
        // Never solve a collision by pushing the label out of the frame.
        if (clear && (box.x < 0 || box.y < 0)) clear = false;
        if (clear) return { el: el, box: box };
      }
    }
    if (best) { el.setAttribute('x', best.x); el.setAttribute('y', best.y); return { el: el, box: best.box }; }
    return { el: el, box: null };
  }

  /* Orthogonal routing for lane diagrams: right-angle paths that travel in the
   * gap BETWEEN lanes, so a cross-lane connector never cuts through a box. A
   * curve would; a right angle in the empty gap does not. Same-lane connectors
   * stay a straight horizontal line. */
  function orthPath(p1, p2) {
    if (Math.abs(p2.x - p1.x) < 2 || Math.abs(p2.y - p1.y) < 2) {
      return 'M' + p1.x + ',' + p1.y + ' L' + p2.x + ',' + p2.y;
    }
    var midY = (p1.y + p2.y) / 2;
    var r = Math.min(14, Math.abs(p2.y - p1.y) / 2 - 1, Math.abs(p2.x - p1.x) / 2 - 1);
    if (!(r > 1)) return 'M' + p1.x + ',' + p1.y + ' L' + p1.x + ',' + midY + ' L' + p2.x + ',' + midY + ' L' + p2.x + ',' + p2.y;
    var vdir = p2.y > p1.y ? 1 : -1;
    var xdir = p2.x > p1.x ? 1 : -1;
    return 'M' + p1.x + ',' + p1.y +
      ' L' + p1.x + ',' + (midY - vdir * r) +
      ' Q' + p1.x + ',' + midY + ' ' + (p1.x + xdir * r) + ',' + midY +
      ' L' + (p2.x - xdir * r) + ',' + midY +
      ' Q' + p2.x + ',' + midY + ' ' + p2.x + ',' + (midY + vdir * r) +
      ' L' + p2.x + ',' + p2.y;
  }

  /* Measure, then draw. An anchor with no box is a diagnostic, not a guess. */
  function drawConnectors(slide) {
    var svg = slide.querySelector('.connectors');
    if (!svg) {
      // A hand-edited deck with no connector layer still has to report ITS own
      // geometry, or the checker measures the slide shown before this one.
      window.__slideUnmeasurable = [];
      window.__slideGeometry = { frame: { width: 0, height: 0 }, nodes: [], connectors: [], unmeasurable: [] };
      return;
    }
    var spec = [];
    try { spec = JSON.parse(svg.getAttribute('data-connectors') || '[]'); } catch (e) { spec = []; }
    var host = slide.querySelector('.slide-body') || slide;
    var isLayers = !!slide.querySelector('.block-layers');
    // The layer is `inset: 0` inside .slide-body, so its coordinate space IS
    // the body box. Offsetting it again against the slide double-counts and
    // parks every path at the bottom of the frame.
    var origin = host.getBoundingClientRect();

    // Every addressable box, in the same space, so the checker can ask whether
    // a route runs through one it does not connect.
    var nodes = [];
    Array.prototype.forEach.call(slide.querySelectorAll('[data-node]'), function (el) {
      if (el.closest('[data-decor]')) return;
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      nodes.push({
        id: el.getAttribute('data-node'),
        rect: { x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height },
      });
    });

    if (!spec.length) {
      svg.innerHTML = '';
      svg.style.display = 'none';
      window.__slideUnmeasurable = [];
      window.__slideGeometry = {
        frame: { width: origin.width, height: origin.height },
        nodes: nodes, connectors: [], unmeasurable: [],
      };
      return;
    }
    svg.style.display = '';
    svg.setAttribute('viewBox', '0 0 ' + origin.width + ' ' + origin.height);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.innerHTML = '<defs>'
      + '<marker id="arw" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="9" markerHeight="9" orient="auto-start-reverse">'
      + '<path d="M0,0 L12,6 L0,12 z" fill="currentColor"/></marker>'
      + '<marker id="arw-both" viewBox="0 0 12 12" refX="2" refY="6" markerWidth="9" markerHeight="9" orient="auto-start-reverse">'
      + '<path d="M12,0 L0,6 L12,12 z" fill="currentColor"/></marker>'
      + '</defs>';
    var unmeasurable = [];

    // Pass 1: resolve every endpoint and the side it leaves from.
    var planned = [];
    var endpoints = [];
    spec.forEach(function (c) {
      var a = slide.querySelector('[data-node="' + CSS.escape(c.from) + '"]');
      var b = slide.querySelector('[data-node="' + CSS.escape(c.to) + '"]');
      if (!a || !b) { unmeasurable.push(c.from + '->' + c.to); return; }
      var ra = a.getBoundingClientRect();
      var rb = b.getBoundingClientRect();
      if (!ra.width || !rb.width) { unmeasurable.push(c.from + '->' + c.to); return; }

      var sides = connectorSides(ra, rb);
      var plan = { c: c, ra: ra, rb: rb, sides: sides, fromOffset: 0, toOffset: 0 };
      planned.push(plan);
      endpoints.push({
        plan: plan, end: 'from', nodeId: c.from, side: sides.from, rect: ra, offset: 0,
        cross: isVerticalSide(sides.from) ? rb.top + rb.height / 2 : rb.left + rb.width / 2,
      });
      endpoints.push({
        plan: plan, end: 'to', nodeId: c.to, side: sides.to, rect: rb, offset: 0,
        cross: isVerticalSide(sides.to) ? ra.top + ra.height / 2 : ra.left + ra.width / 2,
      });
    });

    // Pass 2: fan out ports that would otherwise coincide.
    spreadPorts(endpoints);
    endpoints.forEach(function (e) {
      if (e.end === 'from') e.plan.fromOffset = e.offset;
      else e.plan.toOffset = e.offset;
    });

    // Pass 3: draw, then measure what was drawn.
    var drawn = [];
    planned.forEach(function (plan) {
      var c = plan.c;
      var p1 = portPoint(plan.ra, plan.sides.from, plan.fromOffset, origin);
      var p2 = portPoint(plan.rb, plan.sides.to, plan.toOffset, origin);
      var d;
      if (isLayers) {
        d = orthPath(p1, p2);
      } else if (plan.sides.horizontal) {
        var mx = (p1.x + p2.x) / 2;
        d = 'M' + p1.x + ',' + p1.y + ' C' + mx + ',' + p1.y + ' ' + mx + ',' + p2.y + ' ' + p2.x + ',' + p2.y;
      } else {
        var my = (p1.y + p2.y) / 2;
        d = 'M' + p1.x + ',' + p1.y + ' C' + p1.x + ',' + my + ' ' + p2.x + ',' + my + ' ' + p2.x + ',' + p2.y;
      }

      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('data-style', c.style || 'solid');
      path.setAttribute('data-conn', c.from + '->' + c.to);
      path.setAttribute('marker-end', 'url(#arw)');
      if (c.kind === 'both') path.setAttribute('marker-start', 'url(#arw-both)');
      svg.appendChild(path);

      drawn.push({ c: c, path: path, d: d, points: samplePath(path) });

      if (c.travel) {
        var dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('class', 'travel');
        dot.setAttribute('data-travel', c.from + '->' + c.to);
        dot.setAttribute('r', '9');
        var mp = document.createElementNS('http://www.w3.org/2000/svg', 'animateMotion');
        mp.setAttribute('dur', '1.1s');
        mp.setAttribute('fill', 'freeze');
        mp.setAttribute('begin', 'indefinite');
        mp.setAttribute('path', d);
        dot.appendChild(mp);
        svg.appendChild(dot);
      }
    });

    // Pass 4: labels last, so each one can avoid the boxes, the routes and the
    // labels already placed.
    var obstacles = nodes.map(function (n) { return n.rect; });
    var connectors = [];
    drawn.forEach(function (entry) {
      var labelRect = null;
      if (entry.c.label) {
        var placed = placeLabel(svg, entry.path, entry.c.label, obstacles, drawn);
        if (placed && placed.box) {
          labelRect = placed.box;
          obstacles.push(placed.box);
        } else {
          // A label with no measurable box is a label nothing can check. Say so
          // rather than letting it pass as "no collision found".
          unmeasurable.push('label:' + entry.c.from + '->' + entry.c.to);
        }
      }
      connectors.push({
        from: entry.c.from, to: entry.c.to,
        label: entry.c.label || null,
        points: entry.points,
        labelRect: labelRect,
      });
    });

    window.__slideUnmeasurable = unmeasurable;
    window.__slideGeometry = {
      frame: { width: origin.width, height: origin.height },
      nodes: nodes,
      connectors: connectors,
      unmeasurable: unmeasurable,
    };
  }

  function initialState(slide) {
    // L7: show the whole picture and spotlight what is narrated. A viewer who
    // can always see the whole system never gets lost, so nothing starts hidden
    // unless the slide explicitly asked for it.
    Array.prototype.forEach.call(slide.querySelectorAll('[data-node]'), function (n) {
      n.removeAttribute('data-dim');
      n.removeAttribute('data-focus');
      n.removeAttribute('data-highlight');
      n.removeAttribute('data-spawn');
      if (n.hasAttribute('data-starts-hidden')) n.setAttribute('data-hidden', '');
      else n.removeAttribute('data-hidden');
    });
  }

  function show(id) {
    var next = byId(id);
    if (!next) return false;
    var apply = function () {
      slides().forEach(function (s) { s.removeAttribute('data-active'); });
      next.setAttribute('data-active', '');
      current = next;
      layoutHub(next);
      initialState(next);
      drawConnectors(next);
    };
    // Shared-element morphing where the browser supports it: a box that exists
    // on both slides physically moves to its new position instead of the screen
    // hard-cutting. That single effect is most of the difference between ten
    // diagrams and one authored explanation.
    if (document.startViewTransition) document.startViewTransition(apply);
    else apply();
    return true;
  }

  function currentBeats() {
    if (!current) return 0;
    return Number(current.getAttribute('data-beats') || '0');
  }

  function target(name) {
    if (!current) return null;
    return current.querySelector('[data-node="' + CSS.escape(name) + '"]');
  }

  function beat(n, spec) {
    if (!current) return false;
    var b = spec || null;
    if (!b) return false;
    var el = target(b.target);
    if (!el) {
      // A connector, rather than a node.
      var conn = current.querySelector('[data-travel="' + CSS.escape(b.target) + '"]');
      if (conn && b.do === 'travel') {
        conn.setAttribute('data-travelling', '');
        var motion = conn.querySelector('animateMotion');
        if (motion && motion.beginElement) { try { motion.beginElement(); } catch (e) { /* older engine */ } }
        return true;
      }
      return false;
    }
    switch (b.do) {
      case 'focus':
        Array.prototype.forEach.call(current.querySelectorAll('[data-node]'), function (n2) {
          if (n2 !== el) n2.setAttribute('data-dim', '');
        });
        el.removeAttribute('data-dim');
        el.setAttribute('data-focus', '');
        break;
      case 'dim': el.setAttribute('data-dim', ''); break;
      case 'highlight': el.setAttribute('data-highlight', ''); break;
      case 'spawn':
      case 'reveal':
        el.removeAttribute('data-hidden');
        el.setAttribute('data-spawn', '');
        break;
      default: return false;
    }
    void n;
    return true;
  }

  function reset() {
    if (current) initialState(current);
  }

  function route() {
    var id = (location.hash || '').replace(/^#\/?/, '');
    var all = slides();
    if (!all.length) return;
    show(id || all[0].getAttribute('data-slide'));
  }

  window.__slide = {
    get beats() { return currentBeats(); },
    get id() { return current ? current.getAttribute('data-slide') : null; },
    beat: beat,
    reset: reset,
    show: show,
    /* Used by `slides check`: measured facts about what is actually rendered. */
    measure: function () { return window.__slideMeasure ? window.__slideMeasure() : null; }
  };

  window.addEventListener('hashchange', route);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', route);
  else route();
  window.addEventListener('resize', function () { if (current) { layoutHub(current); drawConnectors(current); } });
})();
