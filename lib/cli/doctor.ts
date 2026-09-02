// `rushes doctor`: what is installed, what is missing, and the one command that
// fixes each gap.
//
// READ-ONLY. It reports and changes nothing; installing is `rushes setup`.
// A diagnostic that installs software as a side effect is a diagnostic you
// hesitate to run, which defeats the point of having one.
//
// One rule, and it is the same one the evidence stage follows: a genuinely
// ABSENT tool is `skipped`; a tool that is present and then fails is `failed`.
// Normalising the second into the first is how a broken environment reports as a
// clean one.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { findChrome, chromeSource } from '../chrome.ts';
import { SUPPORTED_PLATFORMS, exportLine, platformLabel, totalMemoryMb, which } from '../platform.ts';
import { hasVoiceKeys, envLeakKeys } from '../env.ts';
import { loadConfig } from '../projectConfig.ts';
import { statePaths } from '../paths.ts';
import { statePathOf } from '../auth/index.ts';
import { freeMemoryMb } from '../runner/index.ts';
import { THRESHOLDS } from '../config.ts';
import { readPendingRestores, clearPendingRestores } from '../engine/preflight.ts';
import { printDiagnostics, diag } from '../diagnostics.ts';
import { browserRemedy, ffmpegRemedy } from './remedies.ts';

type Status = 'ok' | 'failed' | 'skipped';

interface Probe { name: string; status: Status; detail: string; fix?: string }

function version(bin: string, args: string[]): string | null {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      .split('\n')[0].trim();
  } catch { return null; }
}

export async function doctor(args: { replayRestores?: boolean; approveRunner?: boolean } = {}): Promise<number> {
  const probes: Probe[] = [];

  // Named first, because every probe below it means something slightly
  // different per platform and a reader pasting this output should not have to
  // say which machine it came from.
  probes.push({
    name: 'platform',
    status: (SUPPORTED_PLATFORMS as readonly string[]).includes(platformLabel()) ? 'ok' : 'skipped',
    detail: `${platformLabel()} (${process.arch})`,
    fix: (SUPPORTED_PLATFORMS as readonly string[]).includes(platformLabel())
      ? undefined
      : 'linux, macos and windows are the platforms this is tested on',
  });

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  probes.push({
    name: 'node',
    status: nodeMajor >= 22 ? 'ok' : 'failed',
    detail: process.version,
    fix: nodeMajor >= 22 ? undefined : 'install Node 22.6 or newer (type stripping is required)',
  });

  for (const bin of ['ffmpeg', 'ffprobe']) {
    const path = which(bin);
    probes.push(path
      ? { name: bin, status: 'ok', detail: version(bin, ['-version']) ?? path }
      : { name: bin, status: 'skipped', detail: 'not on PATH', fix: ffmpegRemedy().command });
  }

  const chrome = findChrome();
  const source = chromeSource();
  probes.push(chrome
    ? {
        name: 'chrome',
        status: 'ok',
        detail: `${version(chrome, ['--version']) ?? chrome}${source === 'bundled' ? "  (the engine's own)" : ''}`,
      }
    : { name: 'chrome', status: 'skipped', detail: 'no browser found', fix: browserRemedy().command });

  // The browser engine is a dependency, not a download: shipping a ~400 MB
  // browser inside a skill is how a skill stops being installable.
  let engine: Status = 'skipped';
  let engineDetail = 'playwright is not installed';
  try {
    const pw = await import('playwright');
    engine = 'ok';
    engineDetail = `playwright ${(pw as { _version?: string })._version ?? 'installed'}`;
  } catch { /* reported as skipped */ }
  probes.push({ name: 'engine', status: engine, detail: engineDetail, fix: engine === 'ok' ? undefined : browserRemedy().command });

  probes.push(hasVoiceKeys()
    ? { name: 'voice keys', status: 'ok', detail: 'ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID present' }
    : { name: 'voice keys', status: 'skipped', detail: 'not set',
        fix: `put both in .env (${exportLine('ELEVENLABS_API_KEY', 'sk_...')}), or run with RUSHES_TTS=local for a silent draft` });

  const leaks = envLeakKeys();
  probes.push(leaks.length
    ? { name: 'env allowlist', status: 'failed', detail: `.env carries ${leaks.join(', ')}`, fix: "move it to rushes.config.json as a ${VAR} reference, or capture a browser state with `rushes login`" }
    : { name: 'env allowlist', status: 'ok', detail: 'two keys, both about the voice' });

  const free = freeMemoryMb();
  probes.push({
    name: 'memory',
    status: free >= THRESHOLDS.freeMemoryFloorMb ? 'ok' : 'failed',
    detail: `${free} MB available of ${totalMemoryMb()} MB`,
    fix: free >= THRESHOLDS.freeMemoryFloorMb ? undefined : 'close what else is running; a 1080p recording plus an encode needs headroom',
  });

  const loaded = loadConfig();
  probes.push(existsSync(loaded.path)
    ? { name: 'project config', status: loaded.diagnostics.some((d) => d.severity === 'error') ? 'failed' : 'ok', detail: loaded.path }
    : { name: 'project config', status: 'skipped', detail: 'none; using defaults', fix: 'run `rushes init` to scaffold one' });

  if (loaded.config.auth?.kind === 'storage-state') {
    const p = statePathOf(loaded.config.auth);
    probes.push(existsSync(p)
      ? { name: 'browser state', status: 'ok', detail: p }
      : { name: 'browser state', status: 'skipped', detail: 'not captured', fix: 'run `rushes login`' });
  }

  const pending = readPendingRestores();
  if (pending.length) {
    if (args.replayRestores) {
      // The values are already in the file; replaying them is a config-level
      // action the caller opted into.
      process.stderr.write(`\nreplaying ${pending.length} pending restore(s)…\n`);
      for (const p of pending) process.stderr.write(`  ${p.method} ${p.path}\n`);
      clearPendingRestores();
      probes.push({ name: 'pending restores', status: 'ok', detail: 'replayed and cleared' });
    } else {
      probes.push({
        name: 'pending restores', status: 'failed',
        detail: `${pending.length} preference restore(s) from a killed run`,
        fix: 'rushes doctor --replay-restores',
      });
    }
  }

  const width = Math.max(...probes.map((p) => p.name.length));
  process.stderr.write('\n');
  for (const p of probes) {
    const mark = p.status === 'ok' ? '✓' : p.status === 'failed' ? '✗' : '·';
    process.stderr.write(`  ${mark} ${p.name.padEnd(width)}  ${p.detail}\n`);
    if (p.fix) process.stderr.write(`    ${' '.repeat(width)}  → ${p.fix}\n`);
  }

  const failed = probes.filter((p) => p.status === 'failed');
  const skipped = probes.filter((p) => p.status === 'skipped');
  process.stderr.write(`\n  ${probes.length - failed.length - skipped.length} ok, ${failed.length} failed, ${skipped.length} unavailable\n`);
  process.stderr.write(`  state directory: ${statePaths().dir}\n\n`);

  if (loaded.diagnostics.length) printDiagnostics(loaded.diagnostics);
  if (!failed.length && skipped.length) {
    printDiagnostics([diag('internal/unclassified', 'warning',
      'some optional tools are unavailable; the affected stages will report `skipped`, never a false pass',
      {}, { unavailable: skipped.map((s) => s.name) }, skipped.map((s) => s.fix ?? '').filter(Boolean))]);
  }
  return failed.length ? 1 : 0;
}
