// A ready-to-paste LinkedIn post, written at build time with a placeholder link
// and rewritten with the real URL on publish.
//
// FORMAT
//   - A bold opening sentence. LinkedIn strips markdown but keeps Unicode
//     mathematical sans-serif glyphs, which paste as bold everywhere.
//   - "Watch the video: <link>" directly under the hook.
//   - Then the body that explains THIS feature.
//
// VOICE RULES, so it does not read as generated text
//   - "we", not "I".
//   - No rule-of-three lists ("no X, no Y, and no Z"), the biggest tell.
//   - Vary sentence length; be concrete about this demo.
//   - No em dashes, no emojis, no "in conclusion" closers.
//   - A hand-written youtube.linkedin per demo beats the template every time.

import type { Storyboard } from '../types.ts';
import type { ProjectConfig } from '../projectConfig.ts';

const LINK_PLACEHOLDER = '(video link added on publish)';

/** ASCII -> Unicode sans-serif bold, which LinkedIn renders as bold. */
function toBold(s: string): string {
  return Array.from(s).map((c) => {
    const o = c.codePointAt(0)!;
    if (o >= 0x41 && o <= 0x5a) return String.fromCodePoint(0x1d5d4 + (o - 0x41)); // A-Z
    if (o >= 0x61 && o <= 0x7a) return String.fromCodePoint(0x1d5ee + (o - 0x61)); // a-z
    if (o >= 0x30 && o <= 0x39) return String.fromCodePoint(0x1d7ec + (o - 0x30)); // 0-9
    return c;
  }).join('');
}

function boldFirstSentence(p: string): string {
  const i = p.indexOf('. ');
  return i === -1 ? toBold(p) : toBold(p.slice(0, i + 1)) + p.slice(i + 1);
}

export function buildLinkedinPost(story: Storyboard, config: ProjectConfig, url?: string): string {
  const watch = `Watch the video: ${url ?? LINK_PLACEHOLDER}`;
  const product = config.brand?.name ?? 'the app';
  const tags = (config.publish?.youtube?.tags ?? []).slice(0, 6)
    .map((t) => `#${t.replace(/^#/, '').toLowerCase()}`).join(' ');
  const disclaimer = config.brand?.disclaimer ? `\n\n${config.brand.disclaimer}` : '';
  const tail = `${disclaimer}${tags ? `\n\n${tags}` : ''}`;

  if (story.youtube?.linkedin) {
    const paras = story.youtube.linkedin.split('\n\n');
    const head = boldFirstSentence(paras[0]);
    const rest = paras.slice(1).join('\n\n');
    return `${head}\n\n${watch}${rest ? `\n\n${rest}` : ''}${tail}`;
  }

  const hook = `We recorded a short walkthrough of ${story.feature} in ${product}.`;
  const body = 'The clip drives the real app in the browser and talks through what each part is doing, '
    + 'so you can see how it feels to use rather than reading a feature list.';
  return `${boldFirstSentence(hook)}\n\n${watch}\n\n${body}${tail}`;
}
