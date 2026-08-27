/**
 * brain:answer — one deterministic verb that answers "what do I need to know
 * about these files RIGHT NOW", shaped for MACHINE consumption.
 *
 *   project-brain x answer --files a,b [--json] [--budget-bytes N]
 *
 * Everything the Control Room computes for a human (danger score, governing
 * decisions, co-change partners, leases, next action) is already deterministic
 * and model-free. This verb is that same intelligence compressed to a handful of
 * lines an AGENT can be handed ambiently — see scripts/brain-answer-hook.mjs,
 * which wires it to `PreToolUse` so the agent never has to ask (the
 * "Ambient: das Brain konsultiert sich selbst per Hooks" positioning; the
 * tool-time sibling of decisions/0023 and 0026).
 *
 * Discipline (decisions/0024 + 0026, docs/design-direction.md):
 *   - DETERMINISTIC / no LLM anywhere on this path.
 *   - TOKEN-BUDGETED: the rendered text is capped at BUDGETS.answerBytes
 *     (default 700 B ≈ 175 tok — one place: scripts/footprint.mjs). Every byte
 *     injected into an agent session costs the user money, so the answer drops
 *     sections rather than growing.
 *   - FAIL-OPEN: every collector degrades to "no data" instead of throwing, and
 *     the CLI always exits 0.
 *
 * Truncation PRIORITY (drop from the tail): leases → danger → governing →
 * partners → next. Leases are the safety-critical section (someone else is
 * holding the file you are about to edit) and are NEVER dropped — they may even
 * exceed the budget, which is the one deliberate exception to the rule above.
 *
 * The core is PURE and exported for tests:
 *   buildAnswer(inputs, {budgetBytes}) → { lines, truncated, dropped, sections }
 *   foreignLeases(files, leases, {actor, now})
 *   governingDecisions(files, {modules, decisions}, {max})
 *   partnersFor(files, pairs, {max})
 *   dangerFor(files, health)
 * The impure half (git log + record/lease/route reads) lives below the divider
 * and is keyed by HEAD into a small gitignored cache so the hook stays fast.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ROOT, atomicWrite, takeFlag, takeOption } from './common.mjs';
import { BUDGETS } from './footprint.mjs';
import { gitLogArgs, parseLog, fileHealth, coChange } from './git-intel.mjs';
import { applyRules, scoreChange } from './brain-route.mjs';
// Doc-Navigator matching, reused VERBATIM from /api/why so the ambient answer
// and the Control Room can never disagree about which ADR governs a file.
// brain-serve.mjs is import-side-effect-free (isMain guard, asserted by its own
// tests) — the same reuse brain-serve itself does for brain-route/brain-brief.
import {
  parseFrontmatter, frontmatterTitle, moduleGlobs,
  globMatchesFile, inferModuleFromPath, moduleAliases
} from './brain-serve.mjs';

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/** Resolve the answer byte budget — BRAIN_ANSWER_BUDGET_BYTES env override wins. PURE given env. */
export function answerBudgetBytes(env = process.env) {
  const n = Number(env && env.BRAIN_ANSWER_BUDGET_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : BUDGETS.answerBytes;
}

/** Emitted (only when it still fits) so a dropped section is never silent. */
export const TRUNCATION_MARKER = '… (truncated — `brain:answer --files …` for the rest)';

/** Section keys in TRUNCATION PRIORITY order. Also the display order: safety first. */
export const ANSWER_PRIORITY = Object.freeze(['leases', 'danger', 'governing', 'partners', 'next']);

const MAX_GOVERNING = 2;
const MAX_PARTNERS = 3;
/** Beyond this many lease lines the rest collapse into one "+N more" line (never dropped). */
const MAX_LEASE_LINES = 5;
const MAX_TITLE_CHARS = 56;
const MAX_EVIDENCE_CHARS = 70;

const bytesOf = (s) => Buffer.byteLength(String(s || ''), 'utf8');
const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// ---------------------------------------------------------------------------
// Pure selectors — one per section
// ---------------------------------------------------------------------------

/** PURE. Trivial repo-relative normalization for the pure path (fs-free). */
export function relPath(p) {
  return String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * PURE. The most dangerous of `files`: its fileHealth() entry plus its single
 * strongest factor (highest weighted contribution). null when no file in the
 * set has history. `health` is fileHealth().files (the full list is fine).
 */
export function dangerFor(files = [], health = []) {
  const want = new Set(files.map(relPath));
  let top = null;
  for (const h of health) {
    if (!h || !want.has(relPath(h.file))) continue;
    if (!top || h.score > top.score || (h.score === top.score && relPath(h.file) < relPath(top.file))) top = h;
  }
  if (!top) return null;
  const factors = Array.isArray(top.factors) ? top.factors : [];
  let strongest = null;
  for (const f of factors) {
    if (!f) continue;
    if (!strongest || f.contribution > strongest.contribution) strongest = f;
  }
  return {
    file: relPath(top.file),
    score: top.score,
    commits: top.commits,
    lowConfidence: Boolean(top.lowConfidence),
    factor: strongest ? { name: strongest.name, evidence: strongest.evidence } : null
  };
}

/**
 * PURE. Governing ADRs for `files`, matched exactly the way /api/why does:
 * a module record whose globs claim the file wins, else the path heuristic;
 * decisions are then matched by their `module:` frontmatter through the same
 * alias widening brain:radar uses. Ranked by how many of the given files an ADR
 * governs (then by id) so the ordering is deterministic.
 *
 * @param {string[]} files
 * @param {{modules?:Array, decisions?:Array}} records  loadDocRecords() shape
 * @returns {Array<{id,title,module,files:string[]}>}
 */
export function governingDecisions(files = [], records = {}, { max = MAX_GOVERNING } = {}) {
  const modules = records.modules || [];
  const decisions = records.decisions || [];
  const byId = new Map();
  for (const raw of files) {
    const file = relPath(raw);
    if (!file) continue;
    const owner = modules.find((r) => (r.globs || []).some((g) => globMatchesFile(g, file))) || null;
    const module = owner ? (owner.module || owner.name) : inferModuleFromPath(file);
    const aliases = moduleAliases(module, file);
    if (owner) {
      aliases.add(owner.name);
      if (owner.module) aliases.add(owner.module);
      if (owner.feature) aliases.add(String(owner.feature).trim());
    }
    for (const d of decisions) {
      if (!d || !d.module || !aliases.has(d.module)) continue;
      const entry = byId.get(d.name) || { id: d.name, title: d.title || d.name, module: d.module, files: [] };
      if (!entry.files.includes(file)) entry.files.push(file);
      byId.set(d.name, entry);
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.files.length - a.files.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, Math.max(0, max));
}

/**
 * PURE. Co-change partners of `files` that are NOT already in the set — "if you
 * touch this, history says you also touch that". `pairs` is coChange().pairs
 * (directed, confidence-sorted). Highest confidence wins per partner.
 */
export function partnersFor(files = [], pairs = [], { max = MAX_PARTNERS } = {}) {
  const inSet = new Set(files.map(relPath).filter(Boolean));
  const best = new Map();
  for (const p of pairs) {
    if (!p || !inSet.has(relPath(p.a))) continue;
    const b = relPath(p.b);
    if (!b || inSet.has(b)) continue;
    const prev = best.get(b);
    if (!prev || p.confidence > prev.confidence || (p.confidence === prev.confidence && p.together > prev.together)) {
      best.set(b, { file: b, confidence: p.confidence, together: p.together });
    }
  }
  return [...best.values()]
    .sort((a, b) => b.confidence - a.confidence || b.together - a.together || (a.file < b.file ? -1 : 1))
    .slice(0, Math.max(0, max));
}

/** PURE. Has this lease's TTL passed? Unparseable/absent `until` → still active (fail safe: keep warning). */
export function isExpiredLease(lease, now) {
  const until = String((lease && lease.until) || '').trim();
  if (!until) return false;
  const ms = Date.parse(until);
  return Number.isFinite(ms) ? ms < Number(now) : false;
}

/**
 * PURE. Active leases held by SOMEONE ELSE that cover any of `files` — the
 * safety-critical section. Self-held leases (lockedBy === actor) are dropped,
 * expired ones are dropped, everything else is reported. Uses the canonical
 * glob engine via globMatchesFile so it agrees with brain:brief / brain:lease.
 */
export function foreignLeases(files = [], leases = [], { actor = '', now = 0 } = {}) {
  const me = String(actor || '').trim();
  const out = [];
  for (const lease of leases || []) {
    if (!lease || !lease.target) continue;
    if (isExpiredLease(lease, now)) continue;
    const owner = String(lease.lockedBy || '').trim() || 'unowned';
    if (me && owner === me) continue;
    const hit = files.map(relPath).filter((f) => f && globMatchesFile(lease.target, f));
    if (!hit.length) continue;
    out.push({ target: relPath(lease.target), files: hit, lockedBy: owner, until: String(lease.until || '').trim() });
  }
  return out.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Pure renderer + budget
// ---------------------------------------------------------------------------

/** PURE. Section lines, keyed and already in truncation-priority order. */
function renderSections(inputs = {}) {
  const files = (inputs.files || []).map(relPath).filter(Boolean);
  const now = Number(inputs.now) || 0;

  const leases = foreignLeases(files, inputs.leases || [], { actor: inputs.actor || '', now });
  const danger = dangerFor(files, inputs.health || []);
  const governing = inputs.decisions || [];
  const partners = partnersFor(files, inputs.pairs || []);
  const next = inputs.next || null;

  const sections = [];

  if (leases.length) {
    const shown = leases.slice(0, MAX_LEASE_LINES);
    const lines = shown.map((l) =>
      `LEASE: ${l.files.join(', ')} held by ${l.lockedBy}${l.until ? ` until ${l.until}` : ''} — coordinate before editing`);
    if (leases.length > shown.length) {
      lines.push(`LEASE: +${leases.length - shown.length} more foreign lease(s) — run \`brain:brief --strict\``);
    }
    sections.push({ key: 'leases', lines, data: leases });
  }

  if (danger) {
    const ev = danger.factor ? ` — ${clip(danger.factor.evidence, MAX_EVIDENCE_CHARS)}` : '';
    const lc = danger.lowConfidence ? ' (low confidence: thin history)' : '';
    sections.push({
      key: 'danger',
      lines: [`danger: ${danger.file} ${danger.score}/10${ev}${lc}`],
      data: danger
    });
  }

  if (governing.length) {
    const txt = governing.map((d) => `${d.id} ${clip(d.title, MAX_TITLE_CHARS)}`).join(' | ');
    sections.push({ key: 'governing', lines: [`governing: ${txt}`], data: governing });
  }

  if (partners.length) {
    const txt = partners.map((p) => `${p.file} ${Math.round(p.confidence * 100)}%`).join(', ');
    sections.push({ key: 'partners', lines: [`co-change: ${txt}`], data: partners });
  }

  if (next && next.command) {
    const cmd = [next.command, ...(next.args || [])].join(' ').trim();
    sections.push({ key: 'next', lines: [`next: ${cmd}${next.reason ? ` — ${clip(next.reason, 90)}` : ''}`], data: next });
  }

  // Stable priority order regardless of construction order.
  sections.sort((a, b) => ANSWER_PRIORITY.indexOf(a.key) - ANSWER_PRIORITY.indexOf(b.key));
  return sections;
}

/**
 * PURE. Assemble the budgeted answer.
 *
 * @param {object} inputs { files, health, pairs, leases, decisions, next, actor, now }
 * @param {object} [opts] { budgetBytes }
 * @returns {{lines:string[], truncated:boolean, dropped:string[], sections:object, bytes:number}}
 */
export function buildAnswer(inputs = {}, opts = {}) {
  const budget = Number.isFinite(opts.budgetBytes) && opts.budgetBytes > 0
    ? Math.floor(opts.budgetBytes)
    : answerBudgetBytes();

  const sections = renderSections(inputs);
  const lines = [];
  const dropped = [];
  const kept = {};
  let used = 0;
  let stopped = false;

  for (const s of sections) {
    const cost = s.lines.reduce((n, l) => n + bytesOf(l) + 1, 0); // +1 per newline
    // Leases are the one section the budget may not silence (safety > bytes).
    const exempt = s.key === 'leases';
    if (stopped || (!exempt && used + cost > budget)) {
      dropped.push(s.key);
      stopped = true; // strict tail-drop: priority order, never cherry-pick
      continue;
    }
    lines.push(...s.lines);
    kept[s.key] = s.data;
    used += cost;
  }

  if (dropped.length) {
    const markerCost = bytesOf(TRUNCATION_MARKER) + 1;
    if (used + markerCost <= budget) {
      lines.push(TRUNCATION_MARKER);
      used += markerCost;
    }
  }

  return { lines, truncated: dropped.length > 0, dropped, sections: kept, bytes: used, budgetBytes: budget };
}

/** PURE. Rendered text for an answer (empty when there is nothing to say). */
export function renderAnswer(answer) {
  const lines = (answer && answer.lines) || [];
  return lines.length ? `${lines.join('\n')}\n` : '';
}

// ===========================================================================
// Impure half — collectors. Every one of them degrades to empty on error.
// ===========================================================================

/** Commit window read for the intel. Small enough to stay fast, wide enough to rank. */
export const ANSWER_COMMIT_WINDOW = 400;
/** Raw logs bigger than this are not cached (a huge monorepo must not bloat .project-brain). */
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
/** Cache TTL — HEAD is the real key; the TTL only bounds recency-decay drift. */
export const ANSWER_CACHE_TTL_MS = 60 * 60 * 1000;
export const ANSWER_CACHE_FILE = '.answer-cache.json';

/**
 * Resolve HEAD WITHOUT spawning git: `.git/HEAD` (+ the ref file or packed-refs).
 * Returns { sha, branch }; either may be '' when it cannot be resolved, in which
 * case the caller simply skips the cache. Handles worktrees/submodules (`.git`
 * as a `gitdir:` file).
 */
export function readGitHead(root = ROOT) {
  try {
    let gitDir = path.join(root, '.git');
    const st = fs.statSync(gitDir);
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, 'utf8'));
      if (!m) return { sha: '', branch: '' };
      gitDir = path.resolve(root, m[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*(.+)$/.exec(head);
    if (!ref) return { sha: head, branch: '' }; // detached
    const refName = ref[1].trim();
    const branch = refName.replace(/^refs\/heads\//, '');
    try {
      return { sha: fs.readFileSync(path.join(gitDir, refName), 'utf8').trim(), branch };
    } catch { /* packed */ }
    try {
      const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
      const m = new RegExp(`^([0-9a-f]{7,64})\\s+${refName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').exec(packed);
      return { sha: m ? m[1] : '', branch };
    } catch { return { sha: '', branch }; }
  } catch { return { sha: '', branch: '' }; }
}

/**
 * The commit window for `root`, cached by HEAD under
 * `.project-brain/.answer-cache.json` (gitignored). There is no daemon on this
 * path — the hook runs inside the agent's process tree — so a `git log` per edit
 * (~100 ms here) is the single biggest cost; the cache turns it into a ~3 ms
 * read. Cache miss / unreadable cache / git absent all degrade to [].
 */
export function cachedCommits(root = ROOT, { now = Date.now(), limit = ANSWER_COMMIT_WINDOW } = {}) {
  const { sha } = readGitHead(root);
  const cacheFile = path.join(root, '.project-brain', ANSWER_CACHE_FILE);
  if (sha) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (c && c.head === sha && c.limit === limit && Number(now) - Number(c.ts) < ANSWER_CACHE_TTL_MS && typeof c.log === 'string') {
        return parseLog(c.log);
      }
    } catch { /* cold / corrupt cache → recompute */ }
  }
  let raw = '';
  try {
    const r = spawnSync('git', gitLogArgs({ limit }), {
      cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10_000
    });
    if (r.status !== 0) return [];
    raw = String(r.stdout || '');
  } catch { return []; }
  if (sha && raw && bytesOf(raw) <= MAX_CACHE_BYTES) {
    try { atomicWrite(cacheFile, JSON.stringify({ head: sha, limit, ts: Number(now), log: raw })); }
    catch { /* cache is an optimization, never a requirement */ }
  }
  return parseLog(raw);
}

/** Doc records (modules + decisions) — the /api/why shape, trimmed to what the answer needs. */
export function loadDocRecords(root = ROOT) {
  const out = { modules: [], decisions: [] };
  for (const kind of ['modules', 'decisions']) {
    const dir = path.join(root, '.project-brain', kind);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      let text = '';
      try { text = fs.readFileSync(path.join(dir, e.name), 'utf8').slice(0, 64 * 1024); } catch { continue; }
      const { data, body } = parseFrontmatter(text);
      const name = e.name.replace(/\.md$/i, '');
      out[kind].push({
        name,
        title: frontmatterTitle(text) || name,
        module: String(data.module || '').trim(),
        feature: String(data.feature || '').trim(),
        globs: kind === 'modules' ? moduleGlobs(data, body) : []
      });
    }
    out[kind].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  return out;
}

/** Active-state leases — READ-ONLY: never scaffolds active_state.md (the hook must not write). */
export async function loadLeases(root = ROOT) {
  try {
    if (!fs.existsSync(path.join(root, '.project-brain', 'active_state.md'))) return [];
    const { activeStateJson } = await import('./active-state.mjs');
    return activeStateJson().leases || [];
  } catch { return []; }
}

/**
 * Repo-SETUP routing (`brain:init` / `brain:index` / `brain:maintain`) is a
 * session-level concern that decisions/0023's SessionStart + UserPromptSubmit
 * hooks already deliver once. Repeating it before every edit would be pure
 * noise on the most frequently paid surface the brain has, so the ambient
 * answer filters it out and stays quiet instead.
 */
const SETUP_COMMANDS = new Set(['brain:init', 'brain:index', 'brain:maintain']);

/**
 * The single highest-ranked brain:route action for this situation. Reuses
 * brain-route's PURE rule engine (applyRules) over CHEAP signals only — no
 * `gh pr list`, no findings load, no index open (senseState is far too
 * expensive for an ambient hook). Backlog signals are deliberately omitted, so
 * the backlog rules simply do not fire rather than firing on a guess.
 */
export function nextAction({ root = ROOT, files = [], branch = '', leaseConflicts = 0 } = {}) {
  try {
    const { band, riskKeyword, recommendedPackages } = scoreChange(files, branch);
    const brainDir = path.join(root, '.project-brain');
    const signals = {
      brainInitialized: fs.existsSync(path.join(brainDir, 'context_index.md')),
      indexed: fs.existsSync(path.join(brainDir, 'search_index.json')) || fs.existsSync(path.join(brainDir, 'index_manifest.json')),
      leaseConflicts,
      changedFiles: files.length,
      changeBand: band,
      riskKeyword,
      recommendedPackages,
      stagedFiles: 0,
      branch,
      detachedHead: !branch
    };
    const top = applyRules(signals, { top: 5 }).recommendations
      .find((r) => !SETUP_COMMANDS.has(r.command));
    return top ? { command: top.command, args: top.args, reason: top.reason, boundary: top.boundary } : null;
  } catch { return null; }
}

/** Repo-relative path for a (possibly absolute, possibly symlinked) path; '' when outside the repo. */
export function toRepoRelative(p, root = ROOT) {
  const raw = String(p || '').trim();
  if (!raw) return '';
  if (!path.isAbsolute(raw)) return relPath(raw);
  let realRoot = root;
  try { realRoot = fs.realpathSync(root); } catch { /* keep */ }
  let abs = raw;
  try {
    if (fs.existsSync(abs)) {
      abs = fs.realpathSync(abs);
    } else {
      // PreToolUse fires BEFORE a Write lands, so the file often does not exist
      // yet: resolve the nearest existing ancestor and rejoin (mirrors
      // brain-lint-conventions.mjs#relFromRoot, so /tmp → /private/tmp collapses).
      let dir = path.dirname(abs);
      const tail = [path.basename(abs)];
      while (dir !== path.dirname(dir) && !fs.existsSync(dir)) { tail.unshift(path.basename(dir)); dir = path.dirname(dir); }
      if (fs.existsSync(dir)) abs = path.join(fs.realpathSync(dir), ...tail);
    }
  } catch { /* best effort */ }
  const rel = path.relative(realRoot, abs);
  return !rel || rel.startsWith('..') ? '' : relPath(rel);
}

/**
 * Collect every input buildAnswer() needs for `files`. Impure but total: any
 * collector that fails contributes nothing instead of throwing.
 */
export async function collectAnswerInputs(files, { root = ROOT, now = Date.now(), actor = process.env.BRAIN_ACTOR || '' } = {}) {
  const rels = [];
  for (const f of files) {
    const rel = toRepoRelative(f, root);
    if (rel && !rels.includes(rel)) rels.push(rel);
  }
  if (!rels.length) return { files: [], health: [], pairs: [], leases: [], decisions: [], next: null, actor, now };

  const commits = cachedCommits(root, { now });
  let health = [];
  let pairs = [];
  if (commits.length) {
    try { health = fileHealth(commits, { now }).files; } catch { /* soft */ }
    try { pairs = coChange(commits).pairs; } catch { /* soft */ }
  }
  const records = loadDocRecords(root);
  const decisions = governingDecisions(rels, records);
  const leases = await loadLeases(root);
  const conflicts = foreignLeases(rels, leases, { actor, now });
  const { branch } = readGitHead(root);
  const next = nextAction({ root, files: rels, branch, leaseConflicts: conflicts.length });

  return { files: rels, health, pairs, leases, decisions, next, actor, now, commits: commits.length };
}

/** One-call convenience used by both the CLI and the hook wrapper. */
export async function answerFor(files, { root = ROOT, now = Date.now(), budgetBytes, actor } = {}) {
  const inputs = await collectAnswerInputs(files, { root, now, actor });
  return { inputs, answer: buildAnswer(inputs, { budgetBytes }) };
}

// ---------------------------------------------------------------------------
// CLI — always exit 0.
// ---------------------------------------------------------------------------

function parseFilesArg(args) {
  const out = [];
  for (;;) {
    const v = takeOption(args, '--files');
    if (v === undefined || v === null || v === '') break;
    for (const part of String(v).split(',')) {
      const t = part.trim();
      if (t) out.push(t);
    }
  }
  // Bare positional paths are accepted too (`x answer scripts/store.mjs`).
  for (const a of args) if (a && !a.startsWith('-')) out.push(a);
  return [...new Set(out)];
}

async function main() {
  const args = process.argv.slice(2);
  const json = takeFlag(args, '--json');
  const budgetRaw = takeOption(args, '--budget-bytes');
  const budgetBytes = Number(budgetRaw);
  const files = parseFilesArg(args);

  if (!files.length) {
    process.stderr.write('brain:answer — what do I need to know about these files RIGHT NOW\n' +
      'Usage: project-brain x answer --files a.mjs,b.mjs [--json] [--budget-bytes N]\n');
    return 0;
  }

  const { inputs, answer } = await answerFor(files, {
    budgetBytes: Number.isFinite(budgetBytes) && budgetBytes > 0 ? budgetBytes : undefined
  });

  if (json) {
    process.stdout.write(JSON.stringify({
      files: inputs.files,
      ...answer.sections,
      lines: answer.lines,
      truncated: answer.truncated,
      dropped: answer.dropped,
      bytes: answer.bytes,
      budgetBytes: answer.budgetBytes,
      provenance: {
        basis: 'measured',
        source: '.project-brain records + active_state leases + git log',
        window: { commits: inputs.commits || 0 }
      }
    }, null, 2) + '\n');
    return 0;
  }

  const text = renderAnswer(answer);
  process.stdout.write(text || `nothing notable for ${inputs.files.join(', ') || 'these files'}\n`);
  return 0;
}

// MANDATORY isMain guard: importing this module for tests must NOT run the CLI.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => process.exit(c)).catch(() => process.exit(0));
}
