// Cross-platform support, as a test rather than a promise.
//
// This is the same shape as the neutrality suite, and for the same reason. The
// engine, the checker, the mux and the slide system are platform-neutral by
// construction; the only places that are not are the four seams where the code
// leaves Node for the OS — finding a binary, spawning a shell, stopping a
// process tree, and asking how much memory is available. Every one of those is
// answered once, in lib/platform.ts.
//
// So the acceptance test is literal: grep the source for the POSIX-only
// constructs that used to be scattered through it, and find nothing outside the
// one module that is allowed to know about them. A regression is a line, not a
// bug report from someone on a laptop we do not have.
//
// What each forbidden pattern actually broke, before this existed:
//
//   new URL(import.meta.url).pathname   yields "/C:/Users/..." on Windows, so
//                                       SKILL_ROOT pointed nowhere and the
//                                       schemas, the runtime CSS, the embedded
//                                       font and the TTS cache were all
//                                       unreachable.
//   which                               does not exist on Windows, so ffmpeg,
//                                       ffprobe and the browser were reported
//                                       absent even when installed.
//   sh -c                               does not exist on Windows, so `setup` —
//                                       the command whose whole job is to
//                                       install things — could not run.
//   process.kill(-pid)                  process groups are POSIX-only; the call
//                                       throws on Windows and the app under
//                                       test kept the port.
//   `file://${path}`                    wrong separators and a missing slash on
//                                       Windows, and unescaped everywhere.
//   os.freemem()                        on macOS counts only genuinely free
//                                       pages, so the memory floor refused to
//                                       record on a machine with 25 GB spare.

import { test, assert, equal } from './harness.mjs';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The one module allowed to know what operating system this is. */
const PLATFORM_MODULE = join('lib', 'platform.ts');

/** This file names every forbidden construct in order to forbid it. */
const SELF = join('test', 'portability.test.mjs');

const FORBIDDEN = [
  {
    pattern: /new URL\(import\.meta\.url\)\.pathname/,
    name: 'new URL(import.meta.url).pathname',
    instead: 'fileURLToPath(import.meta.url)',
  },
  {
    pattern: /execFileSync\(\s*['"]which['"]|spawnSync\(\s*['"]which['"]/,
    name: "a bare `which`",
    instead: "which() from lib/platform.ts",
  },
  {
    pattern: /execFileSync\(\s*['"]sh['"]|spawnSync\(\s*['"]sh['"]|['"]\/bin\/sh['"]/,
    name: 'a hardcoded `sh`',
    instead: 'runShell() from lib/platform.ts',
  },
  {
    pattern: /process\.kill\(\s*-/,
    name: 'process.kill(-pid), a POSIX process group',
    instead: 'killTree() from lib/platform.ts',
  },
  {
    pattern: /`file:\/\/\$\{/,
    name: 'a concatenated file:// URL',
    instead: 'pathToFileURL(path).href',
  },
  {
    pattern: /\bfreemem\(\)/,
    name: 'os.freemem()',
    instead: 'availableMemoryMb() from lib/platform.ts',
  },
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.git', 'out', 'cache', '.rushes', 'dist'].includes(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/**
 * The file with its comments removed.
 *
 * These rules are about what the code DOES, and every one of the forbidden
 * constructs is also named in a comment somewhere explaining why it is
 * forbidden — including in the module that replaced it. Matching prose would
 * make the honest explanation the thing that fails the test.
 */
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

function sourceFiles() {
  return [
    ...walk(join(root, 'lib')),
    ...walk(join(root, 'bin')),
    ...walk(join(root, 'test')),
    ...walk(join(root, 'scripts')),
  ].filter((f) => ['.ts', '.mjs', '.js'].includes(extname(f)));
}

await test('no POSIX-only construct survives outside lib/platform.ts', () => {
  const hits = [];
  for (const f of sourceFiles()) {
    const rel = relative(root, f);
    if (rel === PLATFORM_MODULE || rel === SELF) continue;
    const text = code(readFileSync(f, 'utf8'));
    for (const rule of FORBIDDEN) {
      if (rule.pattern.test(text)) hits.push(`${rel}: ${rule.name} — use ${rule.instead}`);
    }
  }
  equal(hits, [], 'a platform-coupled construct escaped lib/platform.ts');
});

await test('every OS-dependent decision is exported from one module', async () => {
  const p = await import('../lib/platform.ts');
  for (const name of ['which', 'hasBinary', 'runShell', 'killTree', 'treeIsGone',
                      'availableMemoryMb', 'totalMemoryMb', 'detachedSpawnOptions',
                      'exportLine', 'openCommand', 'platformLabel']) {
    assert(typeof p[name] === 'function', `lib/platform.ts does not export ${name}()`);
  }
  for (const name of ['IS_WINDOWS', 'IS_MAC', 'IS_LINUX', 'CASE_INSENSITIVE_FS', 'SUPPORTED_PLATFORMS']) {
    assert(p[name] !== undefined, `lib/platform.ts does not export ${name}`);
  }
});

await test('the three supported platforms are named, and this is one of them', async () => {
  const { SUPPORTED_PLATFORMS, platformLabel } = await import('../lib/platform.ts');
  equal([...SUPPORTED_PLATFORMS], ['linux', 'macos', 'windows']);
  assert(SUPPORTED_PLATFORMS.includes(platformLabel()),
    `this suite is running on "${platformLabel()}", which is not a supported platform`);
});

await test('which() finds a binary that exists and not one that does not', async () => {
  const { which, hasBinary, IS_WINDOWS } = await import('../lib/platform.ts');
  // `node` is running this test, so it is on PATH by construction.
  const node = which(IS_WINDOWS ? 'node.exe' : 'node') ?? which('node');
  assert(node, 'which() could not find node, which is running this test');
  assert(!hasBinary('a-binary-that-does-not-exist-anywhere'), 'which() invented a binary');
});

await test('available memory is a real number, and not smaller than free memory', async () => {
  const { availableMemoryMb, totalMemoryMb, IS_MAC } = await import('../lib/platform.ts');
  const { freemem } = await import('node:os');
  const available = availableMemoryMb();
  assert(Number.isFinite(available) && available > 0, `availableMemoryMb() returned ${available}`);
  assert(available <= totalMemoryMb() + 1, 'more memory is available than exists');
  // On macOS the reclaimable pools are added back, so it can only be larger.
  // Elsewhere it IS freemem(), so the two agree.
  const free = Math.round(freemem() / 1e6);
  if (IS_MAC) assert(available >= free, 'the macOS probe reported less than freemem()');
  else assert(Math.abs(available - free) <= 1, 'availableMemoryMb() drifted from freemem()');
});

await test('the browser is looked for under names this platform actually uses', async () => {
  const { CHROME_CANDIDATES } = await import('../lib/chrome.ts');
  const { IS_WINDOWS, IS_MAC } = await import('../lib/platform.ts');
  assert(CHROME_CANDIDATES.length > 0, 'no browser candidates at all');
  if (IS_WINDOWS) assert(CHROME_CANDIDATES.some((c) => c.startsWith('chrome')), 'no chrome candidate on windows');
  else if (IS_MAC) assert(CHROME_CANDIDATES.includes('google-chrome'), 'no chrome candidate on macos');
  else assert(CHROME_CANDIDATES.includes('chromium-browser'), 'the linux candidate list changed');
});

await test('a file:// URL for the slide deck round-trips through the path check', async () => {
  const { withinDirectory } = await import('../lib/engine/navigation.ts');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const inside = join(root, 'slides', 'deck.html');
  // The property that matters is that building a URL from a path and reading it
  // back yields the same path, on every separator convention.
  equal(fileURLToPath(pathToFileURL(inside).href), inside);
  assert(withinDirectory(inside, join(root, 'slides')), 'a path inside slides/ was refused');
  assert(!withinDirectory(join(root, 'lib', 'env.ts'), join(root, 'slides')), 'a path outside slides/ was allowed');
});

await test('the path check follows the filesystem on case, and still refuses an escape', async () => {
  const { withinDirectory } = await import('../lib/engine/navigation.ts');
  const { CASE_INSENSITIVE_FS } = await import('../lib/platform.ts');
  const slides = join(root, 'slides');
  const shouted = join(root, 'SLIDES', 'deck.html');
  // Whatever the filesystem says, the answer must match it — and the escape
  // must be refused either way.
  equal(withinDirectory(shouted, slides), CASE_INSENSITIVE_FS);
  assert(!withinDirectory(join(root, 'slides', '..', '..', 'etc', 'passwd'), slides),
    'a traversal out of slides/ was allowed');
});

// Two shapes that are unambiguously a path rather than a URL, a ratio or a
// message: one that ends in a file extension, and one whose first interpolation
// is named like a directory. `${passed}/${total}` is neither, and must not be
// flagged — a test that cries wolf on a fraction is a test people delete.
const PATH_SHAPES = [
  /`\$\{[^`]*?\}\/\$\{[^`]*?\}\.[A-Za-z0-9]{2,5}`/g,
  /`\$\{[A-Za-z_][\w.]*(?:[Dd]ir|[Pp]ath|[Rr]oot)\}\//g,
];

await test('no source file builds a path with a hardcoded separator', () => {
  // `${dir}/${name}` is correct on POSIX and merely tolerated on Windows, which
  // is how it survives review. join() is the version that is true everywhere.
  const hits = [];
  for (const f of sourceFiles()) {
    const rel = relative(root, f);
    if (rel === SELF) continue;
    const text = code(readFileSync(f, 'utf8'));
    for (const shape of PATH_SHAPES) {
      for (const m of text.matchAll(shape)) {
        hits.push(`${rel}:${text.slice(0, m.index).split('\n').length}`);
      }
    }
  }
  equal(hits, [], 'a path was built with a hardcoded "/" instead of join()');
});

await test('every spawn of a long-running child can stop the whole tree', () => {
  // The runner is the only place that starts something outliving the call, and
  // it must go through the two helpers that know how each platform stops a tree.
  const runner = code(readFileSync(join(root, 'lib', 'runner', 'index.ts'), 'utf8'));
  assert(runner.includes('detachedSpawnOptions()'), 'the runner spawns without the platform options');
  assert(runner.includes('killTree('), 'the runner does not use killTree()');
  assert(!/detached:\s*true/.test(runner), 'the runner hardcodes detached:true, which means "own console" on Windows');
});

// ---------------------------------------------------------------------------
// The two branches that cannot run on the platform most of the development
// happens on. Both are pure functions taking measured input, for exactly that
// reason: an untested regex deciding whether a recording may start is the kind
// of fault that appears on someone else's machine and nowhere else.

/** Real `vm_stat` output from a 16 GB Mac under ordinary use. */
const VM_STAT_16GB = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                8213.
Pages active:                            310442.
Pages inactive:                          295118.
Pages speculative:                        13907.
Pages throttled:                              0.
Pages wired down:                        184203.
Pages purgeable:                          21044.
"Translation faults":                 892374412.
Pages purged:                           3018224.
File-backed pages:                       201883.
Anonymous pages:                         417584.
`;

await test('the macOS memory probe counts the pools the kernel actually reclaims', async () => {
  const { parseVmStat } = await import('../lib/platform.ts');
  const mb = parseVmStat(VM_STAT_16GB);
  // free + inactive + speculative + purgeable = 338,282 pages of 16 KiB ≈ 5.5 GB.
  const expected = Math.round(((8213 + 295118 + 13907 + 21044) * 16384) / 1e6);
  equal(mb, expected);
  // The point of the fix: `os.freemem()` on this machine reports the FREE pages
  // alone — about 134 MB — which is below the 2048 MB floor, so the recording
  // was refused on a machine with gigabytes to spare.
  const freeOnly = Math.round((8213 * 16384) / 1e6);
  assert(freeOnly < 2048, 'the fixture no longer reproduces the failure it exists for');
  assert(mb > 2048, 'the probe still reports below the recording floor');
});

await test('an unreadable vm_stat is null, so the caller falls back rather than inventing a number', async () => {
  const { parseVmStat } = await import('../lib/platform.ts');
  equal(parseVmStat(''), null);
  equal(parseVmStat('not vm_stat output at all'), null);
  // Present but all zero: nothing reclaimable is not a measurement, it is a
  // parse that found nothing.
  equal(parseVmStat('Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 0.\n'), null);
});

await test('a PATH lookup takes the first match, which is the one that would run', async () => {
  const { firstPathLine } = await import('../lib/platform.ts');
  // `where` prints every match on PATH, CRLF-terminated. Only the first runs.
  equal(firstPathLine('C:\\Program Files\\nodejs\\node.exe\r\nC:\\other\\node.exe\r\n'),
    'C:\\Program Files\\nodejs\\node.exe');
  // `which` prints one, LF-terminated.
  equal(firstPathLine('/usr/bin/node\n'), '/usr/bin/node');
  equal(firstPathLine(''), null);
  equal(firstPathLine('\r\n\r\n'), null);
});

await test('setup and doctor print the env-var syntax of the shell in front of the reader', async () => {
  const { exportLine, openCommand, IS_WINDOWS } = await import('../lib/platform.ts');
  const line = exportLine('ELEVENLABS_API_KEY', 'sk_x');
  if (IS_WINDOWS) {
    assert(line.startsWith('$env:'), `PowerShell needs $env:, got "${line}"`);
    assert(openCommand('a.mp4').startsWith('start'), 'windows opens with start');
  } else {
    assert(line.startsWith('export '), `a POSIX shell needs export, got "${line}"`);
    assert(/^(open|xdg-open) /.test(openCommand('a.mp4')), 'macos uses open, linux xdg-open');
  }
});
