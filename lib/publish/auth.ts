// OAuth for the optional upload module (K11). Absent from the critical path:
// nothing here is imported unless a project configured publishing, and
// `googleapis` is an optional dependency.
//
// Credentials live in the FILMED PROJECT's credentials/ directory, not in the
// skill. The skill never stores another system's secret, and an OAuth refresh
// token is exactly that.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { projectRoot } from '../paths.ts';

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
  // captions.insert is refused without force-ssl. A token minted before this
  // scope was added lacks it, and the caption step then fails with an
  // insufficient-permissions error until this command is re-run once.
  'https://www.googleapis.com/auth/youtube.force-ssl',
];
const PORT = 5859;

export function credDir(): string { return join(projectRoot(), 'credentials'); }
export function tokenPath(): string { return join(credDir(), 'token.json'); }

export async function loadOAuthClient() {
  const { google } = await import('googleapis');
  const secretPath = join(credDir(), 'client_secret.json');
  if (!existsSync(secretPath)) {
    throw new Error(`missing ${secretPath} — download an OAuth "Desktop app" client JSON from Google Cloud`);
  }
  const raw = JSON.parse(readFileSync(secretPath, 'utf8')) as { installed?: Record<string, string>; web?: Record<string, string> };
  const conf = raw.installed ?? raw.web;
  if (!conf) throw new Error('client_secret.json has no "installed"/"web" section');
  const client = new google.auth.OAuth2(conf.client_id, conf.client_secret, `http://localhost:${PORT}`);
  if (existsSync(tokenPath())) client.setCredentials(JSON.parse(readFileSync(tokenPath(), 'utf8')));
  return client;
}

export async function authorize(): Promise<number> {
  const client = await loadOAuthClient();
  const authUrl = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
  process.stderr.write(`\n1) Open this URL and grant access:\n\n${authUrl}\n\n`);
  process.stderr.write(`2) Waiting for the redirect to http://localhost:${PORT} …\n\n`);
  const code: string = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const c = new URL(req.url ?? '', `http://localhost:${PORT}`).searchParams.get('code');
      if (c) { res.end('Authorization received. You can close this tab.'); server.close(); resolve(c); }
      else res.end('waiting for code…');
    });
    server.on('error', reject);
    server.listen(PORT);
  });
  const { tokens } = await client.getToken(code);
  mkdirSync(credDir(), { recursive: true });
  writeFileSync(tokenPath(), JSON.stringify(tokens, null, 2), { mode: 0o600 });
  process.stderr.write(`✓ saved ${tokenPath()} — uploads authorized.\n`);
  return 0;
}
