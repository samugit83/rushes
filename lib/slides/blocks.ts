// Rendering one composed slide's block to markup. The compiler owns every pixel:
// a slide source declares WHAT is on the slide and the block it belongs in, and
// never a class, a colour or a coordinate.
//
// Every element that a beat can address carries `data-node="<item id>"`. That
// attribute is the entire contract between the storyboard's beats and the deck.

import { CAPACITY, TONE_VAR, type BlockKind, type SlideItem, type SlideSource } from './types.ts';

export function esc(s: string | undefined): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function nodeId(item: SlideItem, i: number): string {
  return item.id ?? `item-${i + 1}`;
}

function toneStyle(item: SlideItem): string {
  return item.tone ? ` style="--tone:${TONE_VAR[item.tone]}"` : '';
}

function boxHtml(item: SlideItem, i: number): string {
  return `<div class="box" data-node="${esc(nodeId(item, i))}"${toneStyle(item)}>
    ${item.badge ? `<span class="badge">${esc(item.badge)}</span>` : ''}
    ${item.label ? `<span class="label">${esc(item.label)}</span>` : ''}
    ${item.detail ? `<span class="detail">${esc(item.detail)}</span>` : ''}
  </div>`;
}

export function renderBlock(slide: SlideSource): string {
  const block = slide.block as BlockKind;
  const items = slide.items ?? [];
  const n = items.length;

  switch (block) {
    case 'title':
      return `<div class="block-title" data-node="headline">
        <div class="headline">${esc(slide.title ?? items[0]?.label)}</div>
        ${slide.subtitle ? `<div class="sub">${esc(slide.subtitle)}</div>` : ''}
      </div>`;

    case 'bullets':
      return `<ul class="block-bullets">${items
        .map((it, i) => `<li data-node="${esc(nodeId(it, i))}">${esc(it.label)}${it.detail ? ` <span class="detail">${esc(it.detail)}</span>` : ''}</li>`)
        .join('')}</ul>`;

    case 'flow-row':
      return `<div class="block-flow-row" data-count="${n}">${items.map(boxHtml).join('')}</div>`;

    case 'stack':
      return `<div class="block-stack">${items.map(boxHtml).join('')}</div>`;

    case 'compare':
      return `<div class="block-compare" data-count="${n}">${items.map((it, i) => `
        <div class="box" data-node="${esc(nodeId(it, i))}"${toneStyle(it)}>
          <span class="label">${esc(it.label)}</span>
          ${it.detail ? `<span class="detail">${esc(it.detail)}</span>` : ''}
          ${(it.items ?? []).map((sub) => `<span class="detail">— ${esc(sub)}</span>`).join('')}
        </div>`).join('')}</div>`;

    case 'sequence': {
      // Participants become columns, messages become rows. The message list is
      // the connector spec in prose form; the SVG paths are drawn from the
      // participant rects after layout.
      const participants = items.filter((it) => !it.value);
      const messages = items.filter((it) => it.value);
      return `<div class="block-sequence">
        <div class="participants" style="grid-template-columns:repeat(${Math.max(1, participants.length)},minmax(0,1fr))">
          ${participants.map(boxHtml).join('')}
        </div>
        <div class="messages">${messages.map((m, i) => `
          <div class="message" data-node="${esc(nodeId(m, participants.length + i))}">
            <span class="n">${i + 1}</span><span>${esc(m.label)}</span>
          </div>`).join('')}</div>
      </div>`;
    }

    case 'ring':
      return `<div class="block-ring">${items.map((it, i) => `
        <div class="ring" data-depth="${i}" data-node="${esc(nodeId(it, i))}"${toneStyle(it)}>
          <span class="label">${esc(it.label)}</span>
          ${it.detail ? `<span class="detail">${esc(it.detail)}</span>` : ''}
        </div>`).join('')}</div>`;

    case 'hub': {
      const [centre, ...satellites] = items;
      return `<div class="block-hub">
        ${centre ? `<div class="centre">${boxHtml(centre, 0)}</div>` : ''}
        ${satellites.map((s, i) => `<div class="satellite">${boxHtml(s, i + 1)}</div>`).join('')}
      </div>`;
    }

    case 'store':
      return `<div class="block-store">${items.map((it, i) => `
        <div class="cyl" data-node="${esc(nodeId(it, i))}"${toneStyle(it)}>
          <div class="label">${esc(it.label)}</div>
          ${it.detail ? `<div class="detail">${esc(it.detail)}</div>` : ''}
        </div>`).join('')}</div>`;

    case 'badge-list':
      return `<div class="block-badge-list">${items.map((it, i) => `
        <span class="chip" data-node="${esc(nodeId(it, i))}"${toneStyle(it)}>${esc(it.label)}</span>`).join('')}</div>`;

    case 'metric':
      return `<div class="block-metric" data-count="${n}">${items.map((it, i) => `
        <div data-node="${esc(nodeId(it, i))}"${toneStyle(it)} style="display:grid;justify-items:center;gap:12px">
          <span class="value">${esc(it.value ?? it.label)}</span>
          <span class="label">${esc(it.detail ?? it.label)}</span>
        </div>`).join('')}</div>`;

    case 'code':
      return `<pre class="block-code" data-node="code">${esc(slide.body)}</pre>`;

    case 'quote':
      return `<div class="block-quote" data-node="quote">
        <div class="text">“${esc(slide.body ?? slide.title)}”</div>
        ${slide.attribution ? `<div class="who">${esc(slide.attribution)}</div>` : ''}
      </div>`;

    case 'layers': {
      // Horizontal lanes, each a titled layer/group. Items sit in a row per lane;
      // connectors are measured and drawn between any nodes, exactly like every
      // other composed block. Geometry is (lane, order) — still no coordinates.
      const lanes = slide.lanes ?? [];
      let idx = 0;
      const laneHtml = lanes.map((lane, li) => {
        const toneVar = lane.tone ? ` style="--tone:${TONE_VAR[lane.tone]}"` : '';
        const boxes = (lane.items ?? []).map((it) => boxHtml(it, idx++)).join('');
        return `<div class="lane" data-lane="${esc(lane.id ?? `lane-${li + 1}`)}"${toneVar}>
          <div class="lane-label">${esc(lane.label ?? '')}</div>
          <div class="lane-row">${boxes}</div>
        </div>`;
      }).join('');
      return `<div class="block-layers">${laneHtml}</div>`;
    }

    default:
      return `<div class="block-title"><div class="headline">${esc(slide.title)}</div></div>`;
  }
}

/**
 * How many items the block actually holds, for the capacity check.
 *
 * A sequence is two independent lists: participants become columns and messages
 * become rows, and neither constrains the other. Summing them made a perfectly
 * ordinary four-participant, five-message diagram fail a capacity of eight, so
 * the count is whichever list is longer.
 */
export function itemCount(slide: SlideSource): number {
  const block = slide.block as BlockKind;
  if (block === 'code' || block === 'quote' || block === 'title') return 1;
  if (block === 'layers') return (slide.lanes ?? []).reduce((n, l) => n + (l.items?.length ?? 0), 0);
  const items = slide.items ?? [];
  if (block === 'sequence') {
    const participants = items.filter((it) => !it.value).length;
    return Math.max(participants, items.length - participants);
  }
  return items.length;
}

export function capacityOf(block: BlockKind): number { return CAPACITY[block] ?? 8; }
