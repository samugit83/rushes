// `rushes slides <build|check|preview|tokens>`.
//
// `preview` is the important one. It compiles the deck and screenshots every
// slide, with no voice, no recording and no ffmpeg: seconds, and no spend. That
// is the gate where a user directs slide design, in words, against a picture
// that already exists.
//
// The rule it enforces: a user never names a CSS property and never names a
// block unprompted. They say "make slide 2 a flow, not bullets" or "too dense",
// and the agent maps words to blocks. Never render a slide for the first time
// inside a finished video — that is the most expensive possible place to
// discover a design is wrong.

import { copyFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { loadConfig } from '../projectConfig.ts';
import { slidePaths, demoPaths, ensureDir, projectRoot } from '../paths.ts';
import { Diagnostics, printDiagnostics } from '../diagnostics.ts';
import { compileDeck } from '../slides/compile.ts';
import { renderSlides, writeContactSheet } from '../slides/render.ts';
import { captureGifs } from '../slides/gif.ts';
import { checkSlides, checkGoldens } from '../slides/check.ts';
import { verifyFixes } from '../slides/repair.ts';
import { extractTokens, writeProjectTokens, summarise } from '../slides/tokens.ts';
import { boot } from '../engine/session.ts';

export async function slides(
  sub: string,
  id: string | undefined,
  opts: { updateGolden: boolean; json: boolean; verifyFixes?: boolean; noGif?: boolean },
): Promise<number> {
  const problems = new Diagnostics();
  const loaded = loadConfig();
  problems.merge(loaded.diagnostics);
  const paths = slidePaths();

  if (sub === 'tokens') return await deriveTokens(loaded.config.baseUrl);

  const compiled = compileDeck({ config: loaded.config });
  problems.merge(compiled.diagnostics);
  if (!compiled.slides.length) {
    process.stderr.write(`no slide sources in ${join(projectRoot(), 'slides', 'src')}\n`);
    return problems.ok ? 0 : 1;
  }
  process.stderr.write(`  compiled ${compiled.slides.length} slides -> ${compiled.deckPath}\n`);
  if (sub === 'build' && !opts.updateGolden) return finish(problems, opts.json);

  const outDir = sub === 'preview' && id
    ? demoPaths(id).slidePreviewDir
    : join(projectRoot(), 'out', 'slides-preview');
  ensureDir(outDir);

  const rendered = await renderSlides({ slides: compiled.slides, outDir });
  problems.merge(checkSlides({ rendered }));

  if (opts.updateGolden) {
    // Deliberate, never automatic: a golden that updates itself measures
    // nothing.
    mkdirSync(paths.golden, { recursive: true });
    let n = 0;
    for (const r of rendered) {
      if (!r.png) continue;
      copyFileSync(r.png, join(paths.golden, `${r.id}.png`));
      n++;
    }
    process.stderr.write(`  re-pinned ${n} golden frame(s) in ${paths.golden}\n`);
  } else {
    problems.merge(await checkGoldens(rendered));
  }

  // Prove the repairs before an author acts on them. This is the loop's whole
  // point, so it belongs to `check`, where someone is iterating, and not to
  // `deliver`, whose job is to refuse rather than to repair.
  const verify = opts.verifyFixes ?? (sub === 'check');
  if (verify && problems.length) {
    const before = Date.now();
    await verifyFixes({ config: loaded.config, sources: compiled.slides, diagnostics: problems.all });
    process.stderr.write(`  verified the proposed repairs by re-rendering (${((Date.now() - before) / 1000).toFixed(1)}s)\n`);
  }

  if (sub === 'preview') {
    // Animated slides get a gif so the motion — flowing edges, beat pulses — is
    // visible at preview time, not discovered only in the recorded video.
    let gifs: Record<string, string> = {};
    if (!opts.noGif) {
      const before = Date.now();
      const results = await captureGifs({ deckPath: compiled.deckPath, slides: compiled.slides, outDir });
      for (const g of results) if (g.gif) gifs[g.id] = g.gif;
      const n = Object.keys(gifs).length;
      if (n) process.stderr.write(`  captured ${n} motion preview${n === 1 ? '' : 's'} (gif) in ${((Date.now() - before) / 1000).toFixed(1)}s\n`);
      else if (results.some((r) => r.note)) process.stderr.write(`  motion preview skipped: ${results.find((r) => r.note)!.note}\n`);
    }
    const sheet = writeContactSheet(join(outDir, 'contact-sheet.html'), rendered, `slides — ${id ?? basename(projectRoot())}`, gifs);
    process.stderr.write(`\n  ${rendered.length} slides rendered\n`);
    for (const r of rendered) {
      const m = r.measurement;
      process.stderr.write(`    ${r.id.padEnd(18)} ${m ? `${m.mode}, ${m.words} words` : 'unmeasured'}\n`);
    }
    process.stderr.write(`\n  contact sheet: ${sheet}\n`);
    process.stderr.write('  Show this to the user BEFORE any voice or recording. Ask what to change.\n\n');
  }

  return finish(problems, opts.json);
}

async function deriveTokens(baseUrl: string): Promise<number> {
  const loaded = loadConfig();
  // The extraction needs a real page of the real app, so it boots the same way
  // everything else does. A splash screen yields nothing usable, which is
  // reported rather than silently falling back.
  const stub = {
    schemaVersion: 1 as const, id: 'tokens', feature: 'token extraction',
    opening: { kicker: '', title: '', subtitle: '', disclaimer: '', narration: '.' },
    scenes: [{ id: 'root', narration: '.', steps: [{ do: 'goto' as const, path: '/' }] }],
    closing: { title: '', subtitle: '', narration: '.' },
  };
  const session = await boot({ story: stub, config: loaded.config, record: false, skipAsserts: true });
  if (!session.page) { printDiagnostics(session.diagnostics); return 1; }
  try {
    const { tokens, diagnostics } = await extractTokens(session.page);
    if (diagnostics.length) printDiagnostics(diagnostics);
    if (!tokens) return 1;
    const path = writeProjectTokens(tokens);
    process.stderr.write(`\n  extracted from ${baseUrl}:\n`);
    for (const line of summarise(tokens)) process.stderr.write(`    ${line}\n`);
    process.stderr.write(`\n  wrote ${path}\n`);
    process.stderr.write('  Show these six colours and the font to the user and ask for a yes.\n\n');
    return 0;
  } finally {
    await session.close();
  }
}

function finish(problems: Diagnostics, json: boolean): number {
  if (json) {
    process.stdout.write(JSON.stringify({ ok: problems.ok, diagnostics: problems.toJSON() }, null, 2) + '\n');
  } else if (problems.length) {
    printDiagnostics(problems.all);
    process.stderr.write(`\n  ${problems.errors.length} errors, ${problems.warnings.length} warnings\n`);
  }
  return problems.ok ? 0 : 1;
}
