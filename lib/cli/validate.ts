// `rushes validate <id>`: schema, cross-field lint, and a LIVE dry run of every
// step and every expect.
//
// It replaces a hand-maintained probe script that pinned a project id, a user id
// and an onboarding version as constants. Those constants drifted, which meant
// the probe validated against a DIFFERENT project than the storyboard named —
// and the instructions told the next agent to edit the script in place, so the
// drift compounded.
//
// The fix is structural, not tidiness: validate boots through the same `boot()`
// the recorder uses (principle 8). A validator that boots differently from the
// recorder can pass steps the recorder will fail.

import { writeFileSync } from 'node:fs';
import type { Step } from '../types.ts';
import { loadConfig } from '../projectConfig.ts';
import { loadStoryboard } from '../storyboard.ts';
import { demoPaths, ensureDir } from '../paths.ts';
import { Diagnostics, printDiagnostics, classifyStepError, diag } from '../diagnostics.ts';
import { boot } from '../engine/session.ts';
import { runStep } from '../engine/actions.ts';
import { resolveLocator, describeLocator, locatorOf, suggestFixes } from '../engine/locators.ts';
import { compileDeck } from '../slides/compile.ts';

export interface ValidateOptions { id: string; json: boolean; headed?: boolean; live?: boolean }

export async function validate(opts: ValidateOptions): Promise<number> {
  const problems = new Diagnostics();
  const loaded = loadConfig();
  problems.merge(loaded.diagnostics);

  let sb;
  try {
    sb = loadStoryboard(opts.id, loaded.config);
  } catch (e) {
    const ds = (e as { diagnostics?: unknown }).diagnostics;
    if (Array.isArray(ds)) problems.merge(ds as never);
    else problems.push('input/json-parse', 'error', (e as Error).message, { id: opts.id }, {}, ['check the file exists']);
    return report(problems, opts.json);
  }
  problems.merge(sb.diagnostics);

  // Slide sources are validated even when the live pass is skipped: a slide
  // step pointing at a source that does not exist is a schema-level fault.
  if (sb.story.scenes.some((s) => s.steps.some((st) => st.do === 'slide'))) {
    problems.merge(compileDeck({ config: loaded.config }).diagnostics);
  }

  if (opts.live === false || problems.errors.length) {
    // A storyboard that does not parse cannot be dry-run; say so plainly rather
    // than failing again in the browser.
    return report(problems, opts.json);
  }

  const session = await boot({ story: sb.story, config: loaded.config, record: false, headed: opts.headed });
  problems.merge(session.diagnostics);
  if (!session.page) return report(problems, opts.json);

  const P = demoPaths(opts.id);
  ensureDir(P.dir);

  try {
    for (const scene of sb.story.scenes) {
      for (let i = 0; i < scene.steps.length; i++) {
        const step = scene.steps[i] as Step;
        try {
          await runStep(session.stepContext, step);
        } catch (e) {
          const loc = locatorOf(step);
          const { supportedFixes, evidence } = await suggestFixes(session.page, loc);
          problems.push(classifyStepError(e), 'error', (e as Error).message,
            { sceneId: scene.id, stepIndex: i, do: step.do, locator: loc ? describeLocator(loc) : null },
            { url: session.page.url(), ...evidence }, supportedFixes);
        }
      }
      for (const want of scene.expect ?? []) {
        const ok = await resolveLocator(session.page, want).isVisible({ timeout: 3000 }).catch(() => false);
        if (!ok) {
          const { supportedFixes, evidence } = await suggestFixes(session.page, want);
          problems.add(diag('scene/expect-failed', 'error',
            `scene "${scene.id}" expected ${describeLocator(want)} on screen`,
            { sceneId: scene.id, expect: describeLocator(want) },
            { url: session.page.url(), ...evidence }, supportedFixes));
        }
      }
    }
  } finally {
    await session.close();
  }

  writeFileSync(P.problems, JSON.stringify(problems.toJSON(), null, 2));
  return report(problems, opts.json);
}

function report(problems: Diagnostics, json: boolean): number {
  if (json) {
    process.stdout.write(JSON.stringify({
      ok: problems.ok,
      errors: problems.errors.length,
      warnings: problems.warnings.length,
      diagnostics: problems.toJSON(),
    }, null, 2) + '\n');
  } else if (problems.length) {
    printDiagnostics(problems.all);
    process.stderr.write(`\n  ${problems.errors.length} errors, ${problems.warnings.length} warnings\n`);
  } else {
    process.stderr.write('  ✓ storyboard validates, and every step and expect resolved live\n');
  }
  return problems.ok ? 0 : 1;
}
