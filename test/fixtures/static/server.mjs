// The smallest possible application: a static file server on 127.0.0.1.
//
// It proves the claim that matters most and is easiest to overstate — that the
// engine needs NO framework. There is no build step, no hydration, no client
// router and no JSON API here, and the same storyboard vocabulary drives it.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };

export function serve(port = 8787) {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const file = join(root, path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
    if (!file.startsWith(root) || !existsSync(file)) { res.statusCode = 404; res.end('not found'); return; }
    res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
  });
  // port 0 asks the OS for a free one; the caller reads server.address().port.
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1]?.endsWith('server.mjs')) {
  const port = Number(process.argv[2] ?? 8787);
  await serve(port);
  process.stderr.write(`fixture on http://127.0.0.1:${port}\n`);
}
