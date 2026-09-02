// Drives the live application while recording the viewport, and emits a timeline
// of when each scene played. The recorded webm is the master clock: the audio
// and caption stages lay narration at the scene offsets captured here, so voice,
// captions and on-screen action stay locked together.
//
// THE CHANGE THAT MATTERS. Step failures are no longer swallowed. The old code
// caught every exception, printed a line nobody read, ran the scene's full hold,
// pushed the timeline entry anyway and told the build nothing — so a storyboard
// where every locator was broken produced a complete, correctly narrated,
// correctly captioned video of a page that never changed. Each failure now
// screenshots the moment it happened, collects the visible alternatives, and
// becomes a diagnostic the checker can refuse to deliver on.

import { writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { Storyboard, RecordResult, TimelineEntry, Step, Beat } from '../types.ts';
import { TIMING } from '../config.ts';
import type { ProjectConfig } from '../projectConfig.ts';
import { demoPaths } from '../paths.ts';
import { type Diagnostic, Diagnostics, classifyStepError, diag } from '../diagnostics.ts';
import { boot, holdPageUrl, type Session } from './session.ts';
import { runStep, activePage, closeExternalVisit } from './actions.ts';
import { resolveLocator, describeLocator, locatorOf, suggestFixes } from './locators.ts';
import { ffprobeDurationMs } from '../compose/ffprobe.ts';
import { scanText, scanNeverShow } from '../secrets.ts';
import { beatOffsets } from '../compose/alignment.ts';

export interface RecordOptions {
  story: Storyboard;
  config: ProjectConfig;
  headed?: boolean;
  /** Pre-booted session, so `rehearse` can reuse the boot it already paid for. */
  session?: Session;
}

/** Visible text of the current page, for the privacy scan (E5). */
async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
}

export async function record(opts: RecordOptions): Promise<RecordResult> {
  const { story, config } = opts;
  const P = demoPaths(story.id);
  mkdirSync(P.dir, { recursive: true });
  mkdirSync(P.evidenceDir, { recursive: true });

  const session = opts.session ?? await boot({ story, config, record: true, headed: opts.headed });
  const problems = new Diagnostics();
  problems.merge(session.diagnostics);
  if (!session.page) {
    // boot failed before a browser existed; the diagnostics say why.
    return {
      webm: '', durationMs: 0, leadTrimMs: 0, timeline: [], problems: problems.all,
      sceneText: {}, hostsContacted: [], hostRules: session.hostRules, beatsFired: {},
    };
  }

  const { page, stepContext } = session;
  const neverShow = config.neverShow ?? [];
  const sceneText: Record<string, string> = {};
  const beatsFired: Record<string, number> = {};

  // When scene 0 opens with its own `goto`, the boot page is pure staging: it
  // would sit on screen for bootMs and, because the leadTrimMs trim is only
  // approximate against a change-driven screencast, leak past the trim into the
  // top of the finished video. Park on a neutral dark frame first so anything
  // that leaks reads as an intentional cut rather than the wrong page.
  if (story.scenes[0]?.steps?.[0]?.do === 'goto') {
    await page.goto(holdPageUrl(), { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(TIMING.preRollMs);
  }

  const t0 = Date.now();
  const leadTrimMs = t0 - session.recordStart; // trimmed off the front in the mux
  await page.waitForTimeout(TIMING.bootMs);

  const timeline: TimelineEntry[] = [];
  let videoHandle: ReturnType<Page['video']> = null;

  // Everything from here to the close is wrapped, because a recording holds the
  // operator's pre-state and runs for minutes. Anything that escaped this loop
  // used to leak the browser and skip the restore, which is the same outcome as
  // a Ctrl-C with no handler: preferences left mutated, with no message.
  // `expect: [{ "nth": 0 }]` is schema-valid, resolves to no element, and threw
  // from outside every inner catch.
  try {
  for (const scene of story.scenes) {
    const startMs = Date.now() - t0;
    process.stderr.write(`  ▶ ${scene.id}\n`);

    // Slide beats are anchored to WORDS, so a reworded sentence or a different
    // voice moves every beat correctly with no storyboard edit (L4).
    const beats = scene.beats?.length && scene.audio?.alignmentPath
      ? beatOffsets(scene.beats, scene.narration, scene.audio.alignmentPath)
      : [];
    let firedCount = 0;
    const pendingBeats = [...beats];

    const stepTimings: { do: Step['do']; ms: number }[] = [];
    for (let i = 0; i < scene.steps.length; i++) {
      const step = scene.steps[i];
      const stepStarted = Date.now();
      try {
        await runStep(stepContext, step);
      } catch (e) {
        const code = classifyStepError(e);
        const shot = join(P.evidenceDir, `fail-${scene.id}-${i}.png`);
        // A screenshot at the moment of failure is the difference between "a
        // locator missed" and knowing what was actually on screen instead.
        await page.screenshot({ path: shot }).catch(() => {});
        const loc = locatorOf(step);
        const { supportedFixes, evidence } = await suggestFixes(page, loc);
        problems.add(diag(code, 'error', (e as Error).message,
          { sceneId: scene.id, stepIndex: i, do: step.do, locator: loc ? describeLocator(loc) : null },
          { screenshot: shot, url: page.url(), waitedMs: Date.now() - stepStarted, ...evidence },
          supportedFixes));
      }
      stepTimings.push({ do: step.do, ms: Date.now() - stepStarted });

      // Fire any beat whose anchor word has already been spoken by now.
      const elapsed = Date.now() - t0 - startMs;
      while (pendingBeats.length && pendingBeats[0].offsetMs - TIMING.beatLeadMs <= elapsed) {
        const b = pendingBeats.shift()!;
        if (await fireBeat(page, b.beat, b.index)) firedCount++;
      }
    }

    const actionEndMs = Date.now() - t0;

    // Hold for the voice: audio + tail, or the scene floor, whichever is longer.
    // The picture is stretched to the voice, never the reverse.
    const target = Math.max(
      (scene.audio?.durationMs ?? 0) + (scene.tailPadMs ?? TIMING.sceneTailPadMs),
      scene.minHoldMs ?? TIMING.minSceneMs,
    );
    const deadline = t0 + startMs + target;
    // Remaining beats fire on their own offsets during the hold.
    while (pendingBeats.length) {
      const b = pendingBeats[0];
      const at = t0 + startMs + Math.max(0, b.offsetMs - TIMING.beatLeadMs);
      const wait = at - Date.now();
      if (wait > 0) await page.waitForTimeout(Math.min(wait, Math.max(0, deadline - Date.now())));
      if (Date.now() >= deadline) break;
      pendingBeats.shift();
      if (await fireBeat(page, b.beat, b.index)) firedCount++;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await page.waitForTimeout(remaining);

    beatsFired[scene.id] = firedCount;
    if (beats.length && firedCount < beats.length) {
      problems.add(diag('slide/beat-not-reached', 'error',
        `${beats.length - firedCount} of ${beats.length} beats never fired in scene "${scene.id}"`,
        { sceneId: scene.id }, { declared: beats.length, fired: firedCount },
        ['shorten the narration so the beats fit', 'raise the scene minHoldMs', 'check the beat targets exist in the slide']));
    }

    // D3: assert what must be on screen, after the steps, before the timeline
    // entry is pushed. Today a scene's claim and what is on screen are connected
    // only by hope; `expect` is the highest-value single change in the pipeline.
    for (const want of scene.expect ?? []) {
      // A descriptor with no addressable field throws rather than returning
      // false, and an unresolvable expect is a diagnostic, never an exception.
      // Assert against whichever page is on screen: a scene that ends on an
      // off-origin page must be able to claim what is visible there.
      const surface = activePage(stepContext);
      let okNow = false;
      try {
        okNow = await resolveLocator(surface, want).isVisible({ timeout: 3000 }).catch(() => false);
      } catch (e) {
        problems.add(diag('storyboard/step-arg-mismatch', 'error',
          `scene "${scene.id}" declares an expect with no addressable field: ${(e as Error).message}`,
          { sceneId: scene.id, expect: want }, {},
          ['add "text", "role" + "name", "testId" or "css" to the expect',
           'remove the expect if there is nothing to assert']));
        continue;
      }
      if (!okNow) {
        const shot = join(P.evidenceDir, `fail-${scene.id}-expect.png`);
        await page.screenshot({ path: shot }).catch(() => {});
        const { supportedFixes, evidence } = await suggestFixes(page, want);
        problems.add(diag('scene/expect-failed', 'error',
          `scene "${scene.id}" expected ${describeLocator(want)} on screen`,
          { sceneId: scene.id, expect: describeLocator(want) },
          { screenshot: shot, url: page.url(), ...evidence },
          supportedFixes));
      }
    }

    // E5: a secret on screen in a video destined for a public channel is an
    // incident, not a bug. Error at EVERY profile.
    // An off-origin page is filmed from a separate context, so its text is read
    // from there rather than off the recorded page.
    const externalText = stepContext.externalVisit
      ? await visibleText(stepContext.externalVisit.page)
      : (stepContext.externalText ?? '');
    stepContext.externalText = undefined;
    // The visit ends with the scene: the next scene starts on the app again.
    await closeExternalVisit(stepContext);
    const text = [await visibleText(page), externalText].filter(Boolean).join('\n');
    sceneText[scene.id] = text;
    const external = !!externalText;
    for (const hit of scanText(text)) {
      problems.add(diag(external ? 'external/secret-on-screen' : 'privacy/secret-on-screen',
        external ? 'warning' : 'error',
        `a ${hit.name} pattern is visible on screen in scene "${scene.id}"`,
        { sceneId: scene.id, url: page.url() }, { pattern: hit.name, excerpt: hit.excerpt },
        ['add a selector to `redact` in the config or the storyboard',
         'record against a seeded demo tenant',
         external ? 'acknowledge it explicitly if the public page legitimately shows an example key' : 'remove the value from the demo data']));
    }
    for (const term of scanNeverShow(text + ' ' + scene.narration, neverShow)) {
      problems.add(diag('intake/never-show-violated', 'error',
        `"${term}" is on the never-show list and appears in scene "${scene.id}"`,
        { sceneId: scene.id, term }, {},
        ['redact it', 'change the demo data', 'reword the narration']));
    }

    timeline.push({
      sceneId: scene.id,
      startMs,
      endMs: Date.now() - t0,
      narration: scene.narration,
      audioPath: scene.audio?.path,
      audioDurationMs: scene.audio?.durationMs,
      steps: stepTimings,
      actionEndMs,
    });
  }

  await page.waitForTimeout(700); // let the last frame settle
  } finally {
    // The close runs whatever happened: it deregisters the signal handler,
    // restores the pre-state and tears down the browser.
    videoHandle = page.video();
    await session.close();
  }

  const rawPath = videoHandle ? await videoHandle.path() : '';
  if (!rawPath || !existsSync(rawPath)) throw new Error('the browser produced no video file');
  copyFileSync(rawPath, P.webm);
  const durationMs = ffprobeDurationMs(P.webm);
  writeFileSync(P.timeline, JSON.stringify({ durationMs, leadTrimMs, timeline }, null, 2));
  writeFileSync(P.problems, JSON.stringify(problems.toJSON(), null, 2));

  process.stderr.write(
    `  screencast ${(durationMs / 1000).toFixed(1)}s (trim ${(leadTrimMs / 1000).toFixed(1)}s lead) -> ${P.webm}\n`);

  return {
    webm: P.webm, durationMs, leadTrimMs, timeline,
    problems: problems.all, sceneText,
    hostsContacted: session.hostsContacted,
    hostRules: session.hostRules,
    beatsFired,
  };
}

async function fireBeat(page: Page, beat: Beat, index: number): Promise<boolean> {
  return page.evaluate(({ n, b }) => {
    const api = (window as unknown as { __slide?: { beat: (n: number, b: unknown) => boolean } }).__slide;
    if (!api) return false;
    try { return api.beat(n, b) !== false; } catch { return false; }
  }, { n: index, b: beat }).catch(() => false);
}

/** T4: the slowest step in a scene, so dead air is attributable. */
export function slowestStep(entry: TimelineEntry): { do: string; ms: number } | null {
  if (!entry.steps?.length) return null;
  return [...entry.steps].sort((a, b) => b.ms - a.ms)[0];
}

export function pacingReport(timeline: TimelineEntry[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const e of timeline) {
    const gap = e.endMs - e.startMs - (e.audioDurationMs ?? 0);
    if (gap <= 8000) continue;
    const slow = slowestStep(e);
    out.push(diag('scene/dead-air', 'warning',
      `scene "${e.sceneId}" holds ${(gap / 1000).toFixed(1)}s of silence after the narration ends`,
      { sceneId: e.sceneId },
      { gapMs: Math.round(gap), slowestStep: slow ? `${slow.do} (${slow.ms} ms)` : null },
      ['lengthen the narration line', 'split the scene',
       slow ? `drop or speed up the "${slow.do}" step` : 'drop the slow step',
       'the mux freezes the final frame instead of recording live idle (T3)']));
  }
  return out;
}
