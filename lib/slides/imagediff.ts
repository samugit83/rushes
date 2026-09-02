// Perceptual comparison of two PNGs.
//
// The golden check used to be `Buffer.equals`, which sounds strict and is
// actually useless: a font-hinting difference between two machines, or a single
// re-encoded pixel, flips it. A check that cries wolf on every run is a check
// people learn to ignore, which is worse than not having it.
//
// This compares what a viewer would see. Two pixels count as different only when
// a channel moves by more than `tolerance`, and a slide fails only when the
// fraction of differing pixels crosses a threshold. Anti-aliasing noise stays
// silent; a moved box does not.
//
// It runs in the browser we already ship rather than pulling a PNG decoder into
// the dependency list. The skill has three dependencies and that is a feature.

import { readFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';

export interface ImageDiff {
  /** Fraction of pixels that differ beyond the tolerance, 0..1. */
  ratio: number;
  width: number;
  height: number;
  /** Set when the two images are not the same size; ratio is then 1. */
  sizeMismatch: boolean;
  error?: string;
}

const COMPARE = ({ a, b, tolerance }: { a: string; b: string; tolerance: number }) => new Promise<{
  ratio: number; width: number; height: number; sizeMismatch: boolean;
}>((resolve, reject) => {
  const load = (src: string) => new Promise<HTMLImageElement>((ok, fail) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => fail(new Error('image failed to decode'));
    img.src = src;
  });
  Promise.all([load(a), load(b)]).then(([left, right]) => {
    if (left.naturalWidth !== right.naturalWidth || left.naturalHeight !== right.naturalHeight) {
      resolve({ ratio: 1, width: left.naturalWidth, height: left.naturalHeight, sizeMismatch: true });
      return;
    }
    const w = left.naturalWidth;
    const h = left.naturalHeight;
    const draw = (img: HTMLImageElement) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, w, h).data;
    };
    const pa = draw(left);
    const pb = draw(right);
    let differing = 0;
    for (let i = 0; i < pa.length; i += 4) {
      if (Math.abs(pa[i] - pb[i]) > tolerance
        || Math.abs(pa[i + 1] - pb[i + 1]) > tolerance
        || Math.abs(pa[i + 2] - pb[i + 2]) > tolerance
        || Math.abs(pa[i + 3] - pb[i + 3]) > tolerance) differing++;
    }
    resolve({ ratio: differing / (w * h), width: w, height: h, sizeMismatch: false });
  }).catch(reject);
});

function dataUri(path: string): string {
  return `data:image/png;base64,${readFileSync(path).toString('base64')}`;
}

/**
 * Compare many pairs in one browser. Returns a map keyed by the caller's id;
 * a pair whose files are missing or undecodable comes back with an `error` and
 * is never silently treated as a match.
 */
export async function compareImages(
  pairs: { id: string; a: string; b: string }[],
  tolerance = 8,
): Promise<Map<string, ImageDiff>> {
  const out = new Map<string, ImageDiff>();
  if (!pairs.length) return out;

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    for (const pair of pairs) {
      if (!existsSync(pair.a) || !existsSync(pair.b)) {
        out.set(pair.id, { ratio: 1, width: 0, height: 0, sizeMismatch: false, error: 'a file is missing' });
        continue;
      }
      try {
        const result = await page.evaluate(COMPARE, { a: dataUri(pair.a), b: dataUri(pair.b), tolerance });
        out.set(pair.id, result);
      } catch (e) {
        out.set(pair.id, { ratio: 1, width: 0, height: 0, sizeMismatch: false, error: (e as Error).message });
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return out;
}
