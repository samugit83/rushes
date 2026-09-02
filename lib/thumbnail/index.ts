// One fixed 1280x720 thumbnail layout for every demo; only the data changes.
// Brand facts come from the project config (P8), so an unbranded project gets a
// clean neutral card rather than someone else's logo.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { demoPaths } from '../paths.ts';
import { screenshotHtml } from '../chrome.ts';
import { resolveBrand, embeddedFontCss, escapeHtml, FONT_STACK } from '../compose/brand.ts';
import type { Storyboard } from '../types.ts';
import type { ProjectConfig } from '../projectConfig.ts';

const W = 1280;
const H = 720;

export function thumbnailHtml(story: Storyboard, config: ProjectConfig): string {
  const b = resolveBrand(config);
  const logo = b.logoDataUri ? `<img src="${b.logoDataUri}" style="height:78px;width:auto;"/>` : '';
  const mark = b.wordmark.length
    ? `<div style="display:flex;flex-direction:column;line-height:1;">
        <span style="font:800 40px ${FONT_STACK};letter-spacing:.5px;">${b.wordmark.map((w) => `<span style="color:${w.color}">${escapeHtml(w.text)}</span>`).join('')}</span>
        <span style="font:700 22px ${FONT_STACK};letter-spacing:6px;color:${b.accent};margin-top:6px;">${escapeHtml(b.kicker)}</span>
      </div>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    ${embeddedFontCss()}
    *{margin:0;padding:0;box-sizing:border-box;}
    html,body{width:${W}px;height:${H}px;overflow:hidden;}
    body{background:radial-gradient(1100px 700px at 78% -12%, ${b.surface}, ${b.background}), ${b.background};
      font-family:${FONT_STACK};color:${b.foreground};position:relative;}
    .frame{position:absolute;inset:0;padding:64px 72px;display:flex;flex-direction:column;}
    .glow{position:absolute;right:-120px;top:-120px;width:560px;height:560px;
      background:radial-gradient(circle, ${b.accent}28, transparent 62%);}
  </style></head><body>
    <div class="glow"></div>
    <div class="frame">
      <div style="display:flex;align-items:center;gap:20px;">
        ${logo}${mark}
        <span style="margin-left:auto;font:700 26px ${FONT_STACK};color:${b.accent};
          border:1.5px solid ${b.accent}66;border-radius:12px;padding:10px 22px;background:${b.accent}1a;">
          Live walkthrough
        </span>
      </div>
      <div style="margin-top:auto;">
        <div style="font:600 30px ${FONT_STACK};color:${b.muted};letter-spacing:4px;">SEE IT IN ACTION</div>
        <div style="font:800 88px/1.02 ${FONT_STACK};margin-top:14px;max-width:1080px;">${escapeHtml(story.feature)}</div>
      </div>
      ${b.closingTagline || b.footerLine ? `<div style="margin-top:auto;display:flex;align-items:center;">
        <span style="font:700 30px ${FONT_STACK};color:${b.accent};">${escapeHtml(b.closingTagline)}</span>
        <span style="margin-left:auto;font:600 26px ${FONT_STACK};color:${b.muted};">${escapeHtml(Object.values(b.links)[0] ?? '')}</span>
      </div>` : ''}
    </div>
  </body></html>`;
}

export function renderThumbnail(story: Storyboard, config: ProjectConfig, dir?: string): string {
  const P = demoPaths(story.id);
  const html = dir ? join(dir, `${story.id}.thumb.html`) : P.thumbHtml;
  const png = dir ? join(dir, `${story.id}.thumb.png`) : P.thumbPng;
  writeFileSync(html, thumbnailHtml(story, config));
  screenshotHtml(html, png, W, H);
  return png;
}
