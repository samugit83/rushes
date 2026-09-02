// The opening and closing full-screen cards, rendered to PNG through headless
// Chrome and turned into short clips: the still held for its narration length
// plus a pad, with its narration audio and gentle fades. These bookend the
// screencast in the final mux.
//
// The typeface is embedded as base64 at render time, so a card never depends on
// the network or on a font happening to be installed on the host.

import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { VIDEO, TIMING } from '../config.ts';
import { demoPaths } from '../paths.ts';
import { screenshotHtml } from '../chrome.ts';
import type { OpeningCard, ClosingCard } from '../types.ts';
import type { ProjectConfig } from '../projectConfig.ts';
import { resolveBrand, embeddedFontCss, wordmarkHtml, escapeHtml, FONT_STACK, type ResolvedBrand } from './brand.ts';

function shell(brand: ResolvedBrand, inner: string, width: number, height: number): string {
  const logo = brand.logoDataUri
    ? `<img src="${brand.logoDataUri}" style="height:96px;width:auto;"/>`
    : '';
  const mark = wordmarkHtml(brand);
  const head = mark || logo
    ? `<div class="brand">${logo}
        <div style="display:flex;flex-direction:column;line-height:1;">
          ${mark}${brand.kicker ? `<span class="k">${escapeHtml(brand.kicker)}</span>` : ''}
        </div>
      </div>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    ${embeddedFontCss()}
    *{margin:0;padding:0;box-sizing:border-box;}
    html,body{width:${width}px;height:${height}px;overflow:hidden;}
    body{background:radial-gradient(1400px 900px at 72% -12%, ${brand.surface}, ${brand.background}), ${brand.background};
      font-family:${FONT_STACK};color:${brand.foreground};position:relative;}
    .glow{position:absolute;right:-160px;top:-160px;width:720px;height:720px;
      background:radial-gradient(circle, ${brand.accent}28, transparent 62%);}
    .frame{position:absolute;inset:0;padding:110px 130px;display:flex;flex-direction:column;}
    .brand{display:flex;align-items:center;gap:26px;}
    .brand .n{font:800 52px ${FONT_STACK};letter-spacing:.5px;}
    .brand .k{font:700 26px ${FONT_STACK};letter-spacing:8px;color:${brand.accent};margin-top:8px;}
  </style></head><body><div class="glow"></div><div class="frame">
    ${head}
    ${inner}
  </div></body></html>`;
}

export function openingHtml(c: OpeningCard, config: ProjectConfig): string {
  const b = resolveBrand(config);
  const w = config.video?.width ?? VIDEO.width;
  const h = config.video?.height ?? VIDEO.height;
  const disclaimer = c.disclaimer || b.disclaimer;
  return shell(b, `
    <div style="margin-top:auto;">
      <div style="font:600 34px ${FONT_STACK};color:${b.muted};letter-spacing:5px;">${escapeHtml(c.kicker)}</div>
      <div style="font:800 118px/1.02 ${FONT_STACK};margin-top:20px;max-width:1500px;">${escapeHtml(c.title)}</div>
      <div style="font:500 46px ${FONT_STACK};color:${b.accent};margin-top:26px;">${escapeHtml(c.subtitle)}</div>
    </div>
    ${disclaimer ? `<div style="margin-top:auto;font:500 27px/1.5 ${FONT_STACK};color:${b.muted};max-width:1500px;
      border-left:4px solid ${b.accent}88;padding-left:26px;">${escapeHtml(disclaimer)}</div>` : ''}`, w, h);
}

export function closingHtml(c: ClosingCard, config: ProjectConfig): string {
  const b = resolveBrand(config);
  const w = config.video?.width ?? VIDEO.width;
  const h = config.video?.height ?? VIDEO.height;
  return shell(b, `
    <div style="margin:auto 0;">
      <div style="font:800 104px/1.03 ${FONT_STACK};max-width:1500px;">${escapeHtml(c.title)}</div>
      <div style="font:500 48px ${FONT_STACK};color:${b.accent};margin-top:30px;">${escapeHtml(c.subtitle)}</div>
    </div>
    ${b.footerLine ? `<div style="margin-top:auto;font:600 30px ${FONT_STACK};color:${b.muted};">${escapeHtml(b.footerLine)}</div>` : ''}`, w, h);
}

/** still PNG + narration mp3 -> a fixed-length clip with fades. */
export function renderCardClip(opts: {
  html: string; id: string; name: 'intro' | 'outro'; audioPath: string; durationMs: number; config: ProjectConfig;
}): string {
  const P = demoPaths(opts.id);
  const htmlPath = `${P.dir}/${opts.name}.html`;
  const pngPath = `${P.dir}/${opts.name}.png`;
  const mp4Path = opts.name === 'intro' ? P.introMp4 : P.outroMp4;
  const width = opts.config.video?.width ?? VIDEO.width;
  const height = opts.config.video?.height ?? VIDEO.height;
  const fps = opts.config.video?.fps ?? VIDEO.fps;

  writeFileSync(htmlPath, opts.html);
  screenshotHtml(htmlPath, pngPath, width, height);

  const dur = (opts.durationMs + TIMING.cardPadMs) / 1000;
  const fadeOut = Math.max(0, dur - 0.5).toFixed(2);
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-loop', '1', '-framerate', String(fps), '-t', dur.toFixed(2), '-i', pngPath,
    '-i', opts.audioPath,
    '-filter_complex',
    `[0:v]fade=t=in:st=0:d=0.4,fade=t=out:st=${fadeOut}:d=0.5,format=yuv420p[v];` +
    `[1:a]apad,atrim=0:${dur.toFixed(2)},afade=t=out:st=${fadeOut}:d=0.5[a]`,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'medium', '-r', String(fps),
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2',
    '-shortest', mp4Path,
  ], { stdio: 'ignore' });
  return mp4Path;
}
