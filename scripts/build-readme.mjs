#!/usr/bin/env node
// Regenerate the blocks of the README that are DERIVED from the code, between
// their markers. Everything outside a marker is written by hand and is never
// touched here.
//
// The hero is protected content: do not change it as a side effect of iterating
// on something else.
//
//   node scripts/build-readme.mjs           rewrite
//   node scripts/build-readme.mjs --check   fail if it has drifted

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = join(root, 'README.md');
const check = process.argv.includes('--check');

const { COMMANDS } = await import(join(root, 'lib', 'cli', 'commands.ts'));
const { CHECKS, levelFor } = await import(join(root, 'lib', 'check', 'registry.ts'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function commandTable() {
  const w = Math.max(...COMMANDS.map((c) => `${c.name} ${c.args}`.trim().length));
  return ['| Command | What it does |', '|---|---|',
    ...COMMANDS.map((c) => `| \`rushes ${`${c.name} ${c.args}`.trim().padEnd(w)}\` | ${c.summary} |`)].join('\n');
}

function checkTable() {
  const rows = CHECKS.map((c) => {
    const fmt = (v) => (v === 'error' ? '**error**' : v);
    return `| \`${c.name}\` | ${c.measures} | ${fmt(levelFor(c, 'standard'))} | ${fmt(levelFor(c, 'showcase'))} |`;
  });
  return ['| Check | Measures | standard | showcase |', '|---|---|---|---|', ...rows].join('\n');
}

function versions() {
  return [
    '| | |',
    '|---|---|',
    `| version | \`${pkg.version}\` |`,
    `| node | \`${pkg.engines.node}\` |`,
    `| license | \`${pkg.license}\` |`,
    `| dependencies | ${Object.entries(pkg.dependencies).map(([n, v]) => `\`${n}@${v}\``).join(', ')} |`,
    `| optional | ${Object.entries(pkg.optionalDependencies ?? {}).map(([n, v]) => `\`${n}@${v}\``).join(', ')} |`,
  ].join('\n');
}

const BLOCKS = { commands: commandTable(), checks: checkTable(), versions: versions() };

let text = readFileSync(README, 'utf8');
let drifted = [];
for (const [name, body] of Object.entries(BLOCKS)) {
  const re = new RegExp(`(<!-- generated:${name} -->\\n)([\\s\\S]*?)(<!-- /generated:${name} -->)`);
  if (!re.test(text)) throw new Error(`README has no <!-- generated:${name} --> block`);
  const current = text.match(re)[2].trim();
  if (current !== body.trim()) drifted.push(name);
  text = text.replace(re, `$1${body}\n$3`);
}

if (check) {
  if (drifted.length) {
    process.stderr.write(`the README has drifted from the code: ${drifted.join(', ')}\n`);
    process.stderr.write('run: node scripts/build-readme.mjs\n');
    process.exit(1);
  }
  process.stderr.write('README is fresh\n');
} else {
  writeFileSync(README, text);
  process.stderr.write(drifted.length ? `regenerated: ${drifted.join(', ')}\n` : 'README already fresh\n');
}
