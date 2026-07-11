/**
 * brain:route --tool-hook surface — the TOOL-TIME ambient nudge (decisions/0026).
 *
 * ADR 0023 made routing ambient at PROMPT time (UserPromptSubmit / SessionStart).
 * This is its tool-time sibling: a fail-open `PreToolUse` hook that nudges the
 * agent toward `brain:search`/`brain:ask` when it is about to `grep`/`find`/raw
 * `Read` something a FRESH index answers better. It NEVER blocks the tool call —
 * it only injects `additionalContext` and ALWAYS exits 0 (CONTRIBUTING rule 3).
 *
 * Provenance: graphify's `_run_hook_guard` (fail-open + never-block discipline).
 *
 * Hot-path discipline (issue #17): stat-level freshness/existence only — NO
 * embedder load, NO store open. The decision cores — looksLikeRawSearch(),
 * looksLikeRawSourceRead(), classifyToolNudge(), shouldNudge() — are PURE and
 * exported, so they unit-test with no index, git, or model. Malformed stdin and
 * a missing/stale index both fall through to a silent exit 0 (tested).
 *
 * Dedup reuses the SINGLE `.project-brain/.route-hook-state.json` store that #22
 * added for the prompt hook (issue #17 coordination note: one store, keyed by
 * pattern class) — under a `toolNudges` namespace so the two hooks never clobber
 * each other's state.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAIN_DIR, exists, read, atomicWrite, takeOption } from './common.mjs';
import { capHookText } from './brain-route.mjs';

// ---------------------------------------------------------------------------
// Matcher heuristics (PURE, exported, unit-tested).
// ---------------------------------------------------------------------------

// Content-search binaries that recurse the tree (rg/ag/ack default-recursive;
// grep-family needs a recursive flag or a path arg — see grepSearchesFiles()).
const CONTENT_SEARCH = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ripgrep', 'ag', 'ack', 'ack-grep']);
// Command wrappers to peel off before reading the real command word.
const WRAPPER_RE = /^(sudo|command|time|nice|env|xargs|exec|stdbuf|nohup)\b\s+/;
// A leading NAME=value environment assignment (possibly several).
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+/;

/**
 * Split a shell command line into pipeline segments, remembering whether each
 * segment is fed by a `|` (i.e. reads STDIN — a `grep` there filters command
 * output, not the repo, so it is NOT a raw code search). Handles `| || && ; &`.
 * PURE.
 */
function splitPipeline(cmd) {
  const parts = [];
  const re = /(\|\||&&|\||;|&(?!&))/g;
  let last = 0, prevOp = '', m;
  while ((m = re.exec(cmd))) {
    parts.push({ text: cmd.slice(last, m.index), afterPipe: prevOp === '|' });
    prevOp = m[1];
    last = m.index + m[1].length;
  }
  parts.push({ text: cmd.slice(last), afterPipe: prevOp === '|' });
  return parts;
}

/** First real command word of a segment: peel env assignments + wrappers, strip any dir prefix. PURE. */
function firstWord(seg) {
  let s = String(seg || '').trim();
  let guard = 0;
  while (guard++ < 8) {
    const before = s;
    s = s.replace(ENV_ASSIGN_RE, '').replace(WRAPPER_RE, '');
    if (s === before) break;
  }
  const first = s.split(/\s+/)[0] || '';
  return first.replace(/.*\//, ''); // /usr/bin/grep → grep
}

/** Does a grep-family segment actually search files (recursive flag OR a path arg)? PURE. */
function grepSearchesFiles(segText) {
  // recursive: a short single-dash flag cluster containing r/R, or a long form.
  if (/(^|\s)-(?!-)[A-Za-z]*[rR][A-Za-z]*(?=\s|$)/.test(segText)) return true;
  if (/--recursive\b|--include\b|--include-dir\b/.test(segText)) return true;
  // pattern + ≥1 path argument (i.e. ≥2 non-flag tokens after the binary).
  const toks = segText.trim().split(/\s+/).slice(1).filter((t) => t && !t.startsWith('-'));
  return toks.length >= 2;
}

/**
 * Is `command` a raw code search over the repo that a fresh index answers better?
 * grep/egrep/fgrep/rg/ag/ack (searching files), `git grep`, or a filesystem
 * `find`. False for a `grep` filtering piped command output, for `echo grep`,
 * and for a bare `grep pattern` reading STDIN. PURE — conservative (false
 * negatives just mean no nudge; it never blocks anything).
 */
export function looksLikeRawSearch(command) {
  const cmd = String(command || '');
  if (!cmd.trim()) return false;
  for (const seg of splitPipeline(cmd)) {
    if (seg.afterPipe) continue; // reads STDIN → filtering output, not the repo
    const first = firstWord(seg.text);
    if (first === 'git') { if (/\bgit\s+grep\b/.test(seg.text)) return true; continue; }
    if (first === 'find') {
      // A file-locating find (name/path/type/regex predicate) — not a pure
      // action like `find . -delete`, which locates nothing to search.
      if (/(-name|-iname|-path|-ipath|-regex|-iregex|-type)\b/.test(seg.text)) return true;
      continue;
    }
    if (CONTENT_SEARCH.has(first)) {
      // rg/ag/ack recurse the cwd by default; grep-family must target files.
      if (first === 'grep' || first === 'egrep' || first === 'fgrep') {
        if (grepSearchesFiles(seg.text)) return true;
      } else {
        return true;
      }
    }
  }
  return false;
}

// Source-code + doc extensions the brain index covers.
const SOURCE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.java',
  '.rb', '.php', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.swift', '.kt',
  '.scala', '.sh', '.vue', '.svelte', '.md', '.mdx'
]);
// Paths the index never covers / would not answer better than a direct read.
const EXCLUDE_SEG_RE = /(^|\/)(node_modules|\.git|dist|build|\.next|out|coverage|vendor|\.project-brain|\.cache|\.venv|__pycache__)(\/|$)/;
const GENERATED_BASE_RE = /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock)$/;

/**
 * Is `p` a raw read of an indexed source file — i.e. one where `brain:search`/
 * `brain:ask` could point at the exact symbols first? True for source/doc
 * extensions outside generated / vendored / brain-internal trees. PURE.
 */
export function looksLikeRawSourceRead(p) {
  const s = String(p || '').trim();
  if (!s) return false;
  if (EXCLUDE_SEG_RE.test(s)) return false;
  const base = s.split('/').pop() || '';
  if (GENERATED_BASE_RE.test(base)) return false;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot).toLowerCase() : '';
  return SOURCE_EXT.has(ext);
}

/**
 * Classify a PreToolUse hook envelope into a nudge pattern class, or null.
 *   Bash + raw code search        → 'rawSearch'
 *   Glob over a source pattern    → 'rawSearch'
 *   Read of an indexed source file→ 'rawSourceRead'
 * `opts.surface` ('bash' | 'read') scopes a hook to its matcher's tools so the
 * two settings entries stay independent. PURE.
 */
export function classifyToolNudge(envelope = {}, opts = {}) {
  const tool = String(envelope?.tool_name || '');
  const input = envelope?.tool_input || {};
  const surface = opts.surface || '';

  if (tool === 'Bash' && (surface === '' || surface === 'bash')) {
    if (looksLikeRawSearch(String(input.command || ''))) return 'rawSearch';
    return null;
  }
  if ((tool === 'Read' || tool === 'Glob') && (surface === '' || surface === 'read')) {
    if (tool === 'Read') return looksLikeRawSourceRead(String(input.file_path || '')) ? 'rawSourceRead' : null;
    // Glob: a source-ish pattern is a file hunt the index answers.
    const pat = String(input.pattern || '');
    if (looksLikeRawSourceRead(pat) || /\{[^}]*\b(js|ts|tsx|jsx|mjs|py|go|rs|md)\b[^}]*\}/.test(pat)) return 'rawSearch';
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Nudge text.
// ---------------------------------------------------------------------------

const NUDGE_TEXT = {
  rawSearch:
    'Project Brain: this looks like a raw code search. A fresh semantic index is available — ' +
    '`npm run brain:search -- "<your terms>"` (or `brain:ask` for a synthesized answer) usually ' +
    'finds the right code faster and with far less context than grep/find. Your command still runs — this is only a hint.',
  rawSourceRead:
    'Project Brain: about to read a source file directly. If you are hunting for where a symbol is ' +
    'defined or used, `npm run brain:search -- "<symbol>"` / `brain:ask` can point you at the exact ' +
    'files and symbols first. Your read still runs — this is only a hint.'
};

/** Nudge text for a pattern class (capped to the hook byte budget). PURE. */
export function nudgeText(patternClass) {
  return capHookText(NUDGE_TEXT[patternClass] || '');
}

/**
 * Build the PreToolUse stdout payload injecting `text` as additionalContext.
 * Emits ONLY context — never a permissionDecision — so it can never block a
 * tool call. Empty text → '' (inject nothing). PURE.
 */
export function buildPreToolPayload(text) {
  if (!text) return '';
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text }
  }) + '\n';
}

// ---------------------------------------------------------------------------
// Session-scoped dedup — reuses the prompt hook's state file under `toolNudges`.
// ---------------------------------------------------------------------------

export const NUDGE_TTL_MS = 15 * 60 * 1000; // ~15 min — re-surface after a compaction drops context
const HOOK_STATE_FILE = path.join(BRAIN_DIR, '.route-hook-state.json');

/**
 * PURE dedup decision for the tool-time nudge. Given the whole persisted state
 * (or null) and `{ sessionId, patternClass, now }`, nudge (true) on: no class
 * with no `patternClass` short-circuits to false; no prior toolNudges, a new
 * session, a class not yet nudged, or a lapsed TTL. Only a class already nudged
 * in the same session within the TTL is suppressed (false) — "at most once per
 * session per pattern class" with a TTL re-surface.
 */
export function shouldNudge(prev, current, ttlMs = NUDGE_TTL_MS) {
  const { sessionId, patternClass, now } = current || {};
  if (!patternClass) return false;
  const nudges = prev && typeof prev === 'object' ? prev.toolNudges : null;
  if (!nudges || typeof nudges !== 'object') return true; // no state → nudge
  if (nudges.sessionId !== sessionId) return true;         // new session → nudge
  const ts = Number(nudges[patternClass]);
  if (!Number.isFinite(ts)) return true;                   // class not yet nudged → nudge
  if (Number(now) - ts >= ttlMs) return true;              // TTL lapsed → re-nudge
  return false;                                            // already nudged this session → suppress
}

/**
 * PURE. Merge the current nudge into the toolNudges sub-object, resetting on a
 * session change so a new session starts fresh.
 */
export function recordNudge(prevNudges, { sessionId, patternClass, now }) {
  const carry = prevNudges && typeof prevNudges === 'object' && prevNudges.sessionId === sessionId
    ? { ...prevNudges } : { sessionId };
  carry[patternClass] = now;
  return carry;
}

/** Read the shared hook state; corrupt/absent → null (fail open). */
function readHookState() {
  try { return exists(HOOK_STATE_FILE) ? JSON.parse(read(HOOK_STATE_FILE)) : null; }
  catch { return null; }
}

/** Merge a patch into the shared hook state, preserving the prompt hook's keys. Best-effort. */
function writeHookStatePatch(patch) {
  try {
    const cur = readHookState() || {};
    atomicWrite(HOOK_STATE_FILE, JSON.stringify({ ...cur, ...patch }));
  } catch { /* soft — never block */ }
}

// ---------------------------------------------------------------------------
// Stat-level index freshness (NO embedder/store load on the hot path).
// ---------------------------------------------------------------------------

/**
 * Is there a fresh-enough index to nudge toward? Stat-level ONLY: the manifest
 * exists AND a non-empty index blob (search_index.json > 1 KB) or a vector-db
 * directory is present. Missing / empty → false (no nudge — matches the
 * "absent when the index is missing/stale" acceptance criterion). Never loads
 * the embedder or opens the store.
 */
export function indexFresh(brainDir = BRAIN_DIR) {
  try {
    if (!fs.existsSync(path.join(brainDir, 'index_manifest.json'))) return false;
    try { if (fs.statSync(path.join(brainDir, 'search_index.json')).size > 1024) return true; } catch { /* no json index */ }
    try { if (fs.statSync(path.join(brainDir, 'vector-db')).isDirectory()) return true; } catch { /* no vector db */ }
    return false;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Hook entry point — ALWAYS exit 0.
// ---------------------------------------------------------------------------

/** Read the PreToolUse envelope from stdin; TTY / empty / parse error → {}. */
function readStdin() {
  try {
    if (process.stdin.isTTY) return {};
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch { return {}; }
}

async function main() {
  const args = process.argv.slice(2);
  const surface = (takeOption(args, '--surface') || '').toLowerCase();
  try {
    const envelope = readStdin();
    const patternClass = classifyToolNudge(envelope, { surface });
    if (!patternClass) return 0;                 // not a raw search/read → silent
    if (!indexFresh(BRAIN_DIR)) return 0;         // missing/stale index → silent

    if (process.env.BRAIN_TOOL_NUDGE_DEDUPE !== '0') {
      const sessionId = String(envelope.session_id || '');
      const now = Date.now();
      const state = readHookState();
      if (!shouldNudge(state, { sessionId, patternClass, now })) return 0;
      writeHookStatePatch({ toolNudges: recordNudge(state?.toolNudges, { sessionId, patternClass, now }) });
    }

    const payload = buildPreToolPayload(nudgeText(patternClass));
    if (payload) process.stdout.write(payload);
    return 0;
  } catch (err) {
    try { process.stderr.write(`[brain:route-tool] ${err?.message || err}\n`); } catch { /* ignore */ }
    return 0; // fail open — NEVER block a tool call
  }
}

// MANDATORY isMain guard: importing this module for tests must NOT run the CLI.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code)).catch(() => process.exit(0)); // even a rejected main exits 0
}
