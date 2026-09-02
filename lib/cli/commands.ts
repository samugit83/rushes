// The command table. It is the single definition of the CLI surface: the
// dispatcher reads it, `rushes help` prints it, and the README's command table
// is GENERATED from it (M9). A README table that has drifted from the CLI is
// worse than no table at all.

export interface CommandSpec {
  name: string;
  args: string;
  summary: string;
  /** Longer help, printed by `rushes help <command>`. */
  detail?: string;
  /** Commands an agent parses with --json. */
  json?: boolean;
}

export const COMMANDS: CommandSpec[] = [
  { name: 'setup', args: '', summary: 'check what is needed and install what can be installed',
    detail: 'Installs the browser for you. Prints the one ffmpeg command for your package manager, and will not run it for you.' },
  { name: 'demo', args: '[dir]', summary: 'record a video of the bundled example app; no configuration at all',
    detail: 'Starts the example app on a free port, waits until it answers, films it, and stops it. Writes to ./rushes-demo unless you name a directory.' },
  { name: 'doctor', args: '', summary: 'check node, ffmpeg, chrome, the browser engine and the optional keys',
    detail: 'Also replays a leftover preference restore from a killed run, and can approve a runner command.' },
  { name: 'init', args: '', summary: 'probe the app and scaffold rushes.config.json' },
  { name: 'login', args: '', summary: 'sign in by hand once, headed, and save the browser state' },
  { name: 'discover', args: '<id>', summary: 'walk the app and draft a storyboard with expects pre-filled',
    detail: 'A proposal, never a recording. Every scene carries an expect bound to an element that was actually seen.' },
  { name: 'validate', args: '<id>', summary: 'schema, lint, and a live dry run of every step and expect', json: true },
  { name: 'rehearse', args: '<id>', summary: 'two silent passes; they must agree before you record', json: true },
  { name: 'build', args: '<id>', summary: 'voice, record, compose and check into a staging directory' },
  { name: 'deliver', args: '<id>', summary: 'build, then commit atomically on pass and write the receipt' },
  { name: 'evidence', args: '<id>', summary: 'keyframes and the narration check, from the DELIVERED mp4' },
  { name: 'recut', args: '<id>', summary: 're-compose from the recording and the timeline; no re-record' },
  { name: 'rerun', args: '<id>', summary: 're-record and report, per scene, what changed since the last delivery',
    detail: 'Answers "which of my published videos need re-recording after this UI change".' },
  { name: 'score', args: '<id>', summary: 'an advisory score sheet: pacing, motion, reading rate. Not a gate' },
  { name: 'formats', args: '<id>', summary: 'a GIF, a vertical crop and editor stems from the same capture' },
  { name: 'slides', args: '<build|check|preview|tokens>', summary: 'compile, measure, screenshot or derive the slide deck' },
  { name: 'check', args: '<id>', summary: 'run the checker against what is already on disk', json: true },
  { name: 'status', args: '', summary: 'the catalogue: what was built, published, and has since drifted' },
  { name: 'publish', args: '<id>', summary: 'optional; refuses without a passing receipt' },
  { name: 'publish-auth', args: '', summary: 'optional; one-time OAuth for the upload module' },
  { name: 'clean', args: '<id>', summary: 'sweep intermediates; deliverables are never touched' },
  { name: 'help', args: '[command]', summary: 'this list' },
];

export function usage(): string {
  const width = Math.max(...COMMANDS.map((c) => `${c.name} ${c.args}`.trim().length));
  const rows = COMMANDS.map((c) => `  ${`${c.name} ${c.args}`.trim().padEnd(width)}  ${c.summary}`);
  return [
    'rushes — point your coding agent at your web app, get a narrated, captioned, verified demo video.',
    '',
    'usage: rushes <command> [options]',
    '',
    ...rows,
    '',
    'options:',
    '  --quality standard|showcase   how strict the checker is (default: showcase)',
    '  --json                        machine-readable output (validate, rehearse, check)',
    '  --headed                      watch the browser drive the app',
    '  --confirm                     actually publish (publish is a dry run without it)',
    '  --force                       override a failing publish gate, loudly and on the record',
    '  --project <dir>               the project to film (default: the working directory)',
    '',
  ].join('\n');
}

export function commandHelp(name: string): string {
  const c = COMMANDS.find((x) => x.name === name);
  if (!c) return `unknown command "${name}"\n\n${usage()}`;
  return [`rushes ${c.name} ${c.args}`.trim(), '', `  ${c.summary}`, ...(c.detail ? ['', `  ${c.detail}`] : []), ''].join('\n');
}
