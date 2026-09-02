// Optionally start the application before filming it, and stop it afterwards
// (P3). This is what lets one command film a Django project, a Rails project or
// a compose stack without an operator babysitting a second terminal.
//
// SP1 — `runner.start` is arbitrary code execution. A rushes.config.json in a
// cloned repository can name any shell command, so running `rushes build` on
// someone else's project would otherwise be remote code execution by design.
//
// Therefore: never auto-run. Print the exact command, its working directory and
// the config's sha256, and require an explicit confirmation recorded in
// .rushes/consent.json KEYED BY THAT SHA256. Any edit to the config invalidates
// the consent. Refuse entirely when stdin is not a TTY, or under
// --non-interactive.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { freemem } from 'node:os';
import type { RunnerConfig } from '../projectConfig.ts';
import { projectRoot, statePaths } from '../paths.ts';
import { THRESHOLDS } from '../config.ts';
import { type Diagnostic, diag } from '../diagnostics.ts';

export function configSha256(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

interface ConsentFile { [sha: string]: { command: string; cwd: string; grantedAt: string } }

function readConsent(): ConsentFile {
  const p = statePaths().consent;
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')) as ConsentFile; } catch { return {}; }
}

function writeConsent(c: ConsentFile): void {
  const p = statePaths().consent;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(c, null, 2));
}

export function hasConsent(sha: string): boolean {
  return !!readConsent()[sha];
}

export function grantConsent(sha: string, runner: RunnerConfig): void {
  const c = readConsent();
  c[sha] = { command: runner.start, cwd: runner.cwd ?? '.', grantedAt: new Date().toISOString() };
  writeConsent(c);
}

/** Ask once, print everything, and record the answer against the config hash. */
export async function requestConsent(runner: RunnerConfig, sha: string, interactive: boolean): Promise<Diagnostic | null> {
  if (hasConsent(sha)) return null;
  const refusal = diag('runner/consent-required', 'error',
    'the project config names a shell command to start the app, and it has not been approved',
    { command: runner.start, cwd: runner.cwd ?? '.', configSha256: sha },
    { note: 'any edit to rushes.config.json invalidates a previous approval' },
    ['start the app yourself and re-run without the runner block',
     'run `rushes doctor --approve-runner` in an interactive terminal to approve this exact command']);
  if (!interactive || !process.stdin.isTTY) return refusal;

  process.stderr.write('\n── the project config wants to run a command ─────────────\n');
  process.stderr.write(`  command:  ${runner.start}\n`);
  process.stderr.write(`  cwd:      ${isAbsolute(runner.cwd ?? '.') ? runner.cwd : join(projectRoot(), runner.cwd ?? '.')}\n`);
  process.stderr.write(`  config:   sha256 ${sha}\n`);
  process.stderr.write('─────────────────────────────────────────────────────────\n');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = (await rl.question('Run it? Type "yes" to approve this exact command: ')).trim().toLowerCase();
  rl.close();
  if (answer !== 'yes') return refusal;
  grantConsent(sha, runner);
  return null;
}

export interface RunningApp {
  stop(): Promise<void>;
  diagnostics: Diagnostic[];
}

async function probeHttp(url: string, status: number): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: 'manual' });
    return res.status === status;
  } catch {
    return false;
  }
}

export async function startApp(
  runner: RunnerConfig,
  configRaw: string,
  interactive: boolean,
): Promise<RunningApp> {
  const sha = configSha256(configRaw);
  const refusal = await requestConsent(runner, sha, interactive);
  if (refusal) return { diagnostics: [refusal], async stop() { /* nothing started */ } };

  const cwd = isAbsolute(runner.cwd ?? '.') ? runner.cwd! : join(projectRoot(), runner.cwd ?? '.');
  // `detached` puts the command in its OWN PROCESS GROUP, which is the only way
  // to stop it again. The command runs through a shell, so the child is
  // `/bin/sh -c "..."` and the actual server is its grandchild: signalling the
  // child killed the shell and left the server reparented and holding the port.
  // A later run then binds nothing, or films a stale instance of the app from a
  // previous checkout with nothing saying so.
  const child: ChildProcess = spawn(runner.start, {
    cwd, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout?.on('data', (b: Buffer) => { log += b.toString(); });
  child.stderr?.on('data', (b: Buffer) => { log += b.toString(); });

  const timeout = runner.timeoutMs ?? 60_000;
  const started = Date.now();
  const ready = runner.readyWhen;
  let isReady = false;

  while (Date.now() - started < timeout) {
    if (child.exitCode !== null) {
      return {
        diagnostics: [diag('runner/start-failed', 'error',
          `the start command exited with code ${child.exitCode} before becoming ready`,
          { command: runner.start }, { tail: log.slice(-800) },
          ['run the command by hand and read the error', 'correct runner.cwd'])],
        async stop() { /* already gone */ },
      };
    }
    if (ready.http) isReady = await probeHttp(ready.http, ready.status ?? 200);
    else if (ready.log) isReady = new RegExp(ready.log).test(log);
    else isReady = true;
    if (isReady) break;
    await new Promise((r) => setTimeout(r, 400));
  }

  const stop = async () => {
    if (runner.stopAfter === false) return;
    const pid = child.pid;
    if (pid == null) return;
    // Negative pid signals the whole group: the shell AND whatever it started.
    const signalGroup = (sig: NodeJS.Signals) => {
      try { process.kill(-pid, sig); } catch { /* already gone */ }
    };
    signalGroup('SIGTERM');
    for (let i = 0; i < 16 && child.exitCode === null; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (child.exitCode === null) signalGroup('SIGKILL');
    // Never leave a group alive because the leader happened to exit first.
    try { process.kill(-pid, 0); signalGroup('SIGKILL'); } catch { /* the group is gone */ }
  };

  if (!isReady) {
    await stop();
    return {
      diagnostics: [diag('runner/never-ready', 'error',
        `readyWhen never became true within ${timeout} ms`,
        { command: runner.start }, { readyWhen: ready, tail: log.slice(-800) },
        ['raise runner.timeoutMs', 'correct the readiness probe', 'start the app yourself'])],
      stop,
    };
  }

  return { diagnostics: [], stop };
}

/**
 * CF4 — a 1080p headless browser and an ffmpeg encode draw on the same host RAM
 * as whatever else the machine is running. On the monorepo this tool came from,
 * that is a scan admission ledger that refuses work when memory is short: a
 * recording can push a legitimate job into refusal, and a job admitted
 * mid-recording can starve the encoder into dropped frames that then present as
 * a defect in the video.
 */
export function memoryFloorDiagnostic(floorMb = THRESHOLDS.freeMemoryFloorMb): Diagnostic | null {
  const freeMb = Math.round(freemem() / 1e6);
  if (freeMb >= floorMb) return null;
  return diag('runner/insufficient-memory', 'error',
    `${freeMb} MB free, below the ${floorMb} MB floor for a 1080p recording`,
    {}, { freeMb, floorMb },
    ['close what else is running', 'record at a lower resolution',
     'pass --allow-low-memory to record anyway and accept dropped frames']);
}

/** Used by `doctor` and by `build`'s pre-flight report. */
export function freeMemoryMb(): number { return Math.round(freemem() / 1e6); }
