/**
 * brain:stage-dirty — the POST-EDIT dirty-file staging hook (issue #35).
 *
 * Closes the staleness window at the SOURCE. ADR 0013 lazy-sync fixes the index
 * at the *next query*; #23 warns at consumption. This is the cheapest
 * complement: the instant a file is edited, stage its path in
 * `.project-brain/.dirty-files`. The next `brain:sync --if-stale` (post-commit,
 * opt-in) consumes the list for a TARGETED re-index of just those files —
 * bounded, no full-corpus cost — and the #23 banner stops firing for them.
 *
 * Runs on **PostToolUse** for `Edit|Write|MultiEdit`. Same fail-open discipline
 * as every other brain hook (CONTRIBUTING rule 3):
 *   - it ONLY appends a line — NO embedder load, NO store open, no re-index here;
 *   - malformed stdin, a missing brain dir, or any internal error → silent;
 *   - it ALWAYS exits 0 and NEVER blocks the tool call (errors go to stderr).
 *
 * The decision core — stagedPathsFromEnvelope() — is PURE and exported, so it
 * unit-tests with no disk, git, or model. Staging/normalisation reuses the
 * shared "which files changed" primitive in common.mjs (dirtyPathFor /
 * appendDirtyFile), the same list `brain:sync --if-stale` drains.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAIN_DIR, exists, dirtyPathFor, appendDirtyFile } from './common.mjs';

/**
 * PURE. Extract the normalised, stage-worthy repo-relative paths from a
 * PostToolUse envelope for Edit/Write/MultiEdit. Each of those tools carries a
 * single `tool_input.file_path`; anything else (or a path filtered out by
 * dirtyPathFor — vendored, generated, brain-internal, outside root) yields an
 * empty list. `opts.root` is forwarded to dirtyPathFor. Never touches disk.
 */
export function stagedPathsFromEnvelope(envelope = {}, opts = {}) {
  const tool = String(envelope?.tool_name || '');
  if (tool !== 'Edit' && tool !== 'Write' && tool !== 'MultiEdit') return [];
  const input = envelope?.tool_input || {};
  const out = [];
  const seen = new Set();
  for (const raw of [input.file_path]) {
    const rel = dirtyPathFor(raw, opts);
    if (rel && !seen.has(rel)) { seen.add(rel); out.push(rel); }
  }
  return out;
}

/** Read the PostToolUse envelope from stdin; TTY / empty / parse error → {}. */
function readStdin() {
  try {
    if (process.stdin.isTTY) return {};
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch { return {}; }
}

function main() {
  try {
    // No brain dir → nothing to keep fresh; do NOT litter one into a non-brain
    // repo. (acceptance: missing brain dir → exit 0, silent.)
    if (!exists(BRAIN_DIR)) return 0;
    const envelope = readStdin();
    for (const rel of stagedPathsFromEnvelope(envelope)) {
      appendDirtyFile(rel); // atomic + deduped (common.mjs)
    }
    return 0;
  } catch (err) {
    try { process.stderr.write(`[brain:stage-dirty] ${err?.message || err}\n`); } catch { /* ignore */ }
    return 0; // fail open — NEVER block a tool call
  }
}

// MANDATORY isMain guard: importing this module for tests must NOT run the CLI.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
