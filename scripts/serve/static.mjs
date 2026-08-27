/**
 * serve/static.mjs — the public half of the daemon: the built ui/dist bundle
 * when it exists, else the inline status page.
 *
 * Deliberately unstyled beyond system-font basics (the real UI arrives through
 * docs/design-direction.md's pipeline). The page is public and secret-free —
 * it reads the token from location.hash — while every /api path stays
 * token-gated. Path traversal out of uiDist is a 404 before any read.
 */
import fs from 'node:fs';
import path from 'node:path';

const STATUS_PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>project-brain — Control Room (status)</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;max-width:60rem}table{border-collapse:collapse}td,th{border:1px solid #999;padding:2px 8px;text-align:left}</style>
</head>
<body>
<h1>project-brain serve — status</h1>
<p>Minimal status page (the Control Room UI is not built yet). It proves the API using the token from the URL fragment.</p>
<div id="out">loading…</div>
<script>
(function () {
  var out = document.getElementById('out');
  var m = /(?:^|[#&])token=([^&]+)/.exec(location.hash);
  if (!m) { out.textContent = 'No token in URL fragment. Start via "project-brain serve" and open the printed URL.'; return; }
  var headers = { Authorization: 'Bearer ' + decodeURIComponent(m[1]) };
  function fetchJson(p) {
    return fetch(p, { headers: headers }).then(function (r) {
      if (!r.ok) throw new Error(p + ' -> HTTP ' + r.status);
      return r.json();
    });
  }
  Promise.all([fetchJson('/api/meta'), fetchJson('/api/state')]).then(function (res) {
    var meta = res[0], state = res[1];
    var html = '<h2>meta</h2><pre>' + JSON.stringify(meta, null, 2).replace(/</g, '&lt;') + '</pre>';
    function table(rows, cols) {
      if (!rows.length) return '<p>(none)</p>';
      var h = '<table><tr>' + cols.map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr>';
      rows.forEach(function (r) {
        h += '<tr>' + cols.map(function (c) { return '<td>' + String(r[c] || '').replace(/</g, '&lt;') + '</td>'; }).join('') + '</tr>';
      });
      return h + '</table>';
    }
    html += '<h2>workstreams</h2>' + table(state.workstreams || [], ['taskId', 'owner', 'tool', 'branch', 'status']);
    html += '<h2>leases</h2>' + table(state.leases || [], ['target', 'lockedBy', 'until', 'notes']);
    if (state.stale_warning) html += '<p>' + String(state.stale_warning).replace(/</g, '&lt;') + '</p>';
    out.innerHTML = html;
  }).catch(function (e) { out.textContent = 'API error: ' + e.message; });
})();
</script>
</body>
</html>
`;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2'
};

export function serveStatic(res, pathname, uiDist) {
  if (!fs.existsSync(path.join(uiDist, 'index.html'))) {
    // No built UI bundle: inline status page for every non-API path.
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    return res.end(STATUS_PAGE);
  }
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { rel = '/'; }
  if (rel === '/' || rel === '') rel = '/index.html';
  // Path-traversal guard: resolve inside uiDist or 404.
  const resolved = path.resolve(uiDist, '.' + path.posix.normalize(rel));
  if (resolved !== uiDist && !resolved.startsWith(uiDist + path.sep)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }
  let body;
  try {
    body = fs.readFileSync(resolved);
  } catch {
    // SPA fallback to index.html for client-side routes.
    body = fs.readFileSync(path.join(uiDist, 'index.html'));
    rel = '/index.html';
  }
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(rel).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}
