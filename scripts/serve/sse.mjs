/**
 * serve/sse.mjs — the /api/stream change feed: fs watchers, debounce, the
 * connected-client set and the heartbeat.
 *
 * One hub per daemon (createSseHub), because all of it is shared mutable state
 * that a second daemon in the same process must not inherit — which is exactly
 * why it cannot be module-level. Watching is best-effort by design: an
 * unsupported fs.watch leaves the stream serving heartbeats rather than
 * failing the connection, and .project-brain/runners/ gets its own explicit
 * watcher because fs.watch recursion is platform-dependent.
 */
import fs from 'node:fs';
import path from 'node:path';

const SSE_DEBOUNCE_MS = 300;
const SSE_HEARTBEAT_MS = 25_000;

/**
 * @returns {{ensureRunnersWatcher: Function, handleStream: Function, close: Function}}
 *   `ensureRunnersWatcher` is the hook a write endpoint calls after it may
 *   have created runners/; `close` tears down timers, watchers and clients.
 */
export function createSseHub({ brainDir, runnersDir }) {
  const sseClients = new Set();
  let watcher = null;
  let runnersWatcher = null;
  let pendingFiles = new Set();
  let flushTimer = null;

  function broadcast(payload) {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) res.write(frame);
  }

  function queueChange(file) {
    pendingFiles.add(file || '');
    if (flushTimer) return; // debounce: one flush per quiet window
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const files = [...pendingFiles];
      pendingFiles = new Set();
      for (const f of files) broadcast({ type: 'state-changed', file: f });
    }, SSE_DEBOUNCE_MS);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
  }

  // fs.watch recursion is platform-dependent (darwin: yes; elsewhere: maybe
  // not), so runner record changes get their own explicit watcher. Guarded:
  // the dir may not exist yet — retried on every brainDir event, stream
  // connection, and successful runner start.
  function ensureRunnersWatcher() {
    if (runnersWatcher || !fs.existsSync(runnersDir)) return;
    try {
      runnersWatcher = fs.watch(runnersDir, (_event, file) =>
        queueChange(file ? `runners/${file}` : 'runners'));
    } catch {
      runnersWatcher = null;
    }
  }

  function ensureWatcher() {
    ensureRunnersWatcher();
    if (watcher || !fs.existsSync(brainDir)) return;
    try {
      watcher = fs.watch(brainDir, { recursive: true }, (_event, file) => {
        ensureRunnersWatcher(); // runners/ may have appeared after connect
        // Normalize separators so an event seen by both watchers dedupes.
        queueChange(file ? String(file).split(path.sep).join('/') : '');
      });
    } catch {
      watcher = null; // watch unsupported → stream still serves heartbeats
    }
  }

  function handleStream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff'
    });
    res.write(': connected\n\n');
    ensureWatcher();
    sseClients.add(res);
    const heartbeat = setInterval(() => { res.write(': heartbeat\n\n'); }, SSE_HEARTBEAT_MS);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();
    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
  }

  function close() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (watcher) { try { watcher.close(); } catch {} watcher = null; }
  if (runnersWatcher) { try { runnersWatcher.close(); } catch {} runnersWatcher = null; }
  for (const res of sseClients) { try { res.end(); } catch {} }
  sseClients.clear();
  }

  return { ensureRunnersWatcher, handleStream, close };
}
