// One place that answers "what does this tool assume about the operating
// system". Everything OS-dependent lives here, so a reader can check the whole
// surface in one file rather than discovering it as a failure on someone else's
// machine.
//
// The rule this module exists to enforce: the engine, the checker, the mux and
// the slide system are platform-neutral by construction, and the only places
// that are not are the four seams where the code leaves Node for the OS —
// finding a binary, spawning a shell, stopping a process tree, and asking how
// much memory is actually available. Each of those is answered once, here.

import { execFileSync, spawnSync } from 'node:child_process';
import { freemem, totalmem, platform } from 'node:os';

export const IS_WINDOWS = platform() === 'win32';
export const IS_MAC = platform() === 'darwin';
export const IS_LINUX = platform() === 'linux';

/**
 * Whether the platform's DEFAULT filesystem folds case.
 *
 * It is a property of the filesystem rather than of the OS — a case-sensitive
 * volume can be mounted on macOS — but the default is what a path check has to
 * agree with, and being wrong in this direction only ever refuses a legitimate
 * path rather than admitting an illegitimate one.
 */
export const CASE_INSENSITIVE_FS = IS_WINDOWS || IS_MAC;

/**
 * The platforms this is tested on. `doctor` reports anything else as unavailable
 * rather than as broken: the code may well work there, but nothing measured it,
 * and reporting an untested platform as `ok` is the same overclaim the rest of
 * the tool refuses to make.
 */
export const SUPPORTED_PLATFORMS = ['linux', 'macos', 'windows'] as const;

/** A short name for the platform, for `doctor` and for diagnostics. */
export function platformLabel(): string {
  if (IS_WINDOWS) return 'windows';
  if (IS_MAC) return 'macos';
  if (IS_LINUX) return 'linux';
  return platform();
}

/**
 * Where `bin` is on PATH, or null.
 *
 * `which` does not exist on Windows, where the equivalent is `where` — and
 * `where` prints EVERY match, one per line, so only the first is the one that
 * would actually run. Five call sites used a bare `which`, which meant that on
 * Windows the browser, ffmpeg and ffprobe were all reported absent and the
 * frame-evidence stage reported `skipped` for a tool that was installed.
 */
export function which(bin: string): string | null {
  const finder = IS_WINDOWS ? 'where' : 'which';
  try {
    return firstPathLine(execFileSync(finder, [bin], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }));
  } catch {
    return null;
  }
}

/**
 * The first usable line of a lookup's output.
 *
 * Pure, and exported, because the behaviour it encodes is not obvious and is
 * unreachable from a test on any other platform: `where` prints EVERY match on
 * PATH, one per line with CRLF endings, and only the first is the one that would
 * actually run. `which` prints one. Both go through here so the answer means the
 * same thing on both.
 */
export function firstPathLine(out: string): string | null {
  return String(out).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null;
}

/** True when `bin` is runnable from PATH. */
export function hasBinary(bin: string): boolean {
  return which(bin) !== null;
}

/**
 * Run a command string through the platform's own shell.
 *
 * `sh -c` was hardcoded, which is the one thing `rushes setup` needs in order to
 * install the browser — so on Windows the command that exists to set the tool up
 * could not run. `shell: true` resolves to `cmd.exe /d /s /c` on Windows and
 * `/bin/sh -c` everywhere else, which is exactly the same contract.
 */
export function runShell(command: string): { ok: boolean; output: string } {
  const res = spawnSync(command, {
    shell: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = String(res.stdout ?? '') + String(res.stderr ?? '');
  return { ok: res.status === 0, output };
}

/**
 * Options for spawning a long-running child whose WHOLE TREE must be stoppable.
 *
 * On POSIX `detached` puts the command in its own process group, which is what
 * makes `kill(-pid)` reach the grandchild the shell started. Windows has no
 * process groups; `detached` there means "own console", which is why it is
 * paired with `windowsHide` and why stopping is a different call entirely.
 */
export function detachedSpawnOptions(): { detached: boolean; windowsHide: boolean } {
  return { detached: !IS_WINDOWS, windowsHide: true };
}

/**
 * Stop a process AND everything it started.
 *
 * The POSIX path signals the negative pid, which is the process GROUP: the
 * command runs through a shell, so the child is `/bin/sh -c "..."` and the
 * actual server is its grandchild. Signalling the child alone kills the shell
 * and leaves the server reparented and still holding the port.
 *
 * Windows has no equivalent, and `process.kill(-pid)` throws there. `taskkill
 * /T` walks the tree by parent id, which is the same intent expressed in the
 * only vocabulary the platform has. `/F` is the forceful half, kept separate so
 * the caller can still try the polite one first.
 */
export function killTree(pid: number, force: boolean): void {
  if (IS_WINDOWS) {
    const args = ['/pid', String(pid), '/T', ...(force ? ['/F'] : [])];
    spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    /* already gone */
  }
}

/** True when the process group / tree is gone. Best-effort on both platforms. */
export function treeIsGone(pid: number): boolean {
  if (IS_WINDOWS) {
    const res = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    return !String(res.stdout ?? '').includes(String(pid));
  }
  try { process.kill(-pid, 0); return false; } catch { return true; }
}

/**
 * Memory a 1080p recording could actually use, in MB.
 *
 * `os.freemem()` means different things on different kernels, and on one of
 * them it means something that makes the floor useless. On Linux and Windows it
 * is close enough to "available". On macOS it counts ONLY genuinely free pages
 * and excludes the inactive, speculative and purgeable pools that the kernel
 * reclaims on demand — so a 32 GB Mac under ordinary use reports a few hundred
 * megabytes free, and the recording refuses to start on a machine with tens of
 * gigabytes available.
 *
 * `vm_stat` reports those pools separately, so on macOS they are added back.
 * A parse failure falls back to `freemem()`, which is conservative in the
 * direction of refusing rather than of pretending.
 */
export function availableMemoryMb(): number {
  if (!IS_MAC) return Math.round(freemem() / 1e6);

  try {
    const parsed = parseVmStat(execFileSync('vm_stat', [], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }));
    return parsed ?? Math.round(freemem() / 1e6);
  } catch {
    return Math.round(freemem() / 1e6);
  }
}

/**
 * Reclaimable memory in MB from `vm_stat` output, or null when it cannot be read.
 *
 * Pure and exported so the macOS branch is testable from any platform. It is the
 * one piece of this module that cannot be exercised where most of the
 * development happens, and an untested regex deciding whether a recording is
 * allowed to start is exactly the kind of thing that fails on someone else's
 * machine and nowhere else.
 *
 * `inactive`, `speculative` and `purgeable` are counted alongside `free` because
 * the kernel hands all four to a new allocation without swapping. Counting only
 * `free` — which is what `os.freemem()` does — is what made a 32 GB Mac report a
 * few hundred megabytes.
 */
export function parseVmStat(out: string): number | null {
  const pageSize = Number(out.match(/page size of (\d+) bytes/)?.[1] ?? 4096);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
  const pages = (label: string): number => {
    const m = out.match(new RegExp(`^Pages ${label}:\\s+(\\d+)`, 'm'));
    return m ? Number(m[1]) : 0;
  };
  const reclaimable = pages('free') + pages('inactive') + pages('speculative') + pages('purgeable');
  if (!reclaimable) return null;
  return Math.round((reclaimable * pageSize) / 1e6);
}

/** Total physical memory in MB, for the diagnostic's context. */
export function totalMemoryMb(): number {
  return Math.round(totalmem() / 1e6);
}

/**
 * How to set an environment variable, in the shell the reader is actually
 * looking at. Printed by `setup` and `doctor`, so the instruction can be pasted
 * rather than translated.
 */
export function exportLine(name: string, value: string): string {
  return IS_WINDOWS ? `$env:${name}="${value}"` : `export ${name}=${value}`;
}

/** How to open a finished file in the platform's default player. */
export function openCommand(path: string): string {
  if (IS_WINDOWS) return `start "" "${path}"`;
  if (IS_MAC) return `open "${path}"`;
  return `xdg-open "${path}"`;
}
