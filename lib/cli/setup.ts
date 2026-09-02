// `rushes setup` — check what is needed, install what can be installed, and
// print the one thing that needs you.
//
// It is deliberately separate from `doctor`, and the split is the usual one:
// `doctor` reports and changes nothing, `setup` changes things. Running a
// diagnostic should never install software as a side effect, which is why this
// is its own verb rather than a flag on that one.
//
// The line it will not cross is `sudo`. A browser engine goes into a cache
// directory in your home, so setup fetches it. ffmpeg is a system package, and a
// tool that runs a privileged command because you typed an unrelated one is
// executing things you never read. That half is printed, exactly, for the
// package manager you actually have.

import { execFileSync } from 'node:child_process';
import { findChrome, chromeSource, resetChromeCache } from '../chrome.ts';
import { hasFfmpeg } from '../compose/ffprobe.ts';
import { browserRemedy, browserDepsRemedy, ffmpegRemedy, detectPackageManager, runRemedy } from './remedies.ts';
import { hasVoiceKeys } from '../env.ts';

interface Need {
  name: string;
  present: boolean;
  detail: string;
}

function version(bin: string, args: string[]): string | null {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0].trim();
  } catch {
    return null;
  }
}

function survey(): Need[] {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const chrome = findChrome();
  return [
    { name: 'node', present: nodeMajor >= 22, detail: process.version },
    { name: 'ffmpeg', present: hasFfmpeg(), detail: hasFfmpeg() ? (version('ffmpeg', ['-version']) ?? 'present').slice(0, 44) : 'not found' },
    {
      name: 'browser',
      present: !!chrome,
      detail: chrome ? `${(version(chrome, ['--version']) ?? chrome).slice(0, 40)}${chromeSource() === 'bundled' ? "  (the engine's own)" : ''}` : 'not found',
    },
  ];
}

function report(needs: Need[]): void {
  const width = Math.max(...needs.map((n) => n.name.length));
  for (const n of needs) {
    process.stderr.write(`    ${n.present ? '✓' : '·'} ${n.name.padEnd(width)}  ${n.detail}\n`);
  }
}

export async function setup(): Promise<number> {
  process.stderr.write('\n  checking what Rushes needs\n');
  let needs = survey();
  report(needs);

  const missing = (name: string) => !needs.find((n) => n.name === name)?.present;

  if (missing('node')) {
    // Nothing else is worth doing: the CLI itself will not run.
    process.stderr.write('\n  Node 22.6 or newer is required, and this cannot be installed for you.\n');
    process.stderr.write('  Use nvm, or your system package manager, then run `rushes setup` again.\n\n');
    return 1;
  }

  // --- the half that needs no privileges ------------------------------------
  if (missing('browser')) {
    const remedy = browserRemedy();
    process.stderr.write('\n  installing the browser, into a cache in your home (no privileges needed)\n');
    process.stderr.write(`    ${remedy.command}\n`);
    const res = runRemedy(remedy);
    if (res.ok) {
      process.stderr.write('    ✓ done\n');
      resetChromeCache();
    } else {
      process.stderr.write('    ✗ failed\n');
      for (const line of res.output.split('\n').slice(-6)) {
        if (line.trim()) process.stderr.write(`      ${line}\n`);
      }
      const deps = browserDepsRemedy();
      if (deps) {
        process.stderr.write('\n    if that failed on a missing system library, this needs your privileges:\n');
        process.stderr.write(`      ${deps.command}\n`);
      }
    }
    needs = survey();
  }

  // --- the half that needs you ---------------------------------------------
  if (missing('ffmpeg')) {
    const remedy = ffmpegRemedy(detectPackageManager());
    process.stderr.write('\n  ffmpeg is a system package, so this one is yours to run:\n\n');
    process.stderr.write(`      ${remedy.command}\n\n`);
    process.stderr.write('  Rushes will not run a privileged command on your behalf: you asked it to\n');
    process.stderr.write('  set itself up, which is not the same consent as installing system packages.\n');
    if (remedy.note) process.stderr.write(`  (${remedy.note})\n`);
    process.stderr.write('\n  Then run `rushes setup` again.\n\n');
    return 1;
  }

  // --- everything is present -------------------------------------------------
  process.stderr.write('\n  ✓ everything Rushes needs is installed.\n');

  if (!hasVoiceKeys()) {
    // Not a failure: the pipeline runs without a voice, it just cannot publish.
    process.stderr.write('\n  One optional thing: there is no voice configured. Export two keys from\n');
    process.stderr.write('  elevenlabs.io to narrate for real:\n\n');
    process.stderr.write('      export ELEVENLABS_API_KEY=sk_...\n');
    process.stderr.write('      export ELEVENLABS_VOICE_ID=...\n\n');
    process.stderr.write('  Without them, `RUSHES_TTS=local` produces correctly-timed silent clips.\n');
    process.stderr.write('  Fine for trying it out, never for something you publish.\n');
  }

  process.stderr.write('\n  Try it now, on the bundled example app:\n\n      rushes demo\n\n');
  return 0;
}
