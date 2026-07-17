/**
 * Deterministic friction sensors (issue #28) — the QUALITY-event instrument,
 * sibling to the usage ledger (#32, the QUANTITY instrument). Where the ledger
 * answers "how often / how big", this answers "what went wrong": a brain command
 * observes its OWN friction — a non-zero exit, an oversize stdout payload, or a
 * truncation fired by the hook byte cap (#22) — and records each distinct event
 * class as a `finding` (category dx) so it surfaces in the act axis
 * (`brain:improve status/next`). No LLM, no relevance judgement — pure
 * self-observation that feeds the improve backlog.
 *
 * Default-off behind BRAIN_FRICTION_LOG=1: when unset there is ZERO overhead and
 * ZERO writes — the instrument is never even armed (common.mjs only lazy-loads
 * this module when the flag is on). Fail-silent sidecar: it must never break or
 * slow a command. Writes route through findings.upsertFinding (the owning
 * recorder), so this module never references a findings/ path itself and
 * record-folder discipline (the #20 sidecar rule) holds.
 *
 * Layers:
 *   - PURE core (env/threshold gates, event classification, dedupe, finding
 *     construction) — unit-tested with no store.
 *   - A tiny in-memory event queue so a producer (e.g. the route hook) can SIGNAL
 *     a truncation with `noteFriction()` — a no-op with zero allocation when off.
 *   - `flushFriction()` merges queued + exit-derived events, dedupes, and upserts
 *     one finding per class. `instrumentFriction()` arms it on process exit; that
 *     is the single choke point common.mjs wires up.
 */
import { createRequire } from 'node:module';
import { slugify } from './common.mjs';
import { usageCmdFromScript } from './usage.mjs';

// findings.mjs is loaded LAZILY (createRequire) at first write, NOT statically.
// A static friction→findings import would evaluate findings.mjs — which reads
// BRAIN_DIR at module top — during common.mjs's OWN initialization (common
// eagerly imports this instrument), before BRAIN_DIR exists → a TDZ crash. By
// flush time common.mjs is fully initialized, so require() resolves the same
// module instance with no cycle. Cached after the first resolve.
let _upsertFinding = null;
function upsertFindingLazy(rec, opts) {
  if (!_upsertFinding) _upsertFinding = createRequire(import.meta.url)('./findings.mjs').upsertFinding;
  return _upsertFinding(rec, opts);
}

export const FRICTION_KINDS = ['error-exit', 'oversize-output', 'truncation'];

// Default oversize threshold: stdout larger than this (bytes) is treated as a
// context-footprint friction event. ≈5k tokens — well above a normal command's
// output, so only genuinely bloated payloads trip it. Tunable per repo.
export const FRICTION_OVERSIZE_BYTES_DEFAULT = 20000;

const IMPACT_BY_KIND = { 'error-exit': 3, 'oversize-output': 2, 'truncation': 2 };

/** Is the friction instrument enabled? PURE (env-injectable for tests). */
export function frictionEnabled(env = process.env) {
  return env.BRAIN_FRICTION_LOG === '1';
}

/** Oversize-output byte threshold, env-overridable. PURE. */
export function frictionOversizeBytes(env = process.env) {
  const v = Number(env.BRAIN_FRICTION_OVERSIZE_BYTES);
  return Number.isFinite(v) && v > 0 ? v : FRICTION_OVERSIZE_BYTES_DEFAULT;
}

/** Deterministic slug for a friction event — one file per (kind, cmd). PURE. */
export function frictionSlug(event = {}) {
  return slugify(`friction ${event.kind || 'unknown'} ${event.cmd || 'unknown'}`);
}

/** Dedupe key for an event class (kind + command). PURE. */
export function frictionEventKey(event = {}) {
  return `${event.kind || 'unknown'}:${event.cmd || 'unknown'}`;
}

/**
 * Derive friction events from a finished command's exit signature. PURE.
 * A non-zero exit → an `error-exit` event; stdout over the threshold → an
 * `oversize-output` event. No `cmd` (worker / test runner) → no events.
 */
export function classifyExitEvents({ cmd, exitCode = 0, stdoutBytes = 0, oversizeBytes } = {}) {
  const c = String(cmd || '').trim();
  const events = [];
  if (!c) return events;
  const limit = Number.isFinite(oversizeBytes) && oversizeBytes > 0 ? oversizeBytes : frictionOversizeBytes();
  if (Number(exitCode) !== 0) {
    events.push({ kind: 'error-exit', cmd: c, exitCode: Number(exitCode) || 0 });
  }
  if (Number(stdoutBytes) > limit) {
    events.push({ kind: 'oversize-output', cmd: c, bytes: Math.round(Number(stdoutBytes)), threshold: limit });
  }
  return events;
}

/** Collapse events to one per class (first wins). PURE — the in-process dedupe. */
export function dedupeFrictionEvents(events = []) {
  const seen = new Map();
  for (const ev of events) {
    if (!ev || !ev.kind) continue;
    const key = frictionEventKey(ev);
    if (!seen.has(key)) seen.set(key, ev);
  }
  return [...seen.values()];
}

/** Human title for a friction finding. PURE. */
function frictionTitle(event = {}) {
  const cmd = event.cmd || 'unknown';
  switch (event.kind) {
    case 'error-exit': return `Command friction: brain:${cmd} exits non-zero`;
    case 'oversize-output': return `Command friction: brain:${cmd} output is oversize`;
    case 'truncation': return `Command friction: brain:${cmd} output was truncated`;
    default: return `Command friction: brain:${cmd}`;
  }
}

/** Evidence body for a friction finding (deterministic, no LLM). PURE. */
function frictionBody(event = {}, now) {
  const cmd = event.cmd || 'unknown';
  const lines = [
    '## Friction event (auto-observed)',
    '',
    `- command: \`brain:${cmd}\``,
    `- kind: ${event.kind || 'unknown'}`,
    `- last seen: ${now}`
  ];
  if (event.kind === 'error-exit') {
    lines.push(`- exit code: ${event.exitCode}`);
    lines.push('', 'The command exited non-zero. Reproduce it, then either fix the failure or make the error path explicit / recoverable.');
  } else if (event.kind === 'oversize-output') {
    lines.push(`- stdout: ${event.bytes} bytes (> ${event.threshold} byte threshold)`);
    lines.push('', 'The command emitted an oversize payload — a context-footprint cost on every run. Consider a leaner default output or a `--json`/summary mode (token-lean outputs, #21/#22).');
  } else if (event.kind === 'truncation') {
    lines.push(event.detail ? `- detail: ${event.detail}` : '- detail: output exceeded a hard byte cap and was truncated');
    lines.push('', 'A guard truncated this output. Truncation means the consumer saw an incomplete payload — trim the source or raise the cap deliberately.');
  }
  lines.push('', '_Recorded by the deterministic friction sensor (BRAIN_FRICTION_LOG=1, issue #28)._');
  return lines.join('\n');
}

/**
 * Build a `finding` record object for a friction event. PURE (no I/O). The slug
 * is deterministic per event class, so upsertFinding dedupes to a single file.
 */
export function buildFrictionFinding(event = {}, { now = new Date().toISOString() } = {}) {
  const cmd = String(event.cmd || 'unknown');
  return {
    slug: frictionSlug(event),
    title: frictionTitle(event),
    category: 'dx',
    status: 'open',
    impact: IMPACT_BY_KIND[event.kind] || 2,
    module: `brain:${cmd}`,
    symbols: [],
    sources: [],
    actor: 'friction-sensor',
    body: frictionBody(event, now)
  };
}

/** Write one friction event as a deduped finding. `opts.dir` is injectable for tests. */
export function recordFrictionEvent(event, opts = {}) {
  const now = opts.now || new Date().toISOString();
  return upsertFindingLazy(buildFrictionFinding(event, { now }), { dir: opts.dir, now });
}

// --- In-memory event queue --------------------------------------------------
// Producers (the route hook byte cap, a graph guard) call noteFriction() to
// signal an event that can't be inferred from the exit signature. The queue is
// per-process and drained at exit. Gated: a no-op with no allocation when off.

let queue = [];

/** Signal a friction event from a producer. No-op (and no allocation) when off. */
export function noteFriction(event, env = process.env) {
  if (!frictionEnabled(env)) return false;
  if (!event || !event.kind) return false;
  queue.push({ ...event });
  return true;
}

/** Drain + reset the queue (also used by tests to assert queue behaviour). */
export function drainFrictionQueue() {
  const out = queue;
  queue = [];
  return out;
}

/**
 * Merge queued + exit-derived events, dedupe to one per class, and upsert a
 * finding for each. Never throws — each event is best-effort. Returns the
 * upsert results. `opts.dir` is injectable for tests.
 */
export function flushFriction({ cmd, exitCode = 0, stdoutBytes = 0, dir, now } = {}) {
  const stamp = now || new Date().toISOString();
  const events = dedupeFrictionEvents([
    ...drainFrictionQueue(),
    ...classifyExitEvents({ cmd, exitCode, stdoutBytes })
  ]);
  const written = [];
  for (const ev of events) {
    try {
      written.push(recordFrictionEvent(ev, { dir, now: stamp }));
    } catch {
      // Observation is never load-bearing — one bad event must not sink the rest.
    }
  }
  return written;
}

let frictionInstrumented = false;

/**
 * THE exit choke point. When BRAIN_FRICTION_LOG=1, instrument the current
 * brain:* process so friction events are flushed to findings on exit. Registered
 * SYNCHRONOUSLY (before the command's main() runs) so a process.exit(1) failure
 * is still captured. Returns whether it armed.
 *
 * Guarantees: returns immediately (no listeners, no stdout wrapping, no writes)
 * when the flag is off or the entry point is not a recognised brain-*.mjs command
 * (so embed/aggregate workers and the test runner are never instrumented).
 */
export function instrumentFriction(argv = process.argv) {
  if (!frictionEnabled()) return false;
  if (frictionInstrumented) return false;
  const cmd = usageCmdFromScript(argv && argv[1]);
  if (!cmd) return false;
  frictionInstrumented = true;

  let stdoutBytes = 0;
  try {
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, enc, cb) => {
      try {
        stdoutBytes += Buffer.byteLength(chunk, typeof enc === 'string' ? enc : 'utf8');
      } catch { /* non-buffer/odd chunk — ignore in the counter only */ }
      return orig(chunk, enc, cb);
    };
  } catch { /* stdout not writable/patchable — still flush with stdoutBytes=0 */ }

  process.on('exit', (code) => {
    try {
      flushFriction({ cmd, exitCode: code, stdoutBytes });
    } catch { /* best-effort — never let self-observation break the process */ }
  });
  return true;
}
