// Load, validate and lint a storyboard. Two layers:
//
//   1. JSON Schema with additionalProperties:false. Before this existed,
//      "minHold": 9000 instead of "minHoldMs" was silently ignored and the scene
//      fell back to 2,200 ms; "do": "clik" hit no case in the switch and
//      returned silently. Both now fail loudly.
//   2. Cross-field lint the schema cannot express: chapter labels that name no
//      scene, step arguments that belong to a different step kind, a title that
//      will not fit YouTube, a demonstrative narration with no `expect`.
//
// schema_version exists from day one on purpose. Adding it later, with a
// catalogue already in the wild, is the expensive version of this decision.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import addFormatsModule from 'ajv-formats';
import type { Ajv as AjvType } from 'ajv';

// ajv-formats ships CommonJS, so from ESM the callable default lands one level
// deep and the namespace itself is not callable.
type AddFormats = (ajv: AjvType) => AjvType;
const addFormats = ((addFormatsModule as unknown as { default?: AddFormats }).default
  ?? (addFormatsModule as unknown as AddFormats));
import { SKILL_ROOT } from './env.ts';
import { projectRoot } from './paths.ts';
import { type Diagnostic, diag } from './diagnostics.ts';
import { formatAjvErrors, type ProjectConfig } from './projectConfig.ts';
import type { Storyboard, Step, Locator } from './types.ts';

export function storyboardPath(id: string, root = projectRoot()): string {
  return join(root, 'demos', `${id}.demo.json`);
}

// Compiled once: Ajv refuses the same $id twice, so a per-call compile throws
// on the second storyboard loaded in one process.
let compiled: ReturnType<AjvType['compile']> | null = null;
function validator() {
  if (!compiled) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    compiled = ajv.compile(JSON.parse(readFileSync(join(SKILL_ROOT, 'schemas', 'storyboard.schema.json'), 'utf8')));
  }
  return compiled;
}

const TITLE_MAX = 100;
const SENTENCE_MAX = 60;
const DEMONSTRATIVES = /\b(this|these|here|right here|click any|as you can see|on the left|on the right|notice)\b/i;

function locatorOf(step: Step): Locator | null {
  const { css, text, exact, role, name, testId, nth } = step;
  if (css == null && text == null && role == null && testId == null) return null;
  return { css, text, exact, role, name, testId, nth };
}

/** Arguments each step kind actually reads. Anything else is a mismatch. */
const STEP_ARGS: Record<string, { requires?: (keyof Step)[]; oneOf?: (keyof Step)[]; forbids?: (keyof Step)[] }> = {
  goto: { oneOf: ['path', 'external'], forbids: ['value', 'keys', 'factor', 'dx'] },
  slide: { requires: ['slide'], forbids: ['path', 'value', 'keys', 'factor'] },
  wait: { requires: ['ms'] },
  press: { requires: ['keys'], forbids: ['value', 'factor'] },
  type: { requires: ['value'], forbids: ['keys', 'factor'] },
  zoom: { requires: ['factor'], forbids: ['dy', 'dx', 'value', 'keys'] },
  drag: { oneOf: ['dx', 'dy'], forbids: ['factor', 'value', 'keys'] },
  scroll: { requires: ['dy'], forbids: ['factor', 'value', 'keys'] },
  clickCanvas: { forbids: ['value', 'keys', 'factor'] },
  click: { forbids: ['value', 'keys', 'factor', 'path'] },
  hover: { forbids: ['value', 'keys', 'factor', 'path'] },
  moveTo: { forbids: ['value', 'keys', 'factor', 'path'] },
  highlight: { forbids: ['value', 'keys', 'factor', 'path'] },
  waitFor: { forbids: ['value', 'keys', 'factor', 'path'] },
};

const NEEDS_LOCATOR = new Set(['click', 'hover', 'moveTo', 'type', 'highlight', 'waitFor']);

/** Steps that address something a person interacts with, so a semantic locator exists. */
const SEMANTIC_TARGETS = new Set(['click', 'hover', 'moveTo', 'type', 'highlight']);

export function lintStoryboard(story: Storyboard, config?: ProjectConfig): Diagnostic[] {
  const out: Diagnostic[] = [];
  const sceneIds = new Set(story.scenes.map((s) => s.id));

  // Duplicate scene ids silently collapse chapters and audio cache entries.
  const seen = new Set<string>();
  for (const s of story.scenes) {
    if (seen.has(s.id)) {
      out.push(diag('storyboard/schema', 'error', `duplicate scene id "${s.id}"`, { sceneId: s.id }, {},
        ['rename one of the two scenes']));
    }
    seen.add(s.id);
  }

  const allSteps: { step: Step; sceneId: string; index: number }[] = [
    ...(story.prep ?? []).map((step, index) => ({ step, sceneId: '(prep)', index })),
    ...story.scenes.flatMap((sc) => sc.steps.map((step, index) => ({ step, sceneId: sc.id, index }))),
  ];

  for (const { step, sceneId, index } of allSteps) {
    const rule = STEP_ARGS[step.do];
    const subject = { sceneId, stepIndex: index, do: step.do };
    if (rule) {
      for (const req of rule.requires ?? []) {
        if (step[req] === undefined) {
          out.push(diag('storyboard/step-arg-mismatch', 'error', `"${step.do}" requires "${String(req)}"`, subject,
            { step }, [`add "${String(req)}" to the step`]));
        }
      }
      if (rule.oneOf && !rule.oneOf.some((k) => step[k] !== undefined)) {
        out.push(diag('storyboard/step-arg-mismatch', 'error',
          `"${step.do}" needs one of: ${rule.oneOf.map(String).join(', ')}`, subject, { step },
          rule.oneOf.map((k) => `add "${String(k)}"`)));
      }
      for (const bad of rule.forbids ?? []) {
        if (step[bad] !== undefined) {
          out.push(diag('storyboard/step-arg-mismatch', 'error',
            `"${step.do}" does not read "${String(bad)}"`, subject, { step },
            [`remove "${String(bad)}"`, 'use the step kind that reads it']));
        }
      }
    }
    if (NEEDS_LOCATOR.has(step.do) && !locatorOf(step)) {
      out.push(diag('storyboard/step-arg-mismatch', 'error', `"${step.do}" has no locator`, subject, { step },
        ['add "text"', 'add "role" + "name"', 'add "testId"', 'add "css" as a last resort']));
    }
    // Q3: a css locator where a semantic one was available survives a refactor
    // badly. The engine reports the alternative it found at record time; here we
    // can only flag the shape.
    //
    // Only for steps that address something a person interacts with. A `drag` or
    // a `zoom` on a canvas has no role and no accessible name by construction,
    // and warning about it every time trains the reader to ignore the warning.
    const loc = locatorOf(step);
    if (SEMANTIC_TARGETS.has(step.do) && loc?.css && !loc.text && !loc.role && !loc.testId) {
      out.push(diag('storyboard/css-over-semantic', 'warning',
        `"${step.do}" targets a raw css selector`, subject, { css: loc.css },
        ['prefer "text"', 'prefer "role" + "name"', 'prefer "testId"']));
    }
    // P16.1: an off-origin navigation must be declared, both as a step form and
    // in the config allowlist.
    if (step.do === 'goto' && step.path && /^[a-z][a-z0-9+.-]*:\/\//i.test(step.path)) {
      out.push(diag('storyboard/step-arg-mismatch', 'error',
        'an absolute URL in "path" is not an external navigation', subject, { path: step.path },
        ['move the URL to "external"', 'use a relative path for the application origin']));
    }
    if (step.do === 'goto' && step.external) {
      const allow = config?.external?.allow ?? [];
      let host = '';
      try { host = new URL(step.external).hostname; } catch { /* reported below */ }
      if (!host) {
        out.push(diag('storyboard/step-arg-mismatch', 'error', `"external" is not a URL`, subject,
          { external: step.external }, ['use an absolute https:// URL']));
      } else if (!allow.some((a) => host === a.replace(/^\./, '') || host.endsWith(`.${a.replace(/^\./, '')}`))) {
        out.push(diag('external/host-not-allowed', 'error',
          `"${host}" is not in external.allow`, subject, { host, allow },
          [`add "${host}" to external.allow in rushes.config.json`, 'remove the external step']));
      }
    }
  }

  // Slides referenced but not authored.
  const slideDir = join(projectRoot(), 'slides', 'src');
  for (const { step, sceneId, index } of allSteps) {
    if (step.do !== 'slide' || !step.slide) continue;
    if (!existsSync(join(slideDir, `${step.slide}.slide.json`))) {
      out.push(diag('slide/source-drift', 'error', `no slide source "${step.slide}.slide.json"`,
        { sceneId, stepIndex: index, slide: step.slide }, { expected: join(slideDir, `${step.slide}.slide.json`) },
        ['author the slide source', 'point the step at an existing slide id']));
    }
  }

  // Chapter labels that name no scene produce timestamps for nothing.
  for (const key of Object.keys(story.youtube?.chapterLabels ?? {})) {
    if (key !== 'intro' && key !== 'outro' && !sceneIds.has(key)) {
      out.push(diag('storyboard/chapter-orphan', 'error', `chapterLabels key "${key}" names no scene`,
        { key }, { sceneIds: [...sceneIds] },
        ['rename the key to a scene id', 'remove the label', 'use "intro" or "outro"']));
    }
  }

  // The published title is prefix + sentence and YouTube truncates at 100.
  const prefix = config?.publish?.youtube?.titlePrefix ?? '';
  const sentence = story.youtube?.title ?? story.feature;
  if (sentence.length > SENTENCE_MAX) {
    out.push(diag('youtube/title-too-long', 'warning',
      `youtube.title is ${sentence.length} characters; aim under ${SENTENCE_MAX}`,
      { title: sentence }, { limit: SENTENCE_MAX }, ['shorten the sentence']));
  }
  if ((prefix + sentence).length > TITLE_MAX) {
    out.push(diag('youtube/title-too-long', 'error',
      `title prefix + sentence is ${(prefix + sentence).length} characters, over ${TITLE_MAX}`,
      { title: prefix + sentence }, { prefix, sentence },
      ['shorten youtube.title', 'shorten publish.youtube.titlePrefix']));
  }

  // A scene whose voice points at something must declare what is on screen.
  for (const sc of story.scenes) {
    if (DEMONSTRATIVES.test(sc.narration) && !(sc.expect?.length)) {
      out.push(diag('storyboard/missing-expect', 'warning',
        `scene "${sc.id}" narration points at something but declares no expect`,
        { sceneId: sc.id }, { narration: sc.narration.slice(0, 90) },
        ['add "expect": [{ "text": "<what is on screen>" }]']));
    }
    // L4: a beat anchor must exist in the narration exactly once, or carry an index.
    for (const beat of sc.beats ?? []) {
      const re = new RegExp(`\\b${beat.on.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      const hits = sc.narration.match(re) ?? [];
      if (hits.length === 0) {
        out.push(diag('slide/beat-anchor-missing', 'error',
          `beat anchor "${beat.on}" does not appear in the narration`,
          { sceneId: sc.id, anchor: beat.on }, { narration: sc.narration.slice(0, 120) },
          ['use a word the narration actually says', 'reword the narration to include the anchor']));
      } else if (hits.length > 1 && !beat.occurrence) {
        out.push(diag('slide/beat-anchor-ambiguous', 'error',
          `beat anchor "${beat.on}" appears ${hits.length} times and no occurrence was given`,
          { sceneId: sc.id, anchor: beat.on }, { occurrences: hits.length },
          ['add "occurrence": 1 (or 2, ...)', 'choose a word that appears once']));
      }
    }
    if ((sc.beats?.length ?? 0) > 0 && !sc.steps.some((s) => s.do === 'slide')) {
      out.push(diag('storyboard/step-arg-mismatch', 'error',
        `scene "${sc.id}" declares beats but shows no slide`, { sceneId: sc.id }, {},
        ['add a { "do": "slide", "slide": "<id>" } step', 'remove the beats']));
    }
  }

  return out;
}

export interface LoadedStoryboard {
  story: Storyboard;
  raw: string;
  path: string;
  diagnostics: Diagnostic[];
}

export function parseStoryboard(raw: string, path: string, config?: ProjectConfig): LoadedStoryboard {
  const diagnostics: Diagnostic[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    diagnostics.push(diag('input/json-parse', 'error', `storyboard is not valid JSON: ${(e as Error).message}`,
      { path }, {}, ['fix the JSON syntax at the reported position']));
    throw Object.assign(new Error('storyboard is not valid JSON'), { diagnostics });
  }

  const validate = validator();
  if (!validate(parsed)) {
    for (const msg of formatAjvErrors(validate.errors)) {
      diagnostics.push(diag('storyboard/schema', 'error', msg, { path }, {},
        ['remove the unknown key', 'correct the value type', 'see schemas/storyboard.schema.json']));
    }
  }

  const story = parsed as Storyboard;
  if (story && typeof story === 'object' && Array.isArray(story.scenes)) {
    diagnostics.push(...lintStoryboard(story, config));
  }
  return { story, raw, path, diagnostics };
}

export function loadStoryboard(id: string, config?: ProjectConfig, root = projectRoot()): LoadedStoryboard {
  const path = storyboardPath(id, root);
  if (!existsSync(path)) throw new Error(`no storyboard at ${path}`);
  const raw = readFileSync(path, 'utf8');
  const loaded = parseStoryboard(raw, path, config);
  if (loaded.story?.id && loaded.story.id !== id) {
    loaded.diagnostics.push(diag('storyboard/schema', 'error',
      `storyboard id "${loaded.story.id}" does not match the file name "${id}"`, { path }, {},
      [`rename the file to ${loaded.story.id}.demo.json`, `set "id": "${id}"`]));
  }
  return loaded;
}
