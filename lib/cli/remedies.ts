// What to do about a missing dependency, and which half of it a tool is allowed
// to do for you.
//
// The line is `sudo`. A browser engine can be fetched into a cache directory in
// userland, so `doctor --fix` fetches it. ffmpeg is a system package, and a tool
// that runs `sudo apt install` on your behalf because you typed an unrelated
// command is doing the same thing `runner.start` was gated for: executing
// privileged commands you did not read. So that half is PRINTED, exactly, for
// the package manager you actually have, and you run it.

import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';

export type PackageManager = 'apt' | 'dnf' | 'pacman' | 'zypper' | 'apk' | 'brew' | 'unknown';

function has(bin: string): boolean {
  try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; }
}

/** The package manager this machine actually has, not the one its family usually has. */
export function detectPackageManager(): PackageManager {
  if (platform() === 'darwin') return has('brew') ? 'brew' : 'unknown';
  for (const [bin, name] of [['apt-get', 'apt'], ['dnf', 'dnf'], ['pacman', 'pacman'],
                             ['zypper', 'zypper'], ['apk', 'apk']] as const) {
    if (has(bin)) return name;
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
  unknown: 'install ffmpeg with your system package manager',
};

export function ffmpegRemedy(pm = detectPackageManager()): Remedy {
  return {
    command: FFMPEG[pm],
    // Homebrew installs into a prefix the user owns, so it is the one package
    // manager here that does not need privileges.
    needsSudo: pm !== 'brew' && pm !== 'unknown',
    note: pm === 'unknown' ? 'no known package manager was found on this machine' : undefined,
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
export function browserDepsRemedy(pm = detectPackageManager()): Remedy | null {
  if (platform() !== 'linux') return null;
  return {
    command: 'npx --yes playwright install-deps chromium',
    needsSudo: true,
    note: 'only needed if the browser fails to start with a missing-library error',
  };
}

export function runRemedy(remedy: Remedy): { ok: boolean; output: string } {
  try {
    const out = execFileSync('sh', ['-c', remedy.command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, output: String(out ?? '') };
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    return { ok: false, output: String(err.stderr ?? err.stdout ?? err.message ?? '') };
  }
}
