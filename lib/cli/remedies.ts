// What to do about a missing dependency, and which half of it a tool is allowed
// to do for you.
//
// The line is `sudo`. A browser engine can be fetched into a cache directory in
// userland, so `doctor --fix` fetches it. ffmpeg is a system package, and a tool
// that runs `sudo apt install` on your behalf because you typed an unrelated
// command is doing the same thing `runner.start` was gated for: executing
// privileged commands you did not read. So that half is PRINTED, exactly, for
// the package manager you actually have, and you run it.

import { IS_LINUX, IS_MAC, IS_WINDOWS, hasBinary, runShell } from '../platform.ts';

export type PackageManager =
  | 'apt' | 'dnf' | 'pacman' | 'zypper' | 'apk' | 'brew' | 'winget' | 'choco' | 'scoop' | 'unknown';

/** The package manager this machine actually has, not the one its family usually has. */
export function detectPackageManager(): PackageManager {
  if (IS_MAC) return hasBinary('brew') ? 'brew' : 'unknown';
  if (IS_WINDOWS) {
    for (const [bin, name] of [['winget', 'winget'], ['choco', 'choco'], ['scoop', 'scoop']] as const) {
      if (hasBinary(bin)) return name;
    }
    return 'unknown';
  }
  for (const [bin, name] of [['apt-get', 'apt'], ['dnf', 'dnf'], ['pacman', 'pacman'],
                             ['zypper', 'zypper'], ['apk', 'apk']] as const) {
    if (hasBinary(bin)) return name;
  }
  return 'unknown';
}

export interface Remedy {
  /** The exact command, for the package manager that is actually installed. */
  command: string;
  /** True when running it needs privileges, which is why this tool will not. */
  needsSudo: boolean;
  /** A one-line reason, shown when the command cannot be run automatically. */
  note?: string;
}

const FFMPEG: Record<PackageManager, string> = {
  apt: 'sudo apt install -y ffmpeg',
  dnf: 'sudo dnf install -y ffmpeg',
  pacman: 'sudo pacman -S --noconfirm ffmpeg',
  zypper: 'sudo zypper install -y ffmpeg',
  apk: 'sudo apk add ffmpeg',
  brew: 'brew install ffmpeg',
  winget: 'winget install --id Gyan.FFmpeg -e',
  choco: 'choco install ffmpeg -y',
  scoop: 'scoop install ffmpeg',
  unknown: 'install ffmpeg with your system package manager',
};

/**
 * Package managers that install into a prefix the invoking user already owns, so
 * the command needs no privileges. Homebrew and scoop do; winget and choco write
 * to machine-wide locations and want an elevated shell.
 */
const UNPRIVILEGED = new Set<PackageManager>(['brew', 'scoop', 'unknown']);

export function ffmpegRemedy(pm = detectPackageManager()): Remedy {
  return {
    command: FFMPEG[pm],
    needsSudo: !UNPRIVILEGED.has(pm),
    note: pm === 'unknown'
      ? (IS_WINDOWS
        ? 'no winget, choco or scoop was found; install ffmpeg and put it on PATH'
        : 'no known package manager was found on this machine')
      : undefined,
  };
}

/**
 * The browser. Fetched into a cache directory, so this one CAN be run for you.
 *
 * Note it does not contradict "never download a browser at run time": that rule
 * is about a recording quietly pulling 400 MB mid-build. This is an explicit,
 * named setup command that you asked for.
 */
export function browserRemedy(): Remedy {
  return { command: 'npx --yes playwright install chromium', needsSudo: false };
}

/** On Linux the engine also wants shared libraries, and those do need privileges. */
export function browserDepsRemedy(_pm = detectPackageManager()): Remedy | null {
  if (!IS_LINUX) return null;
  return {
    command: 'npx --yes playwright install-deps chromium',
    needsSudo: true,
    note: 'only needed if the browser fails to start with a missing-library error',
  };
}

/**
 * Run a remedy through the platform's own shell.
 *
 * This used to hardcode `sh -c`, which meant the one command that exists to set
 * the tool up could not run on Windows. `runShell` resolves to `cmd.exe` there
 * and to `/bin/sh` everywhere else, with the same contract.
 */
export function runRemedy(remedy: Remedy): { ok: boolean; output: string } {
  return runShell(remedy.command);
}
