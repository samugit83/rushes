// Animated previews.
//
// A slide preview is a still, which cannot show the one thing a slide now does
// that matters most: move. The flowing edges, the beat pulses and the entrance
// are invisible in a PNG, so a reviewer approves a design without seeing its
// motion — the same blind spot that let a frozen video ship. This captures the
// living slide as a short gif so the motion is on the table at preview time.
//
// It never sets `data-still`, so the deck animates exactly as the recorder will
// film it. It is a preview aid only: no check reads it, and a missing ffmpeg
// degrades to "no gif", never to a false pass.

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hasFfmpeg } from '../compose/ffprobe.ts';
import { VIDEO } from '../config.ts';
import type { SlideSource } from './types.ts';

export interface GifResult { id: string; gif: string | null; note?: string }

/**
 * A slide is worth a gif when it actually animates: a composed slide with
 * connectors (whose edges flow), or any slide the storyboard fires beats on.
 * A static authored title card gets no gif — a gif of a still is just a heavier
 * still.
 */
export function animates(slide: SlideSource, declaredBeats: number): boolean {
  if (declaredBeats > 0) return true;
  return (slide.mode ?? 'composed') === 'composed' && (slide.connectors?.length ?? 0) > 0;
}

export interface CaptureOptions {
  deckPath: string;
  slides: SlideSource[];
  outDir: string;
  /** Beats declared per slide id, from the storyboard, so we pulse the real ones. */
  beatsBySlide?: Record<string, number>;
  seconds?: number;
  fps?: number;
  /** Gif width; height follows the frame aspect. Smaller keeps the file light. */
  width?: number;
}

export async function captureGifs(opts: CaptureOptions): Promise<GifResult[]> {
  const targets = opts.slides.filter((s) => animates(s, opts.beatsBySlide?.[s.id] ?? 0));
  if (!targets.length) return [];
  if (!hasFfmpeg()) {
    return targets.map((s) => ({ id: s.id, gif: null, note: 'ffmpeg unavailable; no motion preview' }));
  }

  const seconds = opts.seconds ?? 4;
  const fps = opts.fps ?? 12;
  const gifW = opts.width ?? 960;
  const total = Math.max(1, Math.round(seconds * fps));
  const deckUrl = pathToFileURL(opts.deckPath).toString();

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const out: GifResult[] = [];
  try {
    const context = await browser.newContext({
      viewport: { width: VIDEO.width, height: VIDEO.height }, deviceScaleFactor: 1, colorScheme: 'dark',
    });
    const page = await context.newPage();

    for (const slide of targets) {
      const frames = mkdtempSync(join(tmpdir(), 'rushes-gif-'));
      try {
        await page.goto(`${deckUrl}#/${slide.id}`, { waitUntil: 'load' });
        await page.evaluate((id) => (window as unknown as { __slide?: { show?: (i: string) => void } }).__slide?.show?.(id), slide.id);
        await page.waitForTimeout(500);

        // Pulse each node in turn across the window, so a reviewer sees the beat
        // effect, while the edges flow continuously underneath. Uses the slide's
        // own node ids, so it works with no storyboard.
        const ids = await page.evaluate(() =>
          [...document.querySelectorAll('.slide[data-active] [data-node]')]
            .map((e) => e.getAttribute('data-node')).filter(Boolean) as string[]);
        const stride = ids.length ? Math.max(1, Math.floor(total / ids.length)) : total + 1;

        for (let i = 0; i < total; i++) {
          if (ids.length && i % stride === 0) {
            const id = ids[Math.min(ids.length - 1, Math.floor(i / stride))];
            await page.evaluate((t) => (window as unknown as { __slide?: { beat: (n: number, b: unknown) => void } })
              .__slide?.beat(0, { on: 'x', do: 'highlight', target: t }), id);
          }
          await page.screenshot({ path: join(frames, `f${String(i).padStart(3, '0')}.png`) });
          await page.waitForTimeout(1000 / fps);
        }

        const gif = join(opts.outDir, `${slide.id}.gif`);
        // palettegen/paletteuse keeps the gradient glow from banding.
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps),
          '-i', join(frames, 'f%03d.png'),
          '-vf', `fps=${fps},scale=${gifW}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`,
          gif], { stdio: 'ignore' });
        out.push({ id: slide.id, gif });
      } catch (e) {
        out.push({ id: slide.id, gif: null, note: (e as Error).message });
      } finally {
        rmSync(frames, { recursive: true, force: true });
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return out;
}
