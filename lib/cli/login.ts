// `rushes login`: one interactive minute that buys every subsequent unattended
// recording, and the skill never sees the credential.
//
// The browser opens headed, the human signs in however their application
// actually requires — a password manager, a TOTP prompt, an SSO redirect, a
// hardware key — and the resulting cookies and localStorage are saved. That blob
// works with Django sessions, Rails, Laravel, Next.js and anything else, which
// is why `storage-state` is the recommended default rather than one strategy
// among six.
//
// SP6 — the file is a bearer credential. Anyone holding it is signed in. It is
// written 0600, it never enters out/, it never enters a receipt, and it never
// enters the packaged payload.

import { chromium } from 'playwright';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../projectConfig.ts';
import { statePathOf, writeState } from '../auth/index.ts';
import { VIDEO } from '../config.ts';

export async function login(): Promise<number> {
  const { config } = loadConfig();
  const path = statePathOf(config.auth);

  process.stderr.write(`\nopening ${config.baseUrl} headed.\n`);
  process.stderr.write('Sign in as you normally would. Nothing you type is read by rushes.\n\n');

  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: VIDEO.width / 2, height: VIDEO.height / 2 } });
  const page = await context.newPage();
  await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  await rl.question('Press Enter here once you are signed in… ');
  rl.close();

  const state = await context.storageState();
  writeState(path, JSON.stringify(state, null, 2));
  await context.close();
  await browser.close();

  process.stderr.write(`\n✓ saved ${path} (mode 0600)\n`);
  process.stderr.write('  It expires: rushes refuses to record on a stale state rather than filming a logged-out app.\n');
  process.stderr.write('  Add it to .gitignore if it is not already.\n\n');
  return 0;
}
