// The client-hydrated shape.
//
// Not Next.js, and the conformance table says so. What it reproduces is the
// behaviour that breaks a server-rendered assumption: the first document is an
// empty shell, the content arrives from a fetch after hydration, and a route
// change never reloads the page. An engine that waits for `domcontentloaded`
// plus a fixed guess films the shell.

import { createServer } from 'node:http';

const SHELL = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Console</title>
<style>body{background:#0d0f14;color:#e8e8ee;font:16px system-ui;margin:0;padding:40px}
h1{font-size:28px}.row{padding:12px 16px;border-bottom:1px solid #262a33}
[aria-busy="true"]{opacity:.4}nav a{color:#7dd3fc;margin-right:16px;cursor:pointer}</style>
</head><body>
<div id="app" aria-busy="true"><h1>Console</h1><p>Loading…</p></div>
<script>
  // Hydration, then a data fetch that settles ~700 ms after first paint. The
  // engine must wait for the network to go quiet, not for a fixed number.
  const app = document.getElementById('app');
  function render(route, items) {
    app.innerHTML = '<h1>Console</h1>'
      + '<nav><a id="to-detail">Detail</a><a id="to-home">Home</a></nav>'
      + (route === 'detail'
        ? '<div class="row">Detail for ' + items[0].name + '</div>'
        : items.map(function (i) { return '<div class="row">' + i.name + '</div>'; }).join(''));
    app.removeAttribute('aria-busy');
    document.getElementById('to-detail').onclick = function () { render('detail', items); };
    document.getElementById('to-home').onclick = function () { render('home', items); };
  }
  fetch('/api/items').then(function (r) { return r.json(); }).then(function (items) { render('home', items); });
</script></body></html>`;

export function serve(port = 8789) {
  const server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/api/items')) {
      // Deliberately slow: the settle predicate has to notice it.
      setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify([{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }]));
      }, 700);
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(SHELL);
  });
  // port 0 asks the OS for a free one; the caller reads server.address().port.
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1]?.endsWith('server.mjs')) {
  await serve(Number(process.argv[2] ?? 8789));
  process.stderr.write('spa fixture on http://127.0.0.1:8789\n');
}
