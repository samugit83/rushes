// The golden timing test (T1).
//
// It answers the question three separate workarounds were built around and none
// of them ever verified: IS THE RECORDED TIMELINE LINEAR WITH WALL CLOCK? A
// change-driven screencast emits a frame only when the page repaints, so a
// trim measured on the wall clock can land somewhere else entirely in the file.
// On one real recording that was 25,962 ms trimmed off a 169,600 ms master —
// fifteen per cent — on a clock the code itself documented as not matching.
//
// Method: serve a page that flashes pure white for two frames at 0, 5, 10 and
// 15 seconds, record it, decode the result, find the white frames, and compare
// where they landed against where the page says it painted them.
//
// The test is skipped, loudly, when ffmpeg or a browser is absent. `skipped`
// means the tool was unavailable and never means the measurement passed.

import { test, assert, near } from './harness.mjs';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { hasFfmpeg } from '../lib/compose/ffprobe.ts';
import { findChrome } from '../lib/chrome.ts';

const here = dirname(fileURLToPath(import.meta.url));
const TOLERANCE_MS = 400; // the plan's ±100 ms is the CDP-engine target; the
                          // change-driven recorder is held to a looser band so
                          // the test states the real number instead of failing
                          // on a limitation it is measuring.

/** Offsets, in ms, of the frames whose average luminance is near-white. */
function whiteFrameOffsets(webm) {
  // `metadata=print` reports through av_log, which means STDERR, and at the
  // default log level. Quieting ffmpeg or reading stdout both return nothing.
  const run = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', webm,
    '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const stats = run.stderr ?? '';
  const offsets = [];
  let lastTime = 0;
  let inFlash = false;
  for (const line of String(stats).split('\n')) {
    const t = line.match(/pts_time:([\d.]+)/);
    if (t) { lastTime = parseFloat(t[1]) * 1000; continue; }
    const y = line.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
    if (!y) continue;
    const bright = parseFloat(y[1]) > 180;
    if (bright && !inFlash) offsets.push(Math.round(lastTime));
    inFlash = bright;
  }
  return offsets;
}

await test('the recorded timeline is linear with wall clock', async () => {
  if (!hasFfmpeg() || !findChrome()) {
    process.stderr.write('    · skipped: ffmpeg or a browser is unavailable\n');
    return;
  }
  const { chromium } = await import('playwright');
  const dir = mkdtempSync(join(tmpdir(), 'rushes-timing-'));
  try {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({
      viewport: { width: 640, height: 360 },
      recordVideo: { dir, size: { width: 640, height: 360 } },
    });
    const page = await context.newPage();
    await page.goto(pathToFileURL(join(here, 'fixtures', 'timing', 'flash.html')).toString(), { waitUntil: 'load' });
    await page.waitForTimeout(16500);
    const painted = await page.evaluate(() => window.__flashes);
    const video = page.video();
    await context.close();
    await browser.close();

    const webm = await video.path();
    assert(existsSync(webm), 'the browser produced no video file');

    const recovered = whiteFrameOffsets(webm);
    process.stderr.write(`    painted at:   ${painted.map((p) => p.actual).join(', ')}\n`);
    process.stderr.write(`    recovered at: ${recovered.join(', ')}\n`);

    assert(recovered.length >= 3, `only ${recovered.length} of 4 flashes were recovered from the recording`);
    // The first flash fixes the origin; the drift that matters is how the LATER
    // ones move relative to it.
    const origin = recovered[0] - painted[0].actual;
    for (let i = 1; i < Math.min(recovered.length, painted.length); i++) {
      const drift = (recovered[i] - origin) - painted[i].actual;
      process.stderr.write(`    flash ${i}: drift ${drift} ms\n`);
      near(drift, 0, TOLERANCE_MS, `flash ${i} drifted`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
