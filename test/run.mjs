#!/usr/bin/env node
// The test runner. Deliberately small: render deterministically, compare, no
// framework. The suite that matters is the one that pays for itself.
//
//   node test/run.mjs            every suite
//   node test/run.mjs unit       just the fast ones
//   node test/run.mjs timing     just the golden timing test

import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { results } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const only = process.argv[2];

const suites = readdirSync(here)
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => !only || f.includes(only))
  .sort();

if (!suites.length) {
  process.stderr.write(`no suite matches "${only}"\n`);
  process.exit(1);
}

for (const s of suites) {
  process.stderr.write(`\n${s}\n`);
  await import(pathToFileURL(join(here, s)).href);
}

const { passed, failed, failures } = results();
process.stderr.write(`\n  ${passed} passed, ${failed} failed\n\n`);
for (const f of failures) process.stderr.write(`${f.name}\n${f.error?.stack ?? f.error}\n\n`);
process.exit(failed ? 1 : 0);
