#!/usr/bin/env node
// One entry point, every subcommand. `npx rushes <cmd>` and a global install both
// land here.
//
// Node strips the types in lib/*.ts at load time (>= 22.6), which is why there is
// no build step and no compiled artifact to keep in sync with the source.

import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(decodeURIComponent(new URL(import.meta.url).pathname));
const lib = (p) => pathToFileURL(join(here, '..', 'lib', p)).href;

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  process.stderr.write(`rushes needs Node 22.6 or newer (found ${process.version}).\n`);
  process.exit(1);
}

const { parseArgs } = await import(lib('cli/args.ts'));
const { usage, commandHelp } = await import(lib('cli/commands.ts'));

const args = parseArgs(process.argv.slice(2));

// Every path in the tool is resolved against the project being filmed, not
// against the skill: the skill is installed once and films many projects.
if (args.project) process.env.RUSHES_PROJECT_ROOT = resolve(args.project);
else if (!process.env.RUSHES_PROJECT_ROOT) process.env.RUSHES_PROJECT_ROOT = process.cwd();

const needsId = ['discover', 'score', 'rerun', 'validate', 'rehearse', 'build', 'deliver', 'evidence', 'recut', 'formats', 'check', 'publish', 'clean'];
const id = args.positional[0];
if (needsId.includes(args.command) && !id) {
  process.stderr.write(commandHelp(args.command));
  process.exit(1);
}

let code = 0;
try {
  switch (args.command) {
    case 'demo': {
      const { demo } = await import(lib('cli/demo.ts'));
      code = await demo({
        into: args.positional[0] ?? 'rushes-demo',
        quality: args.quality === 'showcase' && args.raw.includes('--quality') ? 'showcase' : 'standard',
        headed: args.headed,
        keep: args.raw.includes('--keep'),
      });
      break;
    }
    case 'setup': {
      const { setup } = await import(lib('cli/setup.ts'));
      code = await setup();
      break;
    }
    case 'doctor': {
      const { doctor } = await import(lib('cli/doctor.ts'));
      code = await doctor({
        replayRestores: args.raw.includes('--replay-restores'),
        approveRunner: args.raw.includes('--approve-runner'),
      });
      break;
    }
    case 'init': {
      const { init } = await import(lib('cli/init.ts'));
      code = await init(args.positional[0] ?? 'http://localhost:3000');
      break;
    }
    case 'login': {
      const { login } = await import(lib('cli/login.ts'));
      code = await login();
      break;
    }
    case 'discover': {
      const { loadConfig } = await import(lib('projectConfig.ts'));
      const { boot } = await import(lib('engine/session.ts'));
      const { discoverSite, draftStoryboard } = await import(lib('cli/discover.ts'));
      const { storyboardPath } = await import(lib('storyboard.ts'));
      const { writeFileSync, mkdirSync, existsSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      const { config } = loadConfig();
      const target = storyboardPath(id);
      if (existsSync(target)) {
        process.stderr.write(`${target} already exists; delete it or choose another id.\n`);
        code = 1;
        break;
      }
      const stub = {
        schemaVersion: 1, id, feature: id,
        opening: { kicker: '', title: '', subtitle: '', disclaimer: '', narration: '.' },
        scenes: [{ id: 'root', narration: '.', steps: [{ do: 'goto', path: '/' }] }],
        closing: { title: '', subtitle: '', narration: '.' },
      };
      const session = await boot({ story: stub, config, record: false, skipAsserts: true });
      try {
        const routes = await discoverSite(session.page, config, '/', 6);
        const draft = draftStoryboard(id, id, routes);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, JSON.stringify(draft, null, 2) + '\n');
        process.stderr.write(`\n  discovered ${routes.length} routes -> ${target}\n`);
        for (const r of routes) process.stderr.write(`    ${r.path.padEnd(24)} ${r.heading ?? r.title}\n`);
        process.stderr.write('\n  This is a DRAFT. Every narration line says TODO on purpose.\n');
        process.stderr.write('  Write the narration, then present the outline at Gate 2 before recording.\n\n');
      } finally {
        await session.close();
      }
      break;
    }
    case 'validate': {
      const { validate } = await import(lib('cli/validate.ts'));
      code = await validate({ id, json: args.json, headed: args.headed, live: !args.raw.includes('--offline') });
      break;
    }
    case 'rehearse': {
      const { loadConfig } = await import(lib('projectConfig.ts'));
      const { loadStoryboard } = await import(lib('storyboard.ts'));
      const { rehearse } = await import(lib('check/rehearse.ts'));
      const { printDiagnostics } = await import(lib('diagnostics.ts'));
      const { config } = loadConfig();
      const sb = loadStoryboard(id, config);
      const r = await rehearse(sb.story, config);
      if (args.json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      else {
        printDiagnostics(r.diagnostics);
        process.stderr.write(`\n  rehearsal: ${r.status} over ${r.passes} passes`);
        process.stderr.write(r.exemptScenes.length ? `  (exempt: ${r.exemptScenes.join(', ')})\n\n` : '\n\n');
      }
      code = r.status === 'agreed' ? 0 : 1;
      break;
    }
    case 'build':
    case 'deliver': {
      const { buildAndDeliver } = await import(lib('cli/deliver.ts'));
      code = await buildAndDeliver({
        id,
        quality: args.quality,
        headed: args.headed,
        commit: args.command === 'deliver',
        rehearseFirst: args.quality === 'showcase' && !args.raw.includes('--no-rehearse'),
        allowLowMemory: args.allowLowMemory,
        nonInteractive: args.nonInteractive,
        publishConsent: args.consent,
      });
      break;
    }
    case 'check': {
      const { checkOnly } = await import(lib('cli/deliver.ts'));
      code = await checkOnly(id, args.quality, args.json);
      break;
    }
    case 'evidence': {
      const { evidence } = await import(lib('cli/misc.ts'));
      code = await evidence(id);
      break;
    }
    case 'recut': {
      const { recut } = await import(lib('cli/misc.ts'));
      code = await recut(id, args.raw.includes('--bitexact'));
      break;
    }
    case 'score': {
      const { readFileSync } = await import('node:fs');
      const { demoPaths } = await import(lib('paths.ts'));
      const { scoreSheet, formatScore } = await import(lib('check/quality.ts'));
      const P = demoPaths(id);
      const tl = JSON.parse(readFileSync(P.timeline, 'utf8'));
      process.stderr.write('\n' + formatScore(scoreSheet(tl.timeline)) + '\n\n');
      break;
    }
    case 'rerun': {
      const { snapshotEvidence, compareEvidence, formatDiffs } = await import(lib('cli/rerun.ts'));
      const { buildAndDeliver } = await import(lib('cli/deliver.ts'));
      const previous = snapshotEvidence(id);
      code = await buildAndDeliver({
        id, quality: args.quality, headed: args.headed, commit: true,
        rehearseFirst: false, allowLowMemory: args.allowLowMemory,
        nonInteractive: args.nonInteractive, publishConsent: args.consent,
      });
      process.stderr.write('\nwhat changed since the last delivery:\n');
      process.stderr.write(formatDiffs(compareEvidence(id, previous)) + '\n\n');
      break;
    }
    case 'formats': {
      const { formats } = await import(lib('cli/misc.ts'));
      code = formats(id);
      break;
    }
    case 'slides': {
      const { slides } = await import(lib('cli/slides.ts'));
      const sub = args.positional[0] ?? 'build';
      code = await slides(sub, args.positional[1], { updateGolden: args.updateGolden, json: args.json, verifyFixes: args.verifyFixes });
      break;
    }
    case 'status': {
      const { status } = await import(lib('cli/misc.ts'));
      code = status();
      break;
    }
    case 'clean': {
      const { clean } = await import(lib('cli/misc.ts'));
      const level = args.raw.includes('--all') ? 'all' : args.raw.includes('--intermediates') ? 'intermediates' : 'junk';
      code = clean(id, level, args.confirm);
      break;
    }
    case 'publish': {
      const { loadConfig } = await import(lib('projectConfig.ts'));
      const { publish } = await import(lib('publish/youtube.ts'));
      const { config } = loadConfig();
      code = await publish({
        id, config, confirm: args.confirm, force: args.force,
        privacy: args.privacy, clean: args.clean,
      });
      break;
    }
    case 'publish-auth': {
      const { authorize } = await import(lib('publish/auth.ts'));
      code = await authorize();
      break;
    }
    case 'help':
      process.stderr.write(args.positional[0] ? commandHelp(args.positional[0]) : usage());
      break;
    default:
      process.stderr.write(`unknown command "${args.command}"\n\n${usage()}`);
      code = 1;
  }
} catch (e) {
  process.stderr.write(`\n${e?.message ?? e}\n`);
  if (process.env.RUSHES_DEBUG) process.stderr.write(`${e?.stack ?? ''}\n`);
  code = 1;
}

process.exit(code);
