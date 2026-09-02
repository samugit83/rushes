#!/usr/bin/env node
// Score the first-pass-usable benchmark.
//
// It runs gates 1 and 2 and reports gate 3 as PENDING, because gate 3 is a
// person. The script will never mark a case passed on a human's behalf: that is
// the same rule the receipt follows, and softening it here would make the number
// it produces meaningless.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';

const here = dirname(decodeURIComponent(new URL(import.meta.url).pathname));
const root = join(here, '..');
const only = process.argv.includes('--case') ? process.argv[process.argv.indexOf('--case') + 1] : null;
const project = process.argv.includes('--project') ? process.argv[process.argv.indexOf('--project') + 1] : 'examples';

const cases = readdirSync(join(here, 'cases'))
  .filter((f) => f.endsWith('.case.json'))
  .map((f) => JSON.parse(readFileSync(join(here, 'cases', f), 'utf8')))
  .filter((c) => !only || c.id === only);

const rushes = (args) => spawnSync('node', [join(root, 'bin', 'rushes.mjs'), ...args, '--project', project],
  { cwd: root, encoding: 'utf8' });

const results = [];
for (const c of cases) {
  const row = { id: c.id, validate: null, deliver: null, humanReview: 'pending', semanticKeys: [] };

  const v = rushes(['validate', c.id, '--quality', 'showcase', '--json']);
  row.validate = v.status === 0 ? 'passed' : 'failed';

  if (row.validate === 'passed') {
    const d = rushes(['deliver', c.id, '--quality', 'showcase']);
    row.deliver = d.status === 0 ? 'passed' : 'failed';
  } else {
    row.deliver = 'not-run';
  }

  // A cheap, honest proxy for "did it cover the brief": is every semantic key
  // present somewhere in the narration? It does not replace gate 3.
  const path = join(root, project, 'demos', `${c.id}.demo.json`);
  if (existsSync(path)) {
    const story = JSON.parse(readFileSync(path, 'utf8'));
    const text = story.scenes.map((s) => s.narration).join(' ').toLowerCase();
    row.semanticKeys = c.semanticKeys.filter((k) => !text.includes(k.toLowerCase()));
  }

  results.push(row);
}

const width = Math.max(8, ...results.map((r) => r.id.length));
process.stderr.write('\n');
for (const r of results) {
  const missing = r.semanticKeys.length ? `  missing keys: ${r.semanticKeys.join(', ')}` : '';
  process.stderr.write(`  ${r.id.padEnd(width)}  validate:${r.validate}  deliver:${r.deliver}  human:${r.humanReview}${missing}\n`);
}

const mechanical = results.filter((r) => r.validate === 'passed' && r.deliver === 'passed' && !r.semanticKeys.length);
process.stderr.write(`\n  ${mechanical.length}/${results.length} passed gates 1 and 2.\n`);
process.stderr.write('  firstPassUsable is NOT this number: gate 3 needs a named human reviewer.\n');
process.stderr.write(`  Record the model, the date and the commit alongside whatever you report.\n\n`);
process.exit(mechanical.length === results.length ? 0 : 1);
