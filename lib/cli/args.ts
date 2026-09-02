// Argument parsing, kept deliberately small. Everything the CLI accepts is in
// the table in commands.ts; this only turns argv into a shape.

import type { QualityProfile } from '../config.ts';

export interface Args {
  command: string;
  positional: string[];
  quality: QualityProfile;
  json: boolean;
  headed: boolean;
  confirm: boolean;
  force: boolean;
  strict: boolean;
  updateGolden: boolean;
  verifyFixes?: boolean;
  noGif: boolean;
  allowLowMemory: boolean;
  allowConcurrentScan: boolean;
  nonInteractive: boolean;
  clean: 'junk' | 'intermediates' | 'all' | null;
  privacy?: 'public' | 'unlisted' | 'private';
  project?: string;
  consent?: string;
  raw: string[];
}

export function parseArgs(argv: string[]): Args {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const valueOf = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
  };
  const positional = argv.filter((a, i) => !a.startsWith('--')
    && !(i > 0 && argv[i - 1].startsWith('--') && ['quality', 'project', 'privacy', 'consent'].includes(argv[i - 1].slice(2))));

  const qualityRaw = valueOf('quality');
  return {
    command: positional[0] ?? 'help',
    positional: positional.slice(1),
    quality: qualityRaw === 'standard' ? 'standard' : 'showcase',
    json: flags.has('--json'),
    headed: flags.has('--headed'),
    confirm: flags.has('--confirm'),
    force: flags.has('--force'),
    strict: flags.has('--strict'),
    updateGolden: flags.has('--update-golden'),
    verifyFixes: flags.has('--no-verify-fixes') ? false : flags.has('--verify-fixes') ? true : undefined,
    noGif: flags.has('--no-gif'),
    allowLowMemory: flags.has('--allow-low-memory'),
    allowConcurrentScan: flags.has('--allow-concurrent-scan'),
    nonInteractive: flags.has('--non-interactive'),
    clean: flags.has('--no-clean') ? null : flags.has('--purge') ? 'all' : 'intermediates',
    privacy: flags.has('--public') ? 'public' : flags.has('--private') ? 'private'
      : flags.has('--unlisted') ? 'unlisted' : (valueOf('privacy') as Args['privacy']),
    project: valueOf('project'),
    consent: valueOf('consent'),
    raw: argv,
  };
}
