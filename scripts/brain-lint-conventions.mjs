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
import './common.mjs'; // usage ledger choke point (#32) — arms only when BRAIN_USAGE_LOG=1

const ROOT = (() => {
  try { return fs.realpathSync(process.cwd()); } catch { return process.cwd(); }
})();
const CONFIG = path.join(ROOT, '.project-brain', 'conventions.json');

const args = process.argv.slice(2);
const SCAN_MODE = args.includes('--scan');
const QUIET = args.includes('--quiet');

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

if (SCAN_MODE) {
  process.exit(runScanMode());
} else {
  runHookMode().catch((err) => {
    process.stderr.write(`[brain-lint-conventions] error: ${err.message}\n`);
    process.stdout.write('');
  });
}
