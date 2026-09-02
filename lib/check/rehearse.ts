// Rehearse twice; record only if the two passes agree (E1).
//
// This is a strictly better answer to "is the timing model trustworthy" than a
// one-off golden test, because it validates determinism on THE RUN YOU ARE ABOUT
// TO SHIP rather than once, in the past, on a fixture. The golden timing test
// still exists, for the timing model itself; this is for the take.
//
// What is compared, per scene: the ordered list of resolved locator bounding
// boxes, every `expect` outcome, and the elapsed step time within a tolerance
// band. A disagreement names the scene and the field that differed.
//
// P16.6 — a scene marked `volatile` (an off-origin page whose content the user
// does not control) is EXEMPT from box and timing equality, because a third
// party's page carries rotating content and the two passes would disagree
// forever. It must still satisfy its `expect`, and the exemption is recorded in
// the receipt so a green rehearsal is not overclaimed.

import type { Storyboard, Step } from '../types.ts';
import type { ProjectConfig } from '../projectConfig.ts';
import { THRESHOLDS } from '../config.ts';
import { type Diagnostic, diag, classifyStepError } from '../diagnostics.ts';
import { boot } from '../engine/session.ts';
import { runStep } from '../engine/actions.ts';
import { resolveLocator, locatorOf } from '../engine/locators.ts';

interface ScenePass {
  sceneId: string;
  boxes: (string | null)[];
  expects: boolean[];
  elapsedMs: number;
  stepErrors: string[];
}

export interface RehearsalResult {
  status: 'agreed' | 'disagreed' | 'skipped';
  passes: number;
  exemptScenes: string[];
  diagnostics: Diagnostic[];
}

function roundBox(b: { x: number; y: number; width: number; height: number } | null): string | null {
  if (!b) return null;
  const q = (n: number) => Math.round(n / THRESHOLDS.rehearsalBoxTolerancePx);
  return `${q(b.x)},${q(b.y)},${q(b.width)},${q(b.height)}`;
}

async function onePass(story: Storyboard, config: ProjectConfig, skipAsserts: boolean): Promise<{ scenes: ScenePass[]; diagnostics: Diagnostic[] }> {
  // Silent and unrecorded: no TTS was synthesised for a rehearsal, so no scene
  // holds for a voice that does not exist.
  const session = await boot({ story, config, record: false, skipAsserts });
  const diagnostics = [...session.diagnostics];
  const scenes: ScenePass[] = [];
  if (!session.page) { await session.close(); return { scenes, diagnostics }; }

  try {
    for (const scene of story.scenes) {
      const started = Date.now();
      const boxes: (string | null)[] = [];
      const stepErrors: string[] = [];
      for (const step of scene.steps as Step[]) {
        try {
          await runStep(session.stepContext, step);
        } catch (e) {
          stepErrors.push(`${step.do}: ${(e as Error).message}`);
          diagnostics.push(diag(classifyStepError(e), 'error', (e as Error).message,
            { sceneId: scene.id, do: step.do }, { pass: 'rehearsal' }, ['correct the locator', 'run `rushes validate`']));
        }
        const loc = locatorOf(step);
        boxes.push(loc ? roundBox(await resolveLocator(session.page, loc).boundingBox().catch(() => null)) : null);
      }
      const expects: boolean[] = [];
      for (const want of scene.expect ?? []) {
        expects.push(await resolveLocator(session.page, want).isVisible({ timeout: 3000 }).catch(() => false));
      }
      scenes.push({ sceneId: scene.id, boxes, expects, elapsedMs: Date.now() - started, stepErrors });
    }
  } finally {
    await session.close();
  }
  return { scenes, diagnostics };
}

export async function rehearse(story: Storyboard, config: ProjectConfig): Promise<RehearsalResult> {
  const volatileGlobal = config.external?.volatile ?? false;
  const exempt = story.scenes
    .filter((s) => s.volatile || (volatileGlobal && s.steps.some((st) => st.do === 'goto' && st.external)))
    .map((s) => s.id);

  const a = await onePass(story, config, false);
  const b = await onePass(story, config, true);
  const diagnostics = [...a.diagnostics, ...b.diagnostics];

  let agreed = true;
  for (const first of a.scenes) {
    const second = b.scenes.find((s) => s.sceneId === first.sceneId);
    if (!second) {
      agreed = false;
      diagnostics.push(diag('rehearsal/non-deterministic', 'error',
        `scene "${first.sceneId}" ran in the first pass and not in the second`,
        { sceneId: first.sceneId }, {}, ['re-run `rushes rehearse`', 'check the app is stable']));
      continue;
    }

    // `expect` equality applies to every scene, exempt or not: an off-origin
    // page may change its content, but it must still show what was claimed.
    if (JSON.stringify(first.expects) !== JSON.stringify(second.expects)) {
      agreed = false;
      diagnostics.push(diag('rehearsal/non-deterministic', 'error',
        `scene "${first.sceneId}" satisfied its expects in one pass and not the other`,
        { sceneId: first.sceneId, field: 'expect' },
        { first: first.expects, second: second.expects },
        ['add a waitFor before the expect', 'raise readiness.timeoutMs', 'the app is racy here']));
    }

    if (exempt.includes(first.sceneId)) continue;

    if (JSON.stringify(first.boxes) !== JSON.stringify(second.boxes)) {
      agreed = false;
      const idx = first.boxes.findIndex((v, i) => v !== second.boxes[i]);
      diagnostics.push(diag('rehearsal/non-deterministic', 'error',
        `scene "${first.sceneId}" resolved step ${idx} to a different position between passes`,
        { sceneId: first.sceneId, stepIndex: idx, field: 'boundingBox' },
        { first: first.boxes[idx], second: second.boxes[idx] },
        ['pin the layout: the element moves between runs',
         'target a stable ancestor',
         `mark the scene "volatile": true if it films a page you do not control`]));
    }

    const slower = Math.max(first.elapsedMs, second.elapsedMs);
    const faster = Math.min(first.elapsedMs, second.elapsedMs);
    if (faster > 0 && (slower - faster) / faster > THRESHOLDS.rehearsalTimingTolerancePct) {
      agreed = false;
      diagnostics.push(diag('rehearsal/non-deterministic', 'error',
        `scene "${first.sceneId}" took ${first.elapsedMs} ms then ${second.elapsedMs} ms`,
        { sceneId: first.sceneId, field: 'elapsedMs' },
        { first: first.elapsedMs, second: second.elapsedMs },
        ['replace a fixed wait with a waitFor',
         'set readiness.busySelector so the engine waits on the app\'s own spinner',
         'the app is slow on a cold cache: warm it in prep']));
    }

    if (JSON.stringify(first.stepErrors) !== JSON.stringify(second.stepErrors)) {
      agreed = false;
      diagnostics.push(diag('rehearsal/non-deterministic', 'error',
        `scene "${first.sceneId}" failed differently between passes`,
        { sceneId: first.sceneId, field: 'stepErrors' },
        { first: first.stepErrors, second: second.stepErrors },
        ['fix the intermittent step before recording']));
    }
  }

  return { status: agreed ? 'agreed' : 'disagreed', passes: 2, exemptScenes: exempt, diagnostics };
}
