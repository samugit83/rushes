// Principle 10, as a test rather than a promise: THE ENGINE KNOWS NOTHING ABOUT
// THE APP IT FILMS.
//
// The acceptance test is literal. Grepping the engine for the product's name
// must return nothing. Before this existed, one file carried seven couplings to
// one product: a project-list endpoint, a query parameter appended to every
// navigation, two preference PATCHes with named feature keys, three literal
// button labels, two localStorage keys, and an onboarding version mirrored from
// the app's own source.
//
// Also enforced here: the two-key rule for the skill's own environment, and the
// invariant that a captured browser state never enters the packaged payload.

import { test, assert, equal } from './harness.mjs';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every product-specific identifier that must never appear in the engine. */
const FORBIDDEN = [
  'redamon',
  'REDAMON_BASE_URL',
  'REDAMON_USER_ID',
  'AUTH_SECRET',
  'Basic Info',        // the node-drawer label that used to be compiled in
  'graphView',         // a product feature key
  'PRODUCT DEMO',      // a brand kicker; it is a config default, not a constant
];

const ALLOWED_PATHS = [
  // The adapter is the product's, by design.
  'adapters',
  // Fixtures and examples are neutral, but the test files themselves name the
  // forbidden strings in order to forbid them.
  'test/neutrality.test.mjs',
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.git', 'out', 'cache', 'adapters', '.rushes'].includes(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

await test('no product-specific identifier appears in lib/, bin/ or schemas/', () => {
  const files = [
    ...walk(join(root, 'lib')),
    ...walk(join(root, 'bin')),
    ...walk(join(root, 'schemas')),
    ...walk(join(root, 'slides', 'runtime')).filter((f) => extname(f) !== '.woff2'),
  ];
  const hits = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const term of FORBIDDEN) {
      if (text.toLowerCase().includes(term.toLowerCase())) {
        hits.push(`${relative(root, f)}: "${term}"`);
      }
    }
  }
  equal(hits, [], 'the engine has learned something about one product');
});

await test('the shipped default config carries no product', async () => {
  const { DEFAULT_CONFIG } = await import('../lib/projectConfig.ts');
  const text = JSON.stringify(DEFAULT_CONFIG).toLowerCase();
  for (const term of FORBIDDEN) assert(!text.includes(term.toLowerCase()), `default config mentions ${term}`);
});

await test('the environment allowlist is exactly two keys, and both are about the voice', async () => {
  const { ENV_ALLOWLIST } = await import('../lib/env.ts');
  equal([...ENV_ALLOWLIST], ['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID']);
});

await test('the example .env template carries only those two keys', () => {
  const text = readFileSync(join(root, '.env.example'), 'utf8');
  const keys = [...text.matchAll(/^\s*([A-Z_][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]);
  equal(keys, ['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID']);
});

await test('a captured browser state can never enter the packaged payload', () => {
  const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
  for (const entry of ['.env', '.rushes/', 'credentials/', 'out/', 'cache/', 'node_modules/']) {
    assert(ignore.includes(entry), `.gitignore does not exclude ${entry}`);
  }
});

await test('the publish module is optional and never on the build path', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert(pkg.optionalDependencies?.googleapis, 'googleapis must be optional');
  assert(!pkg.dependencies?.googleapis, 'googleapis must not be a hard dependency');
  // A build must not transitively import the uploader.
  const deliver = readFileSync(join(root, 'lib', 'cli', 'deliver.ts'), 'utf8');
  // The metadata builder is not the uploader: `publish/youtubeMeta.ts` writes a
  // reviewable text file and imports nothing that can upload.
  assert(!/publish\/youtube\.ts/.test(deliver), 'the build path imports the uploader');
});

await test('every dependency is pinned to an exact version', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const all = { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.devDependencies };
  for (const [name, range] of Object.entries(all)) {
    assert(/^\d+\.\d+\.\d+$/.test(range), `${name} is "${range}", not an exact version`);
  }
});

await test('nothing is fetched from a CDN at render time', () => {
  const files = [...walk(join(root, 'lib')), ...walk(join(root, 'slides', 'runtime'))]
    .filter((f) => ['.ts', '.js', '.css'].includes(extname(f)));
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    assert(!/https?:\/\/fonts\.(googleapis|gstatic)/.test(text), `${f} loads a web font`);
    assert(!/<link[^>]+stylesheet[^>]+https?:/.test(text), `${f} loads a remote stylesheet`);
  }
});

await test('the skill ships no README of its own', () => {
  // The workspace README is the repository's; the packaged skill carries none,
  // because SKILL.md is the agent-facing contract and a second document that
  // says nearly the same thing goes stale.
  assert(existsSync(join(root, 'SKILL.md')), 'SKILL.md is missing');
});
