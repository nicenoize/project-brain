/**
 * serve/security.mjs — the Control Room's request-security layer.
 *
 * Everything a request must survive before any handler sees it (strategy doc
 * §M2.75 security model, points b/c/d/e): the constant-time session-token
 * compare, Origin/Host validation (DNS-rebinding defense), the method matrix
 * that confines writes to the four POST endpoints, the bounded JSON body
 * reader, and the single JSON responder that never emits a CORS header.
 *
 * PURE except readJsonBody (reads the request stream) — no fs, no processes,
 * no clocks. Split out of brain-serve.mjs so the security rules can be read,
 * reviewed and tested as one thing instead of hunting them inside a router.
 */
import crypto from 'node:crypto';

export const MAX_BODY_BYTES = 16 * 1024;

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** PURE. Constant-time token equality: hash both sides, timingSafeEqual. */
export function tokenEquals(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  if (!presented || !expected) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** PURE. Extract the presented token: `Authorization: Bearer <t>` or ?token=. */
export function presentedToken(req, url) {
  const auth = req.headers?.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (m) return m[1].trim();
  return url.searchParams.get('token') || '';
}

/** PURE. True when the request carries the session token (constant-time). */
export function checkToken(req, url, token) {
  return tokenEquals(presentedToken(req, url), token);
}

/**
 * PURE. Origin validation: absent Origin is fine (curl, same-origin GET
 * navigations); a present Origin must be http://127.0.0.1 or http://localhost
 * — and, when the bound port is known, on exactly that port.
 */
export function checkOrigin(origin, port = null) {
  if (origin === undefined || origin === null || origin === '') return true;
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.protocol !== 'http:') return false;
  if (!LOCAL_HOSTNAMES.has(u.hostname)) return false;
  if (port !== null && port !== undefined) {
    const originPort = u.port ? Number(u.port) : 80;
    if (originPort !== Number(port)) return false;
  }
  return true;
}

/**
 * PURE. Host-header validation (DNS-rebinding defense): the Host must be a
 * localhost variant. Missing Host fails closed.
 */
export function checkHost(host) {
  if (!host) return false;
  let u;
  try { u = new URL(`http://${host}`); } catch { return false; }
  return LOCAL_HOSTNAMES.has(u.hostname);
}

// ---------------------------------------------------------------------------
// method matrix (security model point d)
// ---------------------------------------------------------------------------

/**
 * The ONLY write endpoints. Every other /api path is GET-only, and the runner
 * command is config-only, so no request can inject a command either way.
 */
export const WRITE_PATHS = new Set([
  '/api/runners/start', '/api/runners/stop',
  '/api/leases/claim', '/api/leases/release'
]);

/**
 * PURE. Is this method allowed on this /api path? Returns the `Allow` header
 * value and the 405 message alongside the verdict so the router stays a
 * dispatcher rather than a second copy of the rule.
 */
export function methodCheck(pathname, method) {
  const isWritePath = WRITE_PATHS.has(pathname);
  return {
    ok: isWritePath ? method === 'POST' : method === 'GET',
    allow: isWritePath ? 'POST' : 'GET',
    error: isWritePath ? 'method not allowed: use POST' : 'method not allowed: read-only endpoint (GET)'
  };
}

// ---------------------------------------------------------------------------
// response + body
// ---------------------------------------------------------------------------

export function sendJson(res, code, obj) {
  // No CORS headers — ever (security model point e).
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

/**
 * Read + parse a JSON POST body. Requires Content-Type application/json
 * (else 415); caps the body at `maxBytes` (else 413 — the remainder is
 * drained so the response can flush, with a hard cut against floods);
 * malformed JSON or a non-object top level → 400.
 * Resolves {ok:true, body} | {ok:false, code, error}; never rejects.
 */
export function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    const contentType = String(req.headers['content-type'] || '').trim();
    if (!/^application\/json\b/i.test(contentType)) {
      req.resume();
      return resolve({ ok: false, code: 415, error: 'unsupported media type: Content-Type must be application/json' });
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const settle = (r) => { if (!settled) { settled = true; resolve(r); } };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (settled) {
        if (size > maxBytes * 8) req.destroy(); // flood guard after the 413
        return;
      }
      if (size > maxBytes) return settle({ ok: false, code: 413, error: `payload too large (max ${maxBytes} bytes)` });
      chunks.push(chunk);
    });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return settle({ ok: false, code: 400, error: 'malformed JSON body' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return settle({ ok: false, code: 400, error: 'malformed JSON body: expected an object' });
      }
      settle({ ok: true, body });
    });
    req.on('error', () => settle({ ok: false, code: 400, error: 'request stream error' }));
  });
}
