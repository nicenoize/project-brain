/**
 * Context-footprint measurement (decisions/0024) — the brain injects text into
 * every Claude session (SessionStart / UserPromptSubmit hooks, SKILL.md on skill
 * activation, pack output) but historically never measured its own token cost.
 *
 * This module holds the PURE, unit-testable logic (token estimate + threshold
 * evaluation); the I/O helpers (stat a file, spawn a hook) are thin and kept
 * here too so brain-health can assemble the report without duplicating them.
 *
 * NOTE (real-consumer finding, #21): the SessionStart surface cats
 * `.project-brain/active_state.md` RAW into context on every session. In the dev
 * repo that is ~110 tok; in a real multi-actor consumer it was measured at
 * ~7,555 tok — ~12× the warn threshold. The footprint therefore measures the
 * active_state FILE (the raw-cat cost) as well as the route hook's own stdout.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Warn thresholds. File limits are in estimated tokens; the hook limit is in
// tokens too (its stdout is injected verbatim on every event).
export const FOOTPRINT_THRESHOLDS = {
  skillTokens: 4000, // SKILL.md is injected on every skill activation
  activeStateTokens: 600, // active_state.md is cat'd raw into SessionStart context
  hookTokens: 500 // route --hook stdout is injected on every event
};

// Pack budget default (mirrors brain-pack.mjs). Env override wins.
export const PACK_MAX_TOKENS_DEFAULT = 2600;

// Hard byte BUDGETS (docs/strategy-agent-ops.md §2b „Budgets als CI-Test“) —
// distinct from the advisory warn thresholds above. Budgets are CI-ENFORCED:
// tests/footprint-budget.test.mjs turns a breach into a red build, and
// brain:health's footprint audit warns over the same constants (single source
// of numbers — docs cite these too). Measured in BYTES because bytes are what
// ship over the wire; tokens follow via the same len/4 heuristic
// (12000 B ≈ 3k tok, 8000 B ≈ 2k tok).
export const BUDGETS = {
  // SKILL.md core — injected on every skill activation; detail belongs in references/*.md.
  skillBytes: 12000,
  // SessionStart state digest (brain-state-digest.mjs stdout) — replaces the
  // historical raw `cat active_state.md` (≈30 kB ≈ 7.5k tok in the field, see
  // header note + decisions/0024).
  stateDigestBytes: 8000,
  // brain:answer / the PreToolUse answer hook (brain-answer-hook.mjs stdout) —
  // the AMBIENT per-EDIT injection, so it is the most frequently paid surface
  // the brain has: budgeted an order of magnitude below the once-per-session
  // digest above. 700 B ≈ 175 tok. Enforced by tests/brain-answer.test.mjs;
  // BRAIN_ANSWER_BUDGET_BYTES overrides it per process.
  answerBytes: 700,

  // --- LATENCY budgets (milliseconds) -------------------------------------
  // The byte budgets above are exact: a file either is or is not 12001 bytes.
  // These are NOT. A millisecond reading on shared CI hardware is a wall-clock
  // sample from a box we do not control, and one descheduling multiplies it.
  // So these numbers are deliberately blunt: they exist to catch an
  // ORDER-OF-MAGNITUDE regression — an accidental O(n²), a sync read pulled
  // into a loop, a cache that stopped caching — and nothing finer. Percent-
  // level drift is scripts/bench.mjs --against's job, where both readings come
  // from the same machine and the noise band is measured rather than assumed.
  //
  // HEADROOM: each budget is ~15-20× the median measured on the dev machine
  // (Apple M4 Pro, node 24, this repo — see .project-brain/bench-baseline.json
  // for the reading these were derived from). That factor is not timidity, it
  // is the price of the test being trustworthy: a perf test that goes red when
  // CI is merely busy gets muted within a week, and a muted test protects
  // nothing. A 15× breach is not noise on any machine — it is a bug.
  // Enforced by tests/bench-budget.test.mjs, which additionally SKIPS (never
  // fails) when the machine proves itself too loaded to measure on.

  // First /api/state call against a fresh in-process daemon — the read behind
  // every Control-Room page load. Measured ≈5 ms cold.
  apiStateMs: 100,
  // brain-answer-hook.mjs end-to-end, spawn included — the ambient per-EDIT
  // latency every agent pays. Measured ≈58 ms, most of it node startup, which
  // is exactly the part a loaded CI box inflates.
  answerHookMs: 1000,
  // buildImportGraph over the repo's git source set — the scan behind
  // /api/blast, /api/graph and brain:impact. Measured ≈83 ms for 220 files.
  importScanMs: 1500
};

/** Resolve the state-digest byte budget — BRAIN_STATE_DIGEST_BUDGET_BYTES env override wins. PURE given env. */
export function stateDigestBudgetBytes(env = process.env) {
  const n = Number(env && env.BRAIN_STATE_DIGEST_BUDGET_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : BUDGETS.stateDigestBytes;
}

/** Rough token estimate: 1 token ≈ 4 bytes (len/4). PURE. */
export function estimateTokens(bytes) {
  const n = Number(bytes);
  return Number.isFinite(n) && n > 0 ? Math.round(n / 4) : 0;
}

/** Byte size + token estimate for a file (missing → { exists:false }). */
export function measureFile(abs, rel) {
  try {
    if (!abs || !fs.existsSync(abs)) return { file: rel, exists: false, bytes: 0, tokens: 0 };
    const bytes = fs.statSync(abs).size;
    return { file: rel, exists: true, bytes, tokens: estimateTokens(bytes) };
  } catch {
    return { file: rel, exists: false, bytes: 0, tokens: 0 };
  }
}

/**
 * Spawn `node <routeScript> --hook --event <event>` and measure its stdout. The
 * hook path is model-free and always exits 0, so this is cheap and safe. Errors
 * degrade to a zero-byte reading with an `error` note (never throws).
 */
export function measureHook(routeScript, event, cwd) {
  try {
    const r = spawnSync(process.execPath, [routeScript, '--hook', '--event', event], {
      cwd,
      encoding: 'utf8',
      timeout: 20000,
      // Measure the RAW per-event payload, not the deduped runtime behaviour —
      // the audit reports what a fresh injection costs (decisions/0024 dedupe
      // would otherwise zero out the second event, which shares session id '').
      // BRAIN_USAGE_LOG=0: this route spawn is a measurement, not a real
      // invocation — it must not pollute the usage ledger (#32) it feeds.
      env: { ...process.env, BRAIN_HOOK_DEDUPE: '0', BRAIN_USAGE_LOG: '0' }
    });
    const out = String(r.stdout || '');
    const bytes = Buffer.byteLength(out, 'utf8');
    return { event, bytes, tokens: estimateTokens(bytes), status: r.status ?? null };
  } catch (err) {
    return { event, bytes: 0, tokens: 0, status: null, error: String((err && err.message) || err) };
  }
}

/**
 * Measure the PreToolUse answer hook (scripts/brain-answer-hook.mjs): what a
 * single edit-time injection actually costs. Driven with a synthetic Edit
 * payload on stdin and dedupe disabled, so the reading is the raw per-edit
 * cost, not the deduped runtime behaviour — same discipline as measureHook.
 * Never throws; a missing hook degrades to a zero reading with a note.
 */
export function measureAnswerHook(hookScript, filePath, cwd) {
  try {
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: filePath }
    });
    const r = spawnSync(process.execPath, [hookScript], {
      cwd,
      input: payload,
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, BRAIN_ANSWER_DEDUPE: '0', BRAIN_USAGE_LOG: '0' }
    });
    const out = String(r.stdout || '');
    // The wire payload carries JSON envelope bytes; what lands in the agent's
    // context is additionalContext, so report both and budget against the
    // injected string (that is what the user pays for).
    let injected = out;
    try {
      const parsed = JSON.parse(out);
      injected = parsed?.hookSpecificOutput?.additionalContext ?? '';
    } catch { /* non-JSON (empty) output measures as itself */ }
    const bytes = Buffer.byteLength(injected, 'utf8');
    return {
      event: 'pretooluse-answer',
      file: filePath,
      bytes,
      wireBytes: Buffer.byteLength(out, 'utf8'),
      tokens: estimateTokens(bytes),
      status: r.status ?? null
    };
  } catch (err) {
    return { event: 'pretooluse-answer', file: filePath, bytes: 0, wireBytes: 0, tokens: 0, status: null, error: String((err && err.message) || err) };
  }
}

/**
 * Evaluate a footprint against thresholds → human-readable warnings. PURE.
 * @param {object} fp  { skills:[measureFile], activeState:measureFile, hooks:[measureHook] }
 */
/**
 * Measure the instruction chain that shares the session context with us:
 * CLAUDE.md and every file it pulls in with an `@import` line.
 *
 * WHY THIS BELONGS IN OUR AUDIT. The footprint report answers "how many tokens
 * does the brain inject", and it answered it correctly — and left the reader
 * with no way to judge the number. On this machine the brain measured ≈2,890
 * tokens a session while the CLAUDE.md chain beside it measured ≈23,900:
 * eight times as much, in the same context window, invisible to the tool whose
 * whole job is context discipline. Worse, a 427-byte digest was blamed for a
 * 12,957-token problem because nobody had measured the neighbours.
 *
 * REPORTED, NEVER GATED. These files are not ours — they belong to the user or
 * to another framework, and failing a build over someone else's instructions
 * would be arrogant. The number is shown so a person can decide.
 *
 * @param {string} claudeMd  absolute path to a CLAUDE.md
 * @returns {{root: object|null, imports: object[], totalBytes: number, totalTokens: number}}
 */
export function measureInstructionChain(claudeMd) {
  const rel = (abs) => path.basename(abs);
  const root = measureFile(claudeMd, rel(claudeMd));
  if (!root.exists) return { root: null, imports: [], totalBytes: 0, totalTokens: 0 };
  const dir = path.dirname(claudeMd);
  let text = '';
  try { text = fs.readFileSync(claudeMd, 'utf8'); } catch { text = ''; }
  const seen = new Set([path.resolve(claudeMd)]);
  const imports = [];
  // `@FILE.md` on its own line is the import form; anything else is prose.
  for (const m of text.matchAll(/^@([A-Za-z0-9._/-]+\.md)\s*$/gm)) {
    const abs = path.resolve(dir, m[1]);
    if (seen.has(abs)) continue;          // an import cycle must not double-count
    seen.add(abs);
    const f = measureFile(abs, m[1]);
    if (f.exists) imports.push(f);
  }
  const all = [root, ...imports];
  const totalBytes = all.reduce((n, f) => n + (f.bytes || 0), 0);
  return { root, imports, totalBytes, totalTokens: estimateTokens(totalBytes) };
}

export function footprintWarnings(fp = {}, thresholds = FOOTPRINT_THRESHOLDS) {
  const warnings = [];
  for (const s of fp.skills || []) {
    if (s && s.exists && s.tokens > thresholds.skillTokens) {
      warnings.push(
        `${s.file} ≈ ${s.tokens} tok (> ${thresholds.skillTokens} warn) — injected on every skill activation; keep the core lean, move detail into references/*.md`
      );
    }
  }
  const as = fp.activeState;
  if (as && as.exists && as.tokens > thresholds.activeStateTokens) {
    warnings.push(
      `${as.file} ≈ ${as.tokens} tok (> ${thresholds.activeStateTokens} warn) — cat'd RAW into context on every SessionStart; prune it or emit a bounded digest (decisions/0024)`
    );
  }
  // Hard-budget breaches — evaluated only when the caller passes fp.budgets
  // (brain-health passes BUDGETS). Still advisory here (health never fails on
  // footprint); the red-build enforcement of the SAME numbers lives in
  // tests/footprint-budget.test.mjs.
  if (fp.budgets) {
    for (const s of fp.skills || []) {
      if (s && s.exists && s.bytes > fp.budgets.skillBytes) {
        warnings.push(
          `${s.file} = ${s.bytes} B (> ${fp.budgets.skillBytes} B HARD budget) — tests/footprint-budget.test.mjs fails CI on this; slim the core, move detail into references/*.md`
        );
      }
    }
  }
  for (const h of fp.hooks || []) {
    if (h && h.tokens > thresholds.hookTokens) {
      warnings.push(
        `route --hook --event ${h.event} ≈ ${h.tokens} tok (> ${thresholds.hookTokens} warn) — injected on every ${h.event}`
      );
    }
  }
  return warnings;
}
