// The server-rendered shape, with a CSRF-protected login form.
//
// It is NOT Django, and the conformance table says so. What it reproduces is the
// behaviour the engine has to survive: every page is a full document from the
// server, the login is a form POST carrying a hidden CSRF field, and the session
// is a cookie. That is the same shape as Django, Rails, Laravel and every
// server-rendered admin panel, and it is what a client-rendered-SPA assumption
// breaks on.

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const sessions = new Set();
const tokens = new Set();

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{background:#101317;color:#e8e8ee;font:16px system-ui;margin:0;padding:40px}
h1{font-size:28px;margin:0 0 20px}table{border-collapse:collapse;width:100%;max-width:760px}
td,th{padding:12px 16px;border-bottom:1px solid #262a33;text-align:left}
input{background:#181b25;border:1px solid #262a33;color:#e8e8ee;padding:10px;border-radius:6px}
button{background:#4ade80;color:#0b0d12;border:0;padding:10px 18px;border-radius:6px;font-weight:600}
</style></head><body>${body}</body></html>`;
}

export function serve(port = 8788) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const cookie = req.headers.cookie ?? '';
    const signedIn = [...sessions].some((s) => cookie.includes(`sid=${s}`));

    if (url.pathname === '/accounts/login/' && req.method === 'GET') {
      const token = randomBytes(8).toString('hex');
      tokens.add(token);
      res.setHeader('content-type', 'text/html');
      res.end(page('Sign in', `<h1>Sign in</h1>
        <form action="/accounts/login/" method="post">
          <input type="hidden" name="csrfmiddlewaretoken" value="${token}">
          <p><input name="username" placeholder="username" aria-label="username"></p>
          <p><input name="password" type="password" placeholder="password" aria-label="password"></p>
          <button type="submit">Log in</button>
        </form>`));
      return;
    }

    if (url.pathname === '/accounts/login/' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const form = new URLSearchParams(body);
        if (!tokens.has(form.get('csrfmiddlewaretoken') ?? '')) {
          res.statusCode = 403;
          res.end(page('Forbidden', '<h1>CSRF verification failed</h1>'));
          return;
        }
        const sid = randomBytes(8).toString('hex');
        sessions.add(sid);
        res.statusCode = 302;
        res.setHeader('set-cookie', `sid=${sid}; Path=/; HttpOnly`);
        res.setHeader('location', '/');
        res.end();
      });
      return;
    }

    if (!signedIn) {
      res.statusCode = 302;
      res.setHeader('location', '/accounts/login/');
      res.end();
      return;
    }

    res.setHeader('content-type', 'text/html');
    res.end(page('Records', `<h1>Records</h1>
      <p><a href="/accounts/logout/">Sign out</a></p>
      <table><thead><tr><th>Reference</th><th>Owner</th></tr></thead>
      <tbody><tr><td>REC-2001</td><td>Operations</td></tr>
      <tr><td>REC-2002</td><td>Marketing</td></tr></tbody></table>`));
  });
  // port 0 asks the OS for a free one; the caller reads server.address().port.
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1]?.endsWith('server.mjs')) {
  await serve(Number(process.argv[2] ?? 8788));
  process.stderr.write('ssr fixture on http://127.0.0.1:8788\n');
}
