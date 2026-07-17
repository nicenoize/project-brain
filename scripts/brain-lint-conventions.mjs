#!/usr/bin/env node
/**
 * brain:lint-conventions — convention enforcement as a Claude Code PreToolUse hook
 * and a standalone CLI check.
 *
 * Reads rules from `.project-brain/conventions.json`. Each rule is a regex
 * forbidden pattern, scoped by glob include/exclude, with a human-readable
 * message that should cite the ADR that owns the rule.
 *
 *   {
 *     "rules": [
 *       {
 *         "name": "no-supabase-from-outside-db",
 *         "match": ["**\/*.ts", "**\/*.tsx"],
 *         "exclude": ["lib/db/**", "lib/actions/**", "lib/supabase/**", "**\/*.test.*", "e2e/**"],
 *         "forbid": "\\bsupabase\\.from\\(",
 *         "message": "Raw supabase.from() lives in lib/db/ (reads) or lib/actions/ (writes). See .project-brain/decisions/0001-rls-as-single-authz-source.md.",
 *         "severity": "block"   // "block" | "warn"
 *       }
 *     ]
 *   }
 *
 * Two modes:
 *
 *   1) PreToolUse hook (no args). Reads the hook JSON payload on stdin,
 *      inspects Edit/Write/MultiEdit, and writes a JSON decision to stdout.
 *      Block payloads use `{"decision":"block","reason":"..."}` so the
 *      message reaches the model.
 *
 *   2) CLI scan. `node brain-lint-conventions.mjs --scan [paths...]` walks
 *      the working tree (or the supplied paths) and prints violations.
 *      Exits 1 on any `block`-severity hit. Use this from pre-commit or CI.
 *
 * Both modes are intentionally cheap: no AST, no file walk per rule —
 * one pass per file, all rules applied together.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import './common.mjs'; // usage ledger choke point (#32) — arms only when BRAIN_USAGE_LOG=1

const ROOT = (() => {
  try { return fs.realpathSync(process.cwd()); } catch { return process.cwd(); }
})();
const CONFIG = path.join(ROOT, '.project-brain', 'conventions.json');

const args = process.argv.slice(2);
const SCAN_MODE = args.includes('--scan');
const SIDECAR_MODE = args.includes('--sidecars');
const QUIET = args.includes('--quiet');

/* -------- sidecar discipline scan (#20 item 2) -------- */

// Only these recorders may write files under the record folders below. Every
// other script must write a sibling sidecar and leave the record untouched.
// See references/conventions.md#sidecar-discipline-records-vs-sidecars.
export const RECORD_DIRS = ['decisions', 'findings'];
export const SIDECAR_RECORDER_ALLOWLIST = [
  'brain-adr.mjs',      // owns .project-brain/decisions/
  'findings.mjs',       // owns .project-brain/findings/ (+ plans/)
  'brain-audit.mjs',    // writes findings via findings.mjs
  'brain-init.mjs',     // scaffolds the empty dirs (mkdir only)
];

const WRITE_API_RE = /\b(?:writeFileSync|appendFileSync|atomicWrite|copyFileSync|renameSync|writeSync|write)\s*\(/;
const RECORD_LITERAL_RE = new RegExp(`['"\`](?:${RECORD_DIRS.join('|')})/|['"\`](?:${RECORD_DIRS.join('|')})['"\`]\\s*[,)]`);

/**
 * Detect scripts that mutate files under a record folder (decisions/, findings/)
 * from outside their owning recorder. Pure + unit-tested.
 *
 * Heuristic (no AST, deliberately conservative to avoid false positives on the
 * current tree): resolve variables that hold a record-folder path — directly
 * (`path.join(BRAIN_DIR, 'decisions', …)`) or one alias hop (`x = path.join(dir, …)`)
 * — then flag write-API calls whose same-line arguments reference such a variable
 * or a record-folder path literal.
 *
 * @param {{path:string, content:string}[]} files
 * @param {{allowlist?:string[]}} [opts]
 * @returns {{path:string, line:number, snippet:string}[]}
 */
export function scanSidecarViolations(files, opts = {}) {
  const allow = new Set(opts.allowlist || SIDECAR_RECORDER_ALLOWLIST);
  const violations = [];
  for (const { path: rel, content } of files) {
    if (allow.has(path.basename(rel))) continue;
    if (!WRITE_API_RE.test(content)) continue;          // no writes at all → skip
    const recordVars = collectRecordPathVars(content);
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!WRITE_API_RE.test(line)) continue;
      // Only the destination (first argument) matters — a record-derived value
      // passed as *data* to a write elsewhere is not a record mutation.
      const call = line.slice(line.search(WRITE_API_RE));
      const dest = firstCallArg(call);
      const refsVar = recordVars.size && [...recordVars].some(v => new RegExp(`(?<![.\\w])${v}\\b`).test(dest));
      const refsLiteral = RECORD_LITERAL_RE.test(dest);
      if (refsVar || refsLiteral) {
        violations.push({ path: rel, line: i + 1, snippet: line.trim().slice(0, 160) });
      }
    }
  }
  return violations;
}

/** Text of a call's first argument (the write destination), depth-balanced. */
function firstCallArg(call) {
  const open = call.indexOf('(');
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < call.length; i++) {
    const ch = call[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return call.slice(open + 1, i); // closed with no top-level comma
    } else if (ch === ',' && depth === 1) {
      return call.slice(open + 1, i);
    }
  }
  return call.slice(open + 1);
}

/** Variable names bound to a decisions/ or findings/ path (incl. one alias hop). */
function collectRecordPathVars(content) {
  const vars = new Set();
  const assignRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n;]+)/g;
  let m;
  // First pass: direct record-folder path bindings.
  const rawAssigns = [];
  while ((m = assignRe.exec(content)) !== null) {
    const [, name, rhs] = m;
    rawAssigns.push([name, rhs]);
    const joinSeg = new RegExp(`path\\.join\\([^)]*['"\`](?:${RECORD_DIRS.join('|')})['"\`]`).test(rhs);
    const literal = RECORD_LITERAL_RE.test(rhs);
    if (joinSeg || literal) vars.add(name);
  }
  // Fixpoint over alias hops, but only where the new path stays INSIDE the
  // record folder: `y = path.join(<recordVar>, …)` (recordVar as the base) or a
  // trivial rename `y = <recordVar>`. A transform like `recordPath.replace(…)`
  // or a template string yields a *sibling* (a sidecar) and must NOT inherit
  // the taint — that's the whole point of the discipline.
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, rhs] of rawAssigns) {
      if (vars.has(name)) continue;
      const trimmed = rhs.trim();
      const stays = [...vars].some(v =>
        trimmed === v ||
        new RegExp(`path\\.join\\(\\s*(?<![.\\w])${v}\\b`).test(rhs)
      );
      if (stays) {
        vars.add(name);
        grew = true;
      }
    }
  }
  return vars;
}

function runSidecarMode() {
  const explicit = args.filter((a) => !a.startsWith('--'));
  const scriptPaths = listTrackedFiles(explicit.length ? explicit : ['scripts']).filter((p) => p.endsWith('.mjs'));
  const files = [];
  for (const rel of scriptPaths) {
    try {
      const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      if (content.length > 1_000_000) continue;
      files.push({ path: rel, content });
    } catch { /* skip unreadable */ }
  }
  const violations = scanSidecarViolations(files);
  if (!violations.length) {
    if (!QUIET) process.stdout.write(`[brain-lint-conventions] sidecar-clean (${files.length} scripts)\n`);
    return 0;
  }
  for (const v of violations) {
    process.stdout.write(`  ${v.path}:${v.line} writes under a record folder from outside its recorder — use a sidecar (references/conventions.md#sidecar-discipline-records-vs-sidecars)\n      ${v.snippet}\n`);
  }
  process.stdout.write(`[brain-lint-conventions] ${violations.length} sidecar-discipline warning(s) — advisory\n`);
  return 0; // advisory: never fail the tree until the reflect epic gates on it
}

function loadRules() {
  if (!fs.existsSync(CONFIG)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    return (raw.rules || []).map((r, i) => ({
      name: r.name || `rule-${i}`,
      match: arr(r.match),
      exclude: arr(r.exclude),
      forbid: new RegExp(r.forbid, r.flags || 'm'),
      message: r.message || `Convention violated: ${r.name || 'rule-' + i}`,
      severity: r.severity === 'warn' ? 'warn' : 'block',
    }));
  } catch (err) {
    process.stderr.write(`[brain-lint-conventions] failed to parse ${CONFIG}: ${err.message}\n`);
    return [];
  }
}

function arr(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/** Minimal glob → regex: supports `**`, `*`, `?`, brace alternation `{a,b}`. */
function globToRegex(glob) {
  // Tokenise glob meta-chars to placeholders before any regex escaping, then
  // substitute the regex equivalents at the end. Avoids the `?→[^/]` rule
  // corrupting the `(?:...)` groups we insert for `**/` and braces.
  let g = glob;
  g = g.replace(/\*\*\//g, '\x00DOUBLESTARSLASH\x00');
  g = g.replace(/\*\*/g, '\x00DOUBLESTAR\x00');
  g = g.replace(/\*/g, '\x00STAR\x00');
  g = g.replace(/\?/g, '\x00QMARK\x00');
  g = g.replace(/\{([^}]+)\}/g, (_, group) => '\x00BRACEOPEN\x00' + group.split(',').join('\x00BRACEPIPE\x00') + '\x00BRACECLOSE\x00');
  g = g.replace(/[.+^$()|\\\[\]{}]/g, '\\$&');
  g = g.replace(/\x00DOUBLESTARSLASH\x00/g, '(?:.*/)?');
  g = g.replace(/\x00DOUBLESTAR\x00/g, '.*');
  g = g.replace(/\x00STAR\x00/g, '[^/]*');
  g = g.replace(/\x00QMARK\x00/g, '[^/]');
  g = g.replace(/\x00BRACEOPEN\x00/g, '(?:');
  g = g.replace(/\x00BRACEPIPE\x00/g, '|');
  g = g.replace(/\x00BRACECLOSE\x00/g, ')');
  return new RegExp('^' + g + '$');
}

const globCache = new Map();
function globMatch(globs, relPath) {
  for (const g of globs) {
    let re = globCache.get(g);
    if (!re) {
      re = globToRegex(g);
      globCache.set(g, re);
    }
    if (re.test(relPath)) return true;
  }
  return false;
}

function ruleApplies(rule, relPath) {
  if (rule.match.length && !globMatch(rule.match, relPath)) return false;
  if (rule.exclude.length && globMatch(rule.exclude, relPath)) return false;
  return true;
}

function checkContent(rules, relPath, content) {
  const hits = [];
  for (const rule of rules) {
    if (!ruleApplies(rule, relPath)) continue;
    const re = new RegExp(rule.forbid.source, (rule.forbid.flags || '').includes('g') ? rule.forbid.flags : rule.forbid.flags + 'g');
    let match;
    while ((match = re.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length;
      hits.push({ rule: rule.name, severity: rule.severity, message: rule.message, line, snippet: match[0] });
      if (!re.global) break;
    }
  }
  return hits;
}

/* -------- PreToolUse hook mode -------- */

async function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    if (process.stdin.isTTY) resolve('');
  });
}

function extractEdits(payload) {
  const t = payload.tool_name || payload.toolName;
  const input = payload.tool_input || payload.toolInput || {};
  const edits = [];
  if (t === 'Write') {
    if (input.file_path && typeof input.content === 'string') {
      edits.push({ path: input.file_path, content: input.content });
    }
  } else if (t === 'Edit') {
    if (input.file_path && typeof input.new_string === 'string') {
      edits.push({ path: input.file_path, content: input.new_string });
    }
  } else if (t === 'MultiEdit') {
    if (input.file_path && Array.isArray(input.edits)) {
      const merged = input.edits.map((e) => e.new_string || '').join('\n');
      edits.push({ path: input.file_path, content: merged });
    }
  }
  return edits;
}

function relFromRoot(abs) {
  if (!abs) return '';
  if (!path.isAbsolute(abs)) return abs;
  let resolved = abs;
  try {
    if (fs.existsSync(abs)) {
      resolved = fs.realpathSync(abs);
    } else {
      // File hasn't been written yet (PreToolUse fires before Write applies).
      // Resolve the nearest existing ancestor and rejoin, so symlinked roots
      // like /tmp → /private/tmp collapse for relative comparison.
      let dir = path.dirname(abs);
      const tail = [path.basename(abs)];
      while (dir !== path.dirname(dir) && !fs.existsSync(dir)) {
        tail.unshift(path.basename(dir));
        dir = path.dirname(dir);
      }
      if (fs.existsSync(dir)) resolved = path.join(fs.realpathSync(dir), ...tail);
    }
  } catch { /* fall through */ }
  return path.relative(ROOT, resolved);
}

async function runHookMode() {
  const rules = loadRules();
  if (!rules.length) { process.stdout.write(''); return; }
  const raw = await readStdin();
  if (!raw.trim()) { process.stdout.write(''); return; }
  let payload;
  try { payload = JSON.parse(raw); } catch { process.stdout.write(''); return; }

  const edits = extractEdits(payload);
  if (!edits.length) { process.stdout.write(''); return; }

  const allHits = [];
  for (const edit of edits) {
    const rel = relFromRoot(edit.path);
    const hits = checkContent(rules, rel, edit.content);
    for (const h of hits) allHits.push({ ...h, path: rel });
  }
  const blocking = allHits.filter((h) => h.severity === 'block');
  if (blocking.length) {
    const reason = formatHits(blocking);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
      decision: 'block',
      reason,
    }));
    return;
  }
  if (allHits.length && !QUIET) {
    process.stderr.write('[brain-lint-conventions] warnings:\n' + formatHits(allHits) + '\n');
  }
  process.stdout.write('');
}

function formatHits(hits) {
  return hits.map((h) => `  ${h.path}:${h.line} [${h.rule}] ${h.message}\n      matched: ${h.snippet}`).join('\n');
}

/* -------- CLI scan mode -------- */

function listTrackedFiles(paths) {
  try {
    const args = ['ls-files', '-z'];
    if (paths.length) args.push('--', ...paths);
    const out = execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    return out.split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

function runScanMode() {
  const rules = loadRules();
  if (!rules.length) {
    if (!QUIET) process.stderr.write(`[brain-lint-conventions] no rules at ${path.relative(ROOT, CONFIG)}\n`);
    return 0;
  }
  const explicit = args.filter((a) => !a.startsWith('--'));
  const files = listTrackedFiles(explicit);

  const allHits = [];
  for (const rel of files) {
    const applies = rules.some((r) => ruleApplies(r, rel));
    if (!applies) continue;
    const abs = path.join(ROOT, rel);
    let content;
    try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    if (content.length > 1_000_000) continue;
    const hits = checkContent(rules, rel, content);
    for (const h of hits) allHits.push({ ...h, path: rel });
  }
  if (!allHits.length) {
    if (!QUIET) process.stdout.write(`[brain-lint-conventions] clean (${files.length} files, ${rules.length} rules)\n`);
    return 0;
  }
  process.stdout.write(formatHits(allHits) + '\n');
  const blocking = allHits.filter((h) => h.severity === 'block');
  process.stdout.write(`[brain-lint-conventions] ${blocking.length} blocking, ${allHits.length - blocking.length} warning\n`);
  return blocking.length ? 1 : 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (SIDECAR_MODE) {
    process.exit(runSidecarMode());
  } else if (SCAN_MODE) {
    process.exit(runScanMode());
  } else {
    runHookMode().catch((err) => {
      process.stderr.write(`[brain-lint-conventions] error: ${err.message}\n`);
      process.stdout.write('');
    });
  }
}
