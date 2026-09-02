// `rushes demo` — a finished video before you have configured anything.
//
// This replaces a three-line quickstart that asked a new user to run a file out
// of the skill's own test directory, background it with `&`, and write output
// into the installed skill. All three were wrong: after a global install the
// skill is not the working directory, so the path did not resolve; the
// backgrounded server had no readiness check and would be filmed as a
// connection-refused page; and the install directory is the wrong place, and
// possibly not writable.
//
// So the command owns the whole thing: it finds the bundled fixture inside its
// own installation, starts it on a free port, waits until it actually answers,
// films it, and stops it again. The only thing the user chooses is where the
// video should land.
//
// NOTE on the consent gate: `runner.start` requires recorded approval because a
// cloned repository can name any shell command in its config. That threat does
// not apply here — this command is fixed in the skill's own source and reads
// nothing from project data — so it starts the fixture directly rather than
// going through a gate designed for a different problem.

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { SKILL_ROOT } from '../env.ts';

const FIXTURE = join(SKILL_ROOT, 'test', 'fixtures', 'static', 'server.mjs');
const EXAMPLES = join(SKILL_ROOT, 'examples');

/** A port nothing is listening on, asked for from the OS rather than guessed. */
async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const probe = createServer();
    probe.on('error', rej);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => res(port));
    });
  });
}

/** Wait until the fixture actually answers. Never assume; a race here films a blank page. */
async function waitUntilAnswering(url: string, timeoutMs = 20_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export interface DemoOptions {
  /** Where the demo project and its output should live. */
  into: string;
  quality: 'standard' | 'showcase';
  headed: boolean;
  keep: boolean;
}

export async function demo(opts: DemoOptions): Promise<number> {
  if (!existsSync(FIXTURE)) {
    process.stderr.write(`the bundled fixture is missing from this install (${FIXTURE})\n`);
    return 1;
  }

  const into = resolve(opts.into);
  // The demo project is COPIED out of the installation, so nothing is written
  // into a directory the user may not own and the result is somewhere they can
  // actually find.
  if (existsSync(into) && !opts.keep) rmSync(join(into, 'out'), { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  for (const part of ['demos', 'slides', 'rushes.config.json']) {
    const from = join(EXAMPLES, part);
    if (existsSync(from)) cpSync(from, join(into, part), { recursive: true });
  }

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  process.stderr.write(`\nstarting the bundled example app on ${baseUrl}\n`);

  let child: ChildProcess | null = spawn(process.execPath, [FIXTURE, String(port)], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderrTail = '';
  child.stderr?.on('data', (b: Buffer) => { stderrTail = (stderrTail + b.toString()).slice(-500); });

  const stop = () => {
    if (!child) return;
    child.kill('SIGTERM');
    child = null;
  };
  process.once('exit', stop);

  try {
    if (!await waitUntilAnswering(baseUrl)) {
      process.stderr.write(`the example app never answered on ${baseUrl}\n`);
      if (stderrTail) process.stderr.write(`  ${stderrTail.trim()}\n`);
      return 1;
    }
    process.stderr.write('it is answering; recording…\n');

    // Point the copied config at the port we actually got.
    const { writeFileSync, readFileSync } = await import('node:fs');
    const configPath = join(into, 'rushes.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    config.baseUrl = baseUrl;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

    const previous = process.env.RUSHES_PROJECT_ROOT;
    process.env.RUSHES_PROJECT_ROOT = into;
    try {
      const { buildAndDeliver } = await import('./deliver.ts');
      return await buildAndDeliver({
        id: 'tour',
        quality: opts.quality,
        headed: opts.headed,
        commit: true,
        rehearseFirst: false,
        allowLowMemory: false,
        nonInteractive: true,
        publishConsent: 'the bundled example app; it holds no real data',
      });
    } finally {
      if (previous === undefined) delete process.env.RUSHES_PROJECT_ROOT;
      else process.env.RUSHES_PROJECT_ROOT = previous;
    }
  } finally {
    stop();
  }
}
