// A scene must be showing its own picture when its narration starts.
//
// The defect: a scene's opening navigation ran AFTER its start was stamped, so
// the deck load sat inside the scene's own window and the video played the
// incoming narration over the page we had just left — two seconds of the live
// app under a voice describing a diagram. Every other check passed: the slide
// rendered, the narration was right, the timeline was monotonic. Only the
// picture was wrong, and nothing looked at the picture.
//
// Two guards, and they are different in kind. The driver hoists the opening
// navigation off the scene clock (an ordering invariant, asserted here against
// the source, because the alternative is a full browser recording). The checker
// then measures the DELIVERED frame against the slide's own render, which is
// the only evidence that survives a refactor of the driver.

import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, assert } from './harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

await test('the driver runs a scene opening navigation BEFORE it stamps the clock', async () => {
  const src = readFileSync(join(ROOT, 'lib/engine/driver.ts'), 'utf8');

  // Inside the scene loop: the hoist, then the stamp. Order is the whole fix.
  const hoist = src.indexOf('await execStep(scene.id, opener, 0)');
  const stamp = src.indexOf('const startMs = Date.now() - t0;');
  assert(hoist > 0, 'the scene loop hoists its opening navigation');
  assert(stamp > 0, 'the scene loop stamps a start');
  assert(hoist < stamp, 'the opening navigation runs BEFORE the scene clock starts');

  // And the remaining steps must skip the hoisted one rather than repeat it.
  assert(/for \(let i = firstStep; i < scene\.steps\.length; i\+\+\)/.test(src),
    'the step loop resumes after the hoisted opener');

  // Scene 0 is hoisted off the MASTER clock too, or the top of the video shows
  // the boot page for as long as the first navigation takes.
  const opener0 = src.indexOf('await execStep(story.scenes[0].id, opener0, 0)');
  const t0 = src.indexOf('const t0 = Date.now();');
  assert(opener0 > 0 && t0 > 0 && opener0 < t0, "scene 0's navigation runs before t0");

  // The hoist must cover `slide`, not just `goto`. Covering only `goto` is
  // exactly the hole the shipped bug fell through.
  assert(/s\.do === 'goto' \|\| s\.do === 'slide'/.test(src),
    'both navigation kinds are hoisted');
});

await test('the frame signature separates the same picture from a different one', async () => {
  const { frameSignature, meanAbsDiff } = await import('../lib/check/index.ts');
  const dir = mkdtempSync(join(tmpdir(), 'rushes-frame-'));
  const png = (name, color) => {
    const p = join(dir, name);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi',
      '-i', `color=c=${color}:s=320x180`, '-frames:v', '1', p], { stdio: 'ignore' });
    return p;
  };
  const a = frameSignature(png('a.png', '0x101010'));
  const b = frameSignature(png('b.png', '0x101010'));
  const c = frameSignature(png('c.png', '0xc0c0c0'));
  assert(a && b && c, 'signatures were produced');
  assert(a.length === 32 * 18, 'the signature is the coarse 32x18 grid');
  assert(meanAbsDiff(a, b) < 1, 'the same picture measures ~0');
  assert(meanAbsDiff(a, c) > 50, 'a different picture measures far above the threshold');

  // The threshold has to sit between the two, with room on both sides: measured
  // against real footage, an honest frame lands at 1-3 and the wrong page ~20.
  const { THRESHOLDS } = await import('../lib/config.ts');
  assert(THRESHOLDS.sceneOpenFrameDiff > 3 && THRESHOLDS.sceneOpenFrameDiff < 20,
    'the threshold separates a live animation from the wrong page');
});

await test('the opening-frame check is registered and cannot degrade to a warning', async () => {
  const { CHECKS, DEGRADABLE, levelFor } = await import('../lib/check/registry.ts');
  const spec = CHECKS.find((c) => c.name === 'scene_opens_on_its_slide');
  assert(spec, 'the check is in the registry');
  assert(levelFor(spec, 'standard') === 'error' && levelFor(spec, 'showcase') === 'error',
    'a scene opening on the wrong picture is an error at every profile');
  assert(!DEGRADABLE.has('scene_opens_on_its_slide'), 'it is not degradable');
});
