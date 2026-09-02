#!/usr/bin/env node
// Build the shipped payload from GIT-TRACKED FILES ONLY.
//
// That single rule is what makes the payload diffable and what keeps a captured
// browser state, a rendered video, an OAuth token and a `.env` out of it — none
// of them is tracked, so none of them can be shipped by accident. It also means
// a file must be committed before it can ship, which is the correct default for
// something a stranger installs.
//
// Symlinks are rejected outright, and so is a tree with unresolved index
// conflicts: both are ways for a payload to mean something different on the
// machine that unpacks it.

import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, rmSync, existsSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';

const root = join(dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '..');
const stage = process.argv[2] ?? join(root, 'dist', 'skill');

// Excluded from the payload even though they are tracked. The lockfile pins the
// development environment, not the installed one, and nothing generated belongs
// in something a stranger unpacks.
const EXCLUDE = [
  /^package-lock\.json$/,
  /^dist\//,
  /^adapters\//,        // one product's data; it lives with that product
  /^improvement_plan\.md$/,
  /^scripts\//,
  /^\.github\//,
  // The packaged skill ships no README: SKILL.md is the agent-facing contract,
  // and a second document saying nearly the same thing goes stale. The repo
  // README is the repository's, not the payload's.
  /^README\.md$/,
  /^CONTRIBUTING\.md$/,
  /^CHANGELOG\.md$/,
  /^docs\//,
  /^test\/golden\//,
];

function tracked() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean);
}

/**
 * Files that must NEVER be in a payload, even if someone force-added them past
 * the ignore rules. Git-tracked-only is the first line of defence and it is a
 * good one; this is the second, because "it is gitignored" is a property of a
 * file that somebody can change with one flag.
 */
const REFUSE = [
  /(^|\/)\.env$/,
  /(^|\/)\.rushes\//,
  /(^|\/)credentials\//,
  /(^|\/)state\.json$/,
  /\.(mp4|webm|gif|mp3|wav|srt|vtt)$/,
  /(^|\/)token\.json$/,
  /(^|\/)client_secret\.json$/,
];

function assertNoSecrets(files) {
  const bad = files.filter((f) => REFUSE.some((re) => re.test(f)));
  if (bad.length) {
    throw new Error(
      `refusing to package files that must never ship:\n  ${bad.join('\n  ')}\n` +
      'These are tracked in git. Untrack them and check the ignore rules.');
  }
}

function assertClean(files) {
  const conflicts = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: root, encoding: 'utf8' }).trim();
  if (conflicts) throw new Error(`unresolved index conflicts:\n${conflicts}`);
  for (const f of files) {
    const path = join(root, f);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      throw new Error(`refusing to package a symlink: ${f}`);
    }
  }
}

const files = tracked().filter((f) => !EXCLUDE.some((re) => re.test(f)));
assertNoSecrets(files);
assertClean(files);

rmSync(stage, { recursive: true, force: true });
for (const f of files) {
  const dest = join(stage, f);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(root, f), dest);
}

process.stderr.write(`staged ${files.length} tracked files -> ${stage}\n`);
