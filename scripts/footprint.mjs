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
 * Evaluate a footprint against thresholds → human-readable warnings. PURE.
 * @param {object} fp  { skills:[measureFile], activeState:measureFile, hooks:[measureHook] }
 */
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
  for (const h of fp.hooks || []) {
    if (h && h.tokens > thresholds.hookTokens) {
      warnings.push(
        `route --hook --event ${h.event} ≈ ${h.tokens} tok (> ${thresholds.hookTokens} warn) — injected on every ${h.event}`
      );
    }
  }
  return warnings;
}
