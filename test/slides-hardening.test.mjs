// Hardening for the slide composition feature.
//
// Every test here is named after a defect found reviewing the first cut, or
// covers a boundary the happy path never reaches. The regression tests failed
// before their fix and are the reason the fix is trusted.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, assert, equal } from './harness.mjs';

const CONFIG = {
  schemaVersion: 1,
  baseUrl: 'http://127.0.0.1:8787',
  allowHosts: ['127.0.0.1'],
  auth: { kind: 'none' },
};

function project(slides) {
  const root = mkdtempSync(join(tmpdir(), 'rushes-hard-'));
  mkdirSync(join(root, 'slides', 'src'), { recursive: true });
  writeFileSync(join(root, 'rushes.config.json'), JSON.stringify(CONFIG));
  for (const s of slides) {
    writeFileSync(join(root, 'slides', 'src', `${s.id}.slide.json`), JSON.stringify(s));
  }
  return root;
}

async function withProject(slides, fn) {
  const root = project(slides);
  const previous = process.env.RUSHES_PROJECT_ROOT;
  process.env.RUSHES_PROJECT_ROOT = root;
  try {
    return await fn(root);
  } finally {
    if (previous === undefined) delete process.env.RUSHES_PROJECT_ROOT;
    else process.env.RUSHES_PROJECT_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

const bullets = (id, items) => ({
  schemaVersion: 1, id, mode: 'composed', block: 'bullets',
  title: 'Probe', items,
});

// --- regression: the projected floor was measured against the wrong frame ---

await test('regression: projected readability measures the video frame, not the slide body', async () => {
  const { checkSlides } = await import('../lib/slides/check.ts');
  const { VIDEO, THRESHOLDS } = await import('../lib/config.ts');

  // A slide body is inset inside the frame, so it measures ~1728 of the 1920.
  // Projecting against the body flatters the result by about eleven percent and
  // contradicts the 30px authored floor the contract documents.
  const measurement = {
    id: 'probe', mode: 'composed', fonts: ['Poppins'],
    tooSmall: [], overflow: [], outside: [], contrast: [], words: 4,
    unmeasurable: [], minTextPx: 26,
    geometry: { frame: { width: 1728, height: 900 }, nodes: [], connectors: [], unmeasurable: [] },
  };
  const [d] = checkSlides({ rendered: [{ id: 'probe', png: null, measurement }] })
    .filter((x) => x.code === 'slide/text-projected-too-small');
  assert(d, '26px should not clear the projected floor');

  const expected = Math.ceil(THRESHOLDS.slideProjectedMinPx * VIDEO.width / THRESHOLDS.slideViewingWidthPx);
  equal(d.evidence.requiredSourcePx, expected,
    `the floor must be derived from the ${VIDEO.width}px video frame, not the slide body`);
  equal(expected, 30, 'and that is the 30px the slide contract documents');
});

// --- regression: a reused deck path was never re-read ---------------------

await test('regression: a re-rendered candidate is not measured against the previous deck', async () => {
  const { loadConfig } = await import('../lib/projectConfig.ts');
  const { compileDeck } = await import('../lib/slides/compile.ts');
  const { openRenderer } = await import('../lib/slides/render.ts');

  await withProject([bullets('probe', [{ id: 'a', label: 'One' }])], async (root) => {
    const { config } = loadConfig(root);
    const scratch = mkdtempSync(join(tmpdir(), 'rushes-cand-'));
    const renderer = await openRenderer();
    const counts = [];
    try {
      // Three genuinely different decks, rendered through one held-open page.
      // The verified-repair loop does exactly this, so if the page serves a
      // stale document every "verified" fix after the first is a lie.
      for (const label of ['One', 'Two Three Four Five Six', 'One']) {
        const slide = bullets('probe', [{ id: 'a', label }]);
        const { deckPath } = compileDeck({ config, sources: [slide], outPath: join(scratch, 'candidate.html'), root });
        const [out] = await renderer.render({ slides: [slide], deckPath, measureOnly: true });
        counts.push(out.measurement.words);
      }
    } finally {
      await renderer.close();
      rmSync(scratch, { recursive: true, force: true });
    }
    assert(counts[1] > counts[0],
      `the longer deck measured ${counts[1]} words against ${counts[0]}; the page served a stale document`);
    equal(counts[2], counts[0], 'and going back measures the short deck again');
  });
});

// --- regression: the described reorder was not the verified one -----------

await test('regression: the described reorder is the edit that gets verified', async () => {
  const { moveAdjacent } = await import('../lib/slides/repair.ts');

  // Forwards: move index 4 to sit after index 0.
  equal(moveAdjacent(['a', 'b', 'c', 'd', 'e'], 0, 4), ['a', 'e', 'b', 'c', 'd']);
  // Backwards is where the naive splice slipped: removing the earlier element
  // shifts every later index down by one, so the insert landed one place off.
  equal(moveAdjacent(['a', 'b', 'c', 'd', 'e'], 4, 0), ['b', 'c', 'd', 'a', 'e']);
  // In both cases the two named items must end up next to each other, which is
  // the whole claim the fix text makes.
  for (const [from, to] of [[0, 3], [3, 0], [1, 4], [4, 1]]) {
    const moved = moveAdjacent(['a', 'b', 'c', 'd', 'e'], from, to);
    const names = ['a', 'b', 'c', 'd', 'e'];
    const gap = Math.abs(moved.indexOf(names[from]) - moved.indexOf(names[to]));
    equal(gap, 1, `"${names[to]}" must end up beside "${names[from]}" (from ${from} to ${to})`);
  }
});

// --- regression: verification cost was bounded per code, not per slide ----

await test('regression: the verified-repair budget is global to a slide, not per diagnostic', async () => {
  const { CANDIDATE_BUDGET, candidateBudgetFor } = await import('../lib/slides/repair.ts');
  assert(Number.isInteger(CANDIDATE_BUDGET) && CANDIDATE_BUDGET > 0, 'a budget exists');
  // Five diagnostics on one slide must not authorise five budgets' worth of
  // renders: at roughly two seconds each that is how a check becomes a coffee
  // break.
  const codes = ['slide/block-over-capacity', 'slide/text-overflow', 'slide/outside-safe-area',
    'slide/font-too-small', 'slide/word-count'];
  const total = codes.reduce((n, c) => n + candidateBudgetFor(codes.length), 0);
  assert(total <= CANDIDATE_BUDGET,
    `five codes authorised ${total} renders against a budget of ${CANDIDATE_BUDGET}`);
});

// --- boundaries and malformed input --------------------------------------

await test('malformed geometry is analysed without throwing', async () => {
  const { analyseGeometry } = await import('../lib/slides/geometry.ts');
  const cases = [
    { frame: { width: 0, height: 0 }, nodes: [], connectors: [], unmeasurable: [] },
    // A route with one point, no points, and non-finite samples.
    {
      frame: { width: 1920, height: 1080 },
      nodes: [{ id: 'a', rect: { x: 0, y: 0, width: 0, height: 0 } }],
      connectors: [
        { from: 'a', to: 'b', label: null, points: [[0, 0]], labelRect: null },
        { from: 'a', to: 'b', label: null, points: [], labelRect: null },
        { from: 'c', to: 'd', label: 'x', points: [[NaN, 0], [1, 1]], labelRect: null },
      ],
      unmeasurable: [],
    },
  ];
  for (const scene of cases) {
    const issues = analyseGeometry(scene);
    assert(Array.isArray(issues), 'always an array');
  }
});

await test('a zero-size box is never reported as crossed', async () => {
  const { analyseGeometry } = await import('../lib/slides/geometry.ts');
  const points = [];
  for (let i = 0; i <= 24; i++) points.push([i * 10, 100]);
  const issues = analyseGeometry({
    frame: { width: 1920, height: 1080 },
    // A collapsed box has no visible area, so a route "through" it is invisible.
    nodes: [{ id: 'ghost', rect: { x: 100, y: 100, width: 0, height: 0 } }],
    connectors: [{ from: 'a', to: 'b', label: null, points, labelRect: null }],
    unmeasurable: [],
  });
  equal(issues.filter((i) => i.kind === 'edge-through-node').length, 0);
});

await test('a clean composed slide reports no composition defect at all', async () => {
  const { loadConfig } = await import('../lib/projectConfig.ts');
  const { compileDeck } = await import('../lib/slides/compile.ts');
  const { renderSlides } = await import('../lib/slides/render.ts');
  const { checkSlides } = await import('../lib/slides/check.ts');

  const slide = {
    schemaVersion: 1, id: 'clean', mode: 'composed', block: 'flow-row',
    title: 'Three stages',
    items: [{ id: 'a', label: 'Plan' }, { id: 'b', label: 'Build' }, { id: 'c', label: 'Check' }],
    connectors: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
  };
  await withProject([slide], async (root) => {
    const { config } = loadConfig(root);
    const compiled = compileDeck({ config, root });
    const rendered = await renderSlides({ slides: compiled.slides, measureOnly: true });
    const composition = checkSlides({ rendered })
      .filter((d) => ['slide/edge-through-node', 'slide/route-crossing', 'slide/route-corridor',
        'slide/label-clearance'].includes(d.code));
    equal(composition.map((d) => d.code), [], 'a well-formed flow reports nothing');
  });
});

// --- the perceptual golden compare ---------------------------------------

await test('the golden compare separates identical, different and unreadable', async () => {
  const { compareImages } = await import('../lib/slides/imagediff.ts');
  const { loadConfig } = await import('../lib/projectConfig.ts');
  const { compileDeck } = await import('../lib/slides/compile.ts');
  const { renderSlides } = await import('../lib/slides/render.ts');

  await withProject([bullets('one', [{ id: 'a', label: 'Alpha' }])], async (root) => {
    const { config } = loadConfig(root);
    const outDir = join(root, 'shots');
    const compiled = compileDeck({ config, root });
    const [shot] = await renderSlides({ slides: compiled.slides, outDir });

    // A different-looking slide, for the "genuinely changed" case.
    const other = bullets('one', [{ id: 'a', label: 'A completely different line of text here' }]);
    compileDeck({ config, sources: [other], outPath: join(root, 'other.html'), root });
    const [shot2] = await renderSlides({
      slides: [other], outDir: join(root, 'shots2'), deckPath: join(root, 'other.html'),
    });

    const diffs = await compareImages([
      { id: 'same', a: shot.png, b: shot.png },
      { id: 'changed', a: shot.png, b: shot2.png },
      { id: 'missing', a: shot.png, b: join(root, 'nope.png') },
    ]);

    equal(diffs.get('same').ratio, 0, 'an image is identical to itself');
    assert(diffs.get('changed').ratio > 0.002, `a real change exceeds the threshold, got ${diffs.get('changed').ratio}`);
    // A file that cannot be read is a failed comparison, never a silent pass.
    assert(diffs.get('missing').error, 'a missing file reports an error');
    equal(diffs.get('missing').ratio, 1, 'and never reads as a match');
  });
});

await test('a golden of a different size fails rather than comparing pixels', async () => {
  const { compareImages } = await import('../lib/slides/imagediff.ts');
  const { loadConfig } = await import('../lib/projectConfig.ts');
  const { compileDeck } = await import('../lib/slides/compile.ts');
  const { renderSlides } = await import('../lib/slides/render.ts');

  await withProject([bullets('one', [{ id: 'a', label: 'Alpha' }])], async (root) => {
    const { config } = loadConfig(root);
    const compiled = compileDeck({ config, root });
    const [big] = await renderSlides({ slides: compiled.slides, outDir: join(root, 'big') });
    const [small] = await renderSlides({
      slides: compiled.slides, outDir: join(root, 'small'), width: 960, height: 540,
    });
    const diffs = await compareImages([{ id: 'resized', a: big.png, b: small.png }]);
    equal(diffs.get('resized').sizeMismatch, true);
    equal(diffs.get('resized').ratio, 1);
  });
});

// --- the deck runtime's own reporting ------------------------------------

await test('a slide with no connectors publishes empty geometry, not the previous slide\'s', async () => {
  const { loadConfig } = await import('../lib/projectConfig.ts');
  const { compileDeck } = await import('../lib/slides/compile.ts');
  const { renderSlides } = await import('../lib/slides/render.ts');

  const withRoutes = {
    schemaVersion: 1, id: 'a-routed', mode: 'composed', block: 'flow-row', title: 'Routed',
    items: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }],
    connectors: [{ from: 'x', to: 'y' }],
  };
  const without = bullets('b-plain', [{ id: 'p', label: 'Plain' }]);

  await withProject([withRoutes, without], async (root) => {
    const { config } = loadConfig(root);
    const compiled = compileDeck({ config, root });
    // Rendered in one page, in this order, so a stale global would leak forward.
    const rendered = await renderSlides({ slides: compiled.slides, measureOnly: true });
    const plain = rendered.find((r) => r.id === 'b-plain');
    equal(plain.measurement.geometry.connectors, [], 'no routes leak in from the previous slide');
    equal(plain.measurement.unmeasurable, [], 'and neither do its unmeasurable anchors');
  });
});

// --- regression: label placement ignored the strokes it had to dodge -----

await test('regression: a label is placed off the routes, not only off the boxes', async () => {
  const { loadConfig } = await import('../lib/projectConfig.ts');
  const { compileDeck } = await import('../lib/slides/compile.ts');
  const { renderSlides } = await import('../lib/slides/render.ts');
  const { analyseGeometry } = await import('../lib/slides/geometry.ts');

  // Two parallel relationships in one row: the upper label used to be dropped
  // at the midpoint regardless of the stroke running under it.
  const slide = {
    schemaVersion: 1, id: 'labels', mode: 'composed', block: 'flow-row', title: 'Labels',
    items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }, { id: 'd', label: 'D' }],
    connectors: [
      { from: 'a', to: 'b', label: 'writes' },
      { from: 'c', to: 'd', label: 'reads' },
    ],
  };
  await withProject([slide], async (root) => {
    const { config } = loadConfig(root);
    const compiled = compileDeck({ config, root });
    const [rendered] = await renderSlides({ slides: compiled.slides, measureOnly: true });
    const issues = analyseGeometry(rendered.measurement.geometry);
    equal(issues.filter((i) => i.kind === 'label-route').map((i) => i.message), [],
      'no label may sit on a route it does not belong to');
  });
});

await test('regression: a label with no measurable box is reported, not silently skipped', async () => {
  const { loadConfig } = await import('../lib/projectConfig.ts');
  const { compileDeck } = await import('../lib/slides/compile.ts');
  const { renderSlides } = await import('../lib/slides/render.ts');

  // Whitespace renders to a zero-width box. It used to come back with a null
  // rect, which every collision check reads as "nothing to check".
  const slide = {
    schemaVersion: 1, id: 'blank', mode: 'composed', block: 'flow-row', title: 'Blank',
    items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    connectors: [{ from: 'a', to: 'b', label: '   ' }],
  };
  await withProject([slide], async (root) => {
    const { config } = loadConfig(root);
    const compiled = compileDeck({ config, root });
    const [rendered] = await renderSlides({ slides: compiled.slides, measureOnly: true });
    equal(rendered.measurement.unmeasurable, ['label:a->b'],
      'an unmeasurable label is named, so it cannot pass as "no collision found"');
  });
});

await test('a connector joining an item to itself is refused at the source', async () => {
  const { loadConfig } = await import('../lib/projectConfig.ts');
  const { compileDeck } = await import('../lib/slides/compile.ts');

  const slide = {
    schemaVersion: 1, id: 'loop', mode: 'composed', block: 'flow-row', title: 'Loop',
    items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    connectors: [{ from: 'a', to: 'a' }],
  };
  await withProject([slide], async (root) => {
    const { config } = loadConfig(root);
    const { diagnostics } = compileDeck({ config, root });
    const loop = diagnostics.filter((d) => d.code === 'slide/connector-self-loop');
    equal(loop.length, 1, 'a self-loop is an error, not a smear nothing can flag');
    equal(loop[0].severity, 'error');
  });
});

// --- regression: a "verified" fix traded one warning for another ---------

await test('regression: a verified fix may not trade one warning for another', async () => {
  const { loadConfig } = await import('../lib/projectConfig.ts');
  const { compileDeck } = await import('../lib/slides/compile.ts');
  const { renderSlides } = await import('../lib/slides/render.ts');
  const { checkSlides } = await import('../lib/slides/check.ts');
  const { verifyFixes } = await import('../lib/slides/repair.ts');

  // Full-width rows leave no room beside a vertical stroke, so the labels
  // collide. Switching to a block with no topology clears that collision and
  // silently earns slide/mode-mismatch instead. Checking only new ERRORS let
  // that through as "verified by re-render", which is exactly the kind of
  // confident wrong answer this feature exists to stop.
  const slide = {
    schemaVersion: 1, id: 'trade', mode: 'composed', block: 'stack', title: 'Layers',
    items: [{ id: 'ui', label: 'Webapp' }, { id: 'api', label: 'Agent' }, { id: 'db', label: 'Graph' }],
    connectors: [
      { from: 'ui', to: 'api', label: 'websocket' },
      { from: 'api', to: 'db', label: 'start scan' },
    ],
  };
  await withProject([slide], async (root) => {
    const { config } = loadConfig(root);
    const compiled = compileDeck({ config, root });
    const rendered = await renderSlides({ slides: compiled.slides, measureOnly: true });
    const diagnostics = [...compiled.diagnostics, ...checkSlides({ rendered })];
    const collisions = diagnostics.filter((d) => d.code === 'slide/label-clearance');
    assert(collisions.length > 0, 'the fixture must actually collide, or this proves nothing');

    await verifyFixes({ config, sources: compiled.slides, diagnostics });
    const verified = collisions[0].supportedFixes.filter((f) => f.includes('verified by re-render'));
    equal(verified.filter((f) => f.includes('badge-list')), [],
      'a block with no topology is not a verified repair for a labelled relationship');
  });
});

// --- regression: the arrowheads painted nothing --------------------------

await test('regression: a connector arrowhead is actually painted', async () => {
  const { loadConfig } = await import('../lib/projectConfig.ts');
  const { compileDeck } = await import('../lib/slides/compile.ts');
  const { chromium } = await import('playwright');
  const { pathToFileURL } = await import('node:url');

  const slide = {
    schemaVersion: 1, id: 'arrow', mode: 'composed', block: 'flow-row', title: 'Arrow',
    items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    connectors: [{ from: 'a', to: 'b' }],
  };
  await withProject([slide], async (root) => {
    const { config } = loadConfig(root);
    const { deckPath } = compileDeck({ config, root });
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto(`${pathToFileURL(deckPath)}#/arrow`, { waitUntil: 'load' });
      await page.waitForTimeout(700);
      const fill = await page.evaluate(() => {
        const mp = document.querySelector('.slide[data-active] .connectors marker path');
        return mp ? getComputedStyle(mp).fill : null;
      });
      assert(fill, 'the marker exists');
      // `.connectors path` used to match this one too, so it inherited fill:none
      // and every arrow in every diagram had no head. The DOM looked perfect.
      assert(fill !== 'none', 'the arrowhead must have a fill, or it paints nothing');
      const stroke = await page.evaluate(() => {
        const p = document.querySelector('.slide[data-active] .connectors > path');
        return getComputedStyle(p).fill;
      });
      equal(stroke, 'none', 'while the route itself stays unfilled');

      // The computed fill is NOT enough, and believing it was is how this bug
      // survived its own first fix: `display:none` on the <defs> made Chromium
      // drop the marker reference while the marker's style stayed perfect. Only
      // the pixels settle it. An arrowhead is the ink that sits off the stroke's
      // own line, so count that.
      const ink = await page.evaluate(() => {
        const route = document.querySelector('.slide[data-active] .connectors > path');
        const end = route.getPointAtLength(route.getTotalLength());
        const svg = route.ownerSVGElement.getBoundingClientRect();
        return { x: Math.round(svg.left + end.x), y: Math.round(svg.top + end.y) };
      });
      const shot = await page.screenshot({
        clip: { x: Math.max(0, ink.x - 40), y: Math.max(0, ink.y - 20), width: 44, height: 40 },
      });
      const offLine = await page.evaluate(async (b64) => {
        const img = new Image();
        await new Promise((r) => { img.onload = r; img.src = 'data:image/png;base64,' + b64; });
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const mid = Math.floor(c.height / 2);
        let n = 0;
        for (let y = 0; y < c.height; y++) {
          if (Math.abs(y - mid) <= 3) continue; // the 3px stroke itself
          for (let x = 0; x < c.width; x++) {
            const i = (y * c.width + x) * 4;
            if (d[i] > 120 && d[i + 1] > 80 && d[i + 2] < 90) n++; // the amber accent
          }
        }
        return n;
      }, shot.toString('base64'));
      assert(offLine > 20, `the arrowhead painted ${offLine} pixels off the stroke line; it is invisible`);
    } finally {
      await browser.close().catch(() => {});
    }
  });
});
