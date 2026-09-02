// A README that cannot go stale is worth more than one that is currently
// accurate (M12).
//
// Four blocks are derived from the code: the command table, the check registry,
// the version table, and the conformance table. If any has drifted, this fails
// and names the block, rather than leaving a document that quietly describes a
// tool that no longer exists.

import { test, assert } from './harness.mjs';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';

const root = join(dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '..');
const readme = readFileSync(join(root, 'README.md'), 'utf8');

await test('the generated README blocks match the code', () => {
  execFileSync('node', [join(root, 'scripts', 'build-readme.mjs'), '--check'],
    { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
});

await test('every command in the CLI appears in the README table', async () => {
  const { COMMANDS } = await import('../lib/cli/commands.ts');
  for (const c of COMMANDS) assert(readme.includes(`rushes ${c.name}`), `${c.name} is missing from the README`);
});

await test('the README makes no unfalsifiable claim', () => {
  // Every claim is demonstrated or dated. These words are neither.
  const banned = ['blazing', 'seamless', 'effortless', 'production-ready',
                  'cutting-edge', 'state-of-the-art', 'revolutionary', 'game-chang'];
  const body = readme.toLowerCase();
  for (const word of banned) assert(!body.includes(word), `the README says "${word}"`);
});

await test('the README leads with an artifact, not with prose', () => {
  const head = readme.slice(0, 1400);
  // Markdown image, an <img> tag (which is what a sized banner needs), or a
  // video. The rule is that something VISUAL comes first, not which syntax
  // expressed it.
  const visual = /!\[[^\]]*\]\([^)]+\.(gif|png|jpe?g|mp4|svg)\)/.test(head)
    || /<img\s[^>]*src=/i.test(head)
    || head.includes('<video');
  assert(visual, 'nothing visual appears above the fold, in the README of a tool that makes videos');
});

await test('the honest-limitations section exists', () => {
  assert(/##\s+.*limitations/i.test(readme), 'no limitations section');
});
