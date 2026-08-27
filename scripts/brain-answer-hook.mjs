/**
 * brain:answer as a PreToolUse hook — the AMBIENT delivery of the intelligence
 * `brain:answer` computes.
 *
 * The gap this closes: danger score, governing decisions, co-change blast
 * radius and lease conflicts all existed, but only ever reached a human in the
 * Control Room. An agent had to know to ask. This hook hands the agent the same
 * answer at the one moment it matters — the instant before it edits a file —
 * without any tool call (docs/strategy §Positionierung: "das Brain konsultiert
 * sich selbst per Hooks, der Agent muss kein Tool aufrufen").
 *
 * Contract (decisions/0026, mirrored EXACTLY — never invented here):
 *   stdin  : the PreToolUse hook envelope as JSON
 *   stdout : {"hookSpecificOutput":{"hookEventName":"PreToolUse",
 *             "additionalContext":"<text>"}}   ← context ONLY
 *   exit   : ALWAYS 0
 * We emit no `permissionDecision`, so this hook is structurally incapable of
 * blocking an edit. buildPreToolPayload() is imported from brain-route-tool.mjs
 * rather than re-implemented, so the two ambient hooks can never drift apart.
 *
 * Fail-open on EVERYTHING (no stdin, malformed JSON, no .project-brain, git
 * absent, a broken record): silent exit 0. An ambient hook that breaks an edit
 * is worse than no hook at all.
 *
 * Cost discipline (decisions/0024): the injected text is capped at
 * BUDGETS.answerBytes (~700 B ≈ 175 tok) and deduped per session per file, so a
 * long editing session pays for the answer roughly once per file, not per edit.
 * Opt out entirely with BRAIN_ANSWER_HOOK=0; disable dedupe with
 * BRAIN_ANSWER_DEDUPE=0.
 *
 * Speed: budgeted < 300 ms. No embedder, no store, no `gh`, no `git` spawn on a
 * warm cache — the commit window is cached by HEAD in
 * `.project-brain/.answer-cache.json` (gitignored) and HEAD itself is read from
 * `.git/HEAD` instead of spawning `git rev-parse`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAIN_DIR, ROOT, exists, read, atomicWrite, sha256 } from './common.mjs';
import { buildPreToolPayload } from './brain-route-tool.mjs';
import { answerFor, renderAnswer, answerBudgetBytes } from './brain-answer.mjs';

/** Short banner so the agent knows WHY this text appeared mid-turn. Counted against the budget. */
export const ANSWER_HEADER = 'Project Brain (ambient, deterministic) — before you edit:';

/** ~15 min, matching the tool-nudge TTL: a compaction can drop the context, so re-surface. */
export const ANSWER_TTL_MS = 15 * 60 * 1000;
/** Shared with the prompt/tool hooks — ONE state file, namespaced (decisions/0026). */
const HOOK_STATE_FILE = path.join(BRAIN_DIR, '.route-hook-state.json');
/** Bound the per-session map so a long session cannot grow the state file without limit. */
const MAX_TRACKED_FILES = 40;

// ---------------------------------------------------------------------------
// Pure: envelope → target files
// ---------------------------------------------------------------------------

/**
 * PURE. The file path(s) an Edit/Write/MultiEdit envelope targets. Tolerates the
 * snake_case and camelCase envelope spellings (same as brain-lint-conventions).
 * Anything else → [] (the hook then exits silently).
 */
export function targetFiles(envelope = {}) {
  const tool = String(envelope?.tool_name || envelope?.toolName || '');
  if (!['Edit', 'Write', 'MultiEdit'].includes(tool)) return [];
  const input = envelope?.tool_input || envelope?.toolInput || {};
  const p = String(input.file_path || input.filePath || '').trim();
  return p ? [p] : [];
}

// ---------------------------------------------------------------------------
// Pure: session dedupe
// ---------------------------------------------------------------------------

/**
 * PURE dedupe decision. Emit when: no prior state, a NEW session, this file has
 * not been answered yet, the TTL lapsed, or the ANSWER ITSELF CHANGED (a lease
 * appeared, the danger score moved) — a changed answer is new information and
 * must not be suppressed. Otherwise: suppress.
 */
export function shouldEmitAnswer(prev, { sessionId, fileKey, hash, now }, ttlMs = ANSWER_TTL_MS) {
  if (!fileKey) return false;
  const st = prev && typeof prev === 'object' ? prev.answerNudges : null;
  if (!st || typeof st !== 'object') return true;
  if (st.sessionId !== sessionId) return true;
  const entry = st.files && st.files[fileKey];
  if (!entry || typeof entry !== 'object') return true;
  if (entry.hash !== hash) return true;
  const ts = Number(entry.ts);
  if (!Number.isFinite(ts)) return true;
  return Number(now) - ts >= ttlMs;
}

/** PURE. Merge this emission into the answerNudges sub-object (session change resets it). */
export function recordAnswer(prevNudges, { sessionId, fileKey, hash, now }) {
  const same = prevNudges && typeof prevNudges === 'object' && prevNudges.sessionId === sessionId;
  const files = same && prevNudges.files && typeof prevNudges.files === 'object' ? { ...prevNudges.files } : {};
  files[fileKey] = { ts: now, hash };
  const keys = Object.keys(files);
  if (keys.length > MAX_TRACKED_FILES) {
    // Drop the oldest entries — deterministic (ts, then key) so tests are stable.
    keys.sort((a, b) => (Number(files[a].ts) || 0) - (Number(files[b].ts) || 0) || (a < b ? -1 : 1));
    for (const k of keys.slice(0, keys.length - MAX_TRACKED_FILES)) delete files[k];
  }
  return { sessionId, files };
}

/** Read the shared hook state; corrupt/absent → null (fail open). */
function readHookState() {
  try { return exists(HOOK_STATE_FILE) ? JSON.parse(read(HOOK_STATE_FILE)) : null; }
  catch { return null; }
}

/** Merge a patch into the shared hook state, preserving the other hooks' keys. Best-effort. */
function writeHookStatePatch(patch) {
  try {
    const cur = readHookState() || {};
    atomicWrite(HOOK_STATE_FILE, JSON.stringify({ ...cur, ...patch }));
  } catch { /* soft — never block an edit */ }
}

// ---------------------------------------------------------------------------
// Hook entry point — ALWAYS exit 0.
// ---------------------------------------------------------------------------

/** Read the PreToolUse envelope from stdin; TTY / empty / parse error → null. */
function readStdin() {
  try {
    if (process.stdin.isTTY) return null;
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

async function main() {
  try {
    if (process.env.BRAIN_ANSWER_HOOK === '0') return 0;  // explicit opt-out

    const envelope = readStdin();
    if (!envelope) return 0;                               // no/!json stdin → silent
    const files = targetFiles(envelope);
    if (!files.length) return 0;                           // not an edit → silent

    // Cheapest possible gate: no brain in this repo → do nothing at all.
    if (!fs.existsSync(BRAIN_DIR)) return 0;

    const now = Date.now();
    // The banner is part of what the user pays for, so it comes OUT of the
    // budget — the whole injected string stays ≤ BUDGETS.answerBytes.
    const headerBytes = Buffer.byteLength(`${ANSWER_HEADER}\n`, 'utf8');
    const budgetBytes = Math.max(1, answerBudgetBytes() - headerBytes);
    const { inputs, answer } = await answerFor(files, { root: ROOT, now, budgetBytes });
    const body = renderAnswer(answer);
    if (!body) return 0;                                   // nothing notable → stay quiet

    const text = `${ANSWER_HEADER}\n${body}`.trimEnd();

    if (process.env.BRAIN_ANSWER_DEDUPE !== '0') {
      const sessionId = String(envelope.session_id || envelope.sessionId || '');
      const fileKey = (inputs.files || []).join(',') || files.join(',');
      const hash = sha256(text).slice(0, 16);
      const state = readHookState();
      if (!shouldEmitAnswer(state, { sessionId, fileKey, hash, now })) return 0;
      writeHookStatePatch({ answerNudges: recordAnswer(state?.answerNudges, { sessionId, fileKey, hash, now }) });
    }

    const payload = buildPreToolPayload(text);
    if (payload) process.stdout.write(payload);
    return 0;
  } catch (err) {
    try { process.stderr.write(`[brain:answer-hook] ${err?.message || err}\n`); } catch { /* ignore */ }
    return 0; // fail open — NEVER break an edit
  }
}

// MANDATORY isMain guard: importing this module for tests must NOT run the CLI.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code)).catch(() => process.exit(0));
}
