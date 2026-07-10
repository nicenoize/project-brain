/**
 * brain:route — the brain decides, by itself, which command to run next.
 *
 * Every other brain command answers "do X". This one answers "what should I do
 * NOW?". It is the SKILL.md "Default automation policy" table compiled into a
 * DETERMINISTIC sensor + rule engine: it senses git / index / backlog state and
 * prints the ranked next `brain:*` actions with a reason for each — exactly the
 * style of `brain:ask --explain` (the retrieval router) and `brain:improve
 * status/next` (the backlog tick), generalized from one backlog to the whole
 * command surface. No LLM on the hot path — the agent reads the recommendation
 * and decides (the "procedures > abilities" house stance).
 *
 * Autonomy ceiling (decisions/0022, inheriting 0018): plain `brain:route` only
 * RECOMMENDS. `--auto` may EXECUTE only the read-only / advisory / idempotent
 * subset, and STOPS at the first mutating / irreversible boundary — branch
 * creation, record writes, worktree spawn, PR/issue creation. It never runs
 * git commit / push / merge. classifyBoundary() is the single source of truth
 * for what is auto-safe, and `--auto` re-checks it before every execution.
 *
 * The decision logic — applyRules(signals) and classifyBoundary(command,args) —
 * is PURE and exported, so routing + the auto/stop classification are
 * unit-testable against fixture signals with no real index, git, or model.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execSync } from 'node:child_process';
import {
  ROOT, BRAIN_DIR, exists, takeFlag, takeOption, gitBranchSafe,
  staleIndexFromRecords, isFastMode
} from './common.mjs';

const CONTEXT_INDEX = path.join(BRAIN_DIR, 'context_index.md');
const JSON_INDEX = path.join(BRAIN_DIR, 'search_index.json');
const MANIFEST = path.join(BRAIN_DIR, 'index_manifest.json');

// High-risk / cross-cutting keywords (mirrors brain-ticket.mjs#scoreTask) — a
// change touching these warrants splitting into work packages before coding.
const RISK_RE = /\b(migration|auth|billing|payment|infra|schema|deploy|security|multi-agent|parallel)\b/i;

// ---------------------------------------------------------------------------
// Boundary classification — the auto/stop source of truth (PURE, exported).
// ---------------------------------------------------------------------------

// Commands that mutate / are irreversible regardless of args: --auto never runs
// these; it stops and hands the trigger back to the agent.
const ALWAYS_HUMAN = new Set(['init', 'work', 'orchestrate', 'worktree', 'compact', 'learn', 'pr', 'index', 'sync', 'repair']);

/**
 * Is `brain:<command> <args...>` safe for `--auto` to execute? Read-only /
 * advisory / idempotent → 'auto'; mutating / irreversible → 'human'. PURE.
 *
 * The subcommand-sensitive rules encode the borderline cases: a record WRITE
 * (audit add, insight add, explain save, grill save, gaps --as-findings, why
 * ingest) is 'human'; the read-only sibling (run, scaffold, check, list, query)
 * is 'auto'. `improve next` is the one sanctioned auto-tick that writes (it
 * plans the top finding — decisions/0018); `improve execute` is 'human'.
 */
export function classifyBoundary(command, args = []) {
  const cmd = String(command || '').replace(/^brain:/, '');
  const sub = (args.find(a => a && !a.startsWith('-')) || '').toLowerCase();
  const has = (f) => args.includes(f);

  if (ALWAYS_HUMAN.has(cmd)) return 'human';

  switch (cmd) {
    case 'ticket':
      return (has('--write') || has('--github') || sub === 'create') ? 'human' : 'auto';
    case 'improve':
      if (sub === 'execute' || sub === 'plan') return 'human';
      return 'auto'; // status / list / next / reconcile(--dry-run)
    case 'audit':
      return sub === 'add' ? 'human' : 'auto'; // run is a scaffold (read-only)
    case 'insight':
    case 'explain':
      return sub === 'add' || sub === 'save' ? 'human' : 'auto';
    case 'grill':
      return sub === 'save' ? 'human' : 'auto'; // scaffold / check / list read-only
    case 'gaps':
      return has('--as-findings') ? 'human' : 'auto';
    case 'why':
      return sub === 'ingest' ? 'human' : 'auto';
    case 'adr':
      return 'human'; // always writes a new ADR file
    default:
      // Read-only / advisory / idempotent by construction.
      return 'auto';
  }
}

// ---------------------------------------------------------------------------
// Rule engine (PURE, exported) — signals → ranked recommendations.
// ---------------------------------------------------------------------------

/**
 * Apply the routing rules to a sensed `signals` object. PURE — no I/O. Returns
 * ranked recommendations (lower rank = higher priority), the first auto-safe
 * entry point (for `--auto`), and the boundary it would stop at.
 *
 * @param {object} signals  see senseState() for the shape
 * @param {object} [opts]   { intent: string, project: string, top: number }
 */
export function applyRules(signals = {}, opts = {}) {
  const recs = [];
  const add = (rank, command, args, boundary, reason, sig) =>
    recs.push({ rank, command, args, boundary: boundary || classifyBoundary(command, args), reason, signals: sig || [] });

  // P0 — foundational: a cold brain produces ghost citations, so gate everything.
  if (!signals.brainInitialized) {
    add(0, 'brain:init', [], 'human', 'no .project-brain/ yet — initialize the brain first', ['brainInitialized']);
    return finalize(recs, signals, opts);
  }
  if (!signals.indexed) {
    add(0, 'brain:index', [], 'human', 'brain initialized but unindexed — build the retrieval index', ['indexed']);
  }

  // P1 — stale index: sync before trusting retrieval (idempotent, auto-safe).
  if (signals.indexStale && (signals.indexStale.deleted > 0 || signals.indexStale.changed > 0)) {
    add(1, 'brain:maintain', [], 'auto',
      `index reports ${signals.indexStale.deleted} ghost / ${signals.indexStale.changed} stale-hash path(s) — sync before trusting retrieval`,
      ['indexStale']);
  }

  // P3 — lease conflict: someone else holds a lease on a file you'd touch.
  if (signals.leaseConflicts > 0) {
    add(3, 'brain:brief', ['--strict'], 'auto',
      `${signals.leaseConflicts} file(s) leased by someone else — coordinate before editing`,
      ['leaseConflicts']);
  }

  // P4 — large / risky change: split into work packages before coding.
  if (signals.changedFiles > 0 && (signals.changeBand === 'large' || signals.riskKeyword)) {
    const title = signals.riskKeyword ? `${signals.riskKeyword} change` : 'large change';
    add(4, 'brain:ticket', [`"${title}"`, '--packages', String(signals.recommendedPackages || 4), '--write'], 'human',
      `change spans ${signals.changedFiles} file(s)${signals.riskKeyword ? ` / risk keyword '${signals.riskKeyword}'` : ''} — split into work packages first`,
      ['changedFiles', 'changeBand', 'riskKeyword']);
  }

  // P5 — small change in flight: brief / radar before editing (advisory).
  if (signals.changedFiles > 0 && signals.changeBand === 'small') {
    add(5, 'brain:radar', [], 'auto',
      `working-tree changes — check governing ADRs / downstream consumers / open findings on the touched files`,
      ['changedFiles', 'changeBand']);
  }

  // P7 — staged changes: guard then assemble the PR.
  if (signals.stagedFiles > 0) {
    add(7, 'brain:guard', [], 'auto', `${signals.stagedFiles} staged file(s) — run guardrails before the PR`, ['stagedFiles']);
  }

  // P8 — branch ahead of base with no PR: prepare one.
  if (signals.commitsAheadNoPr && !signals.detachedHead) {
    add(8, 'brain:pr', ['prepare', '--write', '.project-brain/pr-body.md'], 'human',
      `${signals.branch} is ${signals.commitsAhead} commit(s) ahead of ${signals.base} with no open PR — prepare a PR`,
      ['commitsAheadNoPr']);
  }

  // P9 — open findings: plan the highest-impact one (the sanctioned auto-tick).
  if (signals.backlog && signals.backlog.open > 0) {
    add(9, 'brain:improve', ['next'], 'auto',
      `${signals.backlog.open} open finding(s) — plan the highest-impact one`,
      ['backlog.open']);
  }

  // P9b — a planned finding with no 'proceed' grill: challenge it before building.
  if (signals.backlog && signals.backlog.planned > 0 && signals.ungrilledPlanned > 0) {
    add(9.5, 'brain:grill', ['scaffold', '<plan-slug>'], 'auto',
      `${signals.ungrilledPlanned} planned finding(s) not yet grilled — adversarially challenge before executing`,
      ['backlog.planned', 'ungrilledPlanned']);
  }

  // P10 — planned findings ready: execute (worktree-isolated; you merge).
  if (signals.backlog && signals.backlog.planned > 0) {
    add(10, 'brain:improve', ['execute', '<plan-slug>'], 'human',
      `${signals.backlog.planned} planned finding(s) ready — execute (worktree-isolated; you merge)`,
      ['backlog.planned']);
  }

  // P11 — backlog clear: surface gaps or audit for more work.
  if (signals.backlog && signals.backlog.open === 0 && signals.backlog.planned === 0) {
    if (signals.gaps && signals.gaps.high > 0) {
      add(11, 'brain:gaps', ['--as-findings'], 'human',
        `backlog clear but ${signals.gaps.high} high-severity gap(s) — promote them to findings`,
        ['gaps.high']);
    } else {
      add(11, 'brain:audit', ['run', '--quick'], 'auto',
        `backlog clear — audit for more work`, ['backlog']);
    }
  }

  return finalize(recs, signals, opts);
}

/** Apply intent bias, sort, cap, and compute the auto entry + stop boundary. PURE. */
function finalize(recs, signals, opts = {}) {
  const intent = String(opts.intent || '').toLowerCase();

  // Intent bias: a question-shaped intent always offers brain:ask; keyword
  // matches lower (boost) the rank of the rules they name. Deterministic — a
  // substring/keyword test, never an LLM.
  if (intent) {
    if (/\b(how|why|what|where|when|which|who|\?)\b/.test(intent)) {
      recs.push({ rank: 2, command: 'brain:ask', args: [`"${opts.intent}"`], boundary: 'auto',
        reason: 'question intent — delegate retrieval to brain:ask (it picks file/symbol/doc/vector/pack)', signals: ['intent'] });
    }
    const boosts = [
      [/\b(pr|pull request|ship|merge|review)\b/, ['brain:pr', 'brain:guard']],
      [/\b(refactor|rewrite|change|auth|billing|schema)\b/, ['brain:ticket']],
      [/\b(improve|fix|backlog|finding)\b/, ['brain:improve', 'brain:audit']],
      [/\b(grill|challenge|critique|stress)\b/, ['brain:grill']],
      [/\b(handoff|compact|wrap)\b/, ['brain:compact']]
    ];
    for (const [re, cmds] of boosts) {
      if (!re.test(intent)) continue;
      for (const r of recs) if (cmds.includes(r.command)) r.rank -= 5;
    }
  }

  recs.sort((a, b) => a.rank - b.rank);
  const top = Number(opts.top || 5);
  const ranked = recs.slice(0, Math.max(1, top));

  const autoEntry = ranked.find(r => classifyBoundary(r.command, r.args) === 'auto') || null;
  const stop = ranked.find(r => classifyBoundary(r.command, r.args) === 'human') || null;

  // Fleet annotation: append --project to every recommendation.
  if (opts.project) {
    for (const r of ranked) if (!r.args.includes('--project')) r.args = [...r.args, '--project', opts.project];
  }

  return {
    recommendations: ranked,
    autoEntry: autoEntry ? `${autoEntry.command} ${autoEntry.args.join(' ')}`.trim() : null,
    stopBoundary: stop ? { command: stop.command, args: stop.args, reason: stop.reason } : null,
    quiet: ranked.length === 0
  };
}

// ---------------------------------------------------------------------------
// Sensing (I/O; cheap/model-free by default, one optional soft index open).
// ---------------------------------------------------------------------------

function gitChangedFiles() {
  try {
    return execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map(l => l.slice(3).trim()).filter(Boolean)
      .map(p => (p.includes(' -> ') ? p.split(' -> ').pop() : p));
  } catch { return []; }
}
function gitStagedFiles() {
  try {
    return execSync('git diff --cached --name-only --diff-filter=ACMR', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

/** Module of a file via the indexer's path heuristic (kept local, no import cost). */
function moduleOfPath(file) {
  if (!file) return '';
  if (file.includes('/modules/')) return path.basename(file, path.extname(file));
  const parts = file.split('/');
  if (['app', 'pages', 'components', 'lib', 'src', 'server', 'actions'].includes(parts[0])) return parts.slice(0, 2).join('/');
  return path.dirname(file) === '.' ? '' : path.dirname(file);
}

/** Cheap change-band scoring (mirrors brain-ticket.mjs#scoreTask shape). PURE. */
export function scoreChange(files = [], branch = '') {
  const modules = new Set(files.map(moduleOfPath).filter(Boolean));
  const hay = `${files.join(' ')} ${branch}`;
  const riskMatch = hay.match(RISK_RE);
  let score = 20;
  if (files.length > 5) score += Math.min(25, (files.length - 5) * 4);
  if (modules.size > 1) score += Math.min(25, (modules.size - 1) * 12);
  if (riskMatch) score += 25;
  score = Math.min(100, score);
  const band = score >= 70 ? 'large' : score >= 45 ? 'medium' : 'small';
  const recommendedPackages = score >= 70 ? 5 : score >= 45 ? 3 : 1;
  return { band, riskKeyword: riskMatch ? riskMatch[0].toLowerCase() : '', modules: modules.size, recommendedPackages };
}

async function senseState(opts = {}) {
  const branch = gitBranchSafe();
  const detachedHead = !branch || branch === 'HEAD';
  const changedFiles = opts.files || gitChangedFiles();
  const stagedFiles = gitStagedFiles();
  const brainInitialized = exists(BRAIN_DIR) && exists(CONTEXT_INDEX);
  const indexed = exists(JSON_INDEX) || exists(MANIFEST);

  const { band, riskKeyword, recommendedPackages } = scoreChange(changedFiles, branch);

  // Backlog + lease conflicts: model-free (findings/plans/active_state from disk).
  let backlog = { open: 0, planned: 0, plans: 0 };
  let ungrilledPlanned = 0;
  let leaseConflicts = 0;
  try {
    const { loadFindings, loadPlans, loadGrills } = await import('./findings.mjs');
    const findings = loadFindings();
    backlog = {
      open: findings.filter(f => f.status === 'open').length,
      planned: findings.filter(f => f.status === 'planned').length,
      plans: loadPlans().length
    };
    // Planned findings without a 'proceed' grill → worth challenging first.
    const proceeded = new Set(loadGrills().filter(g => g.verdict === 'proceed').map(g => g.target));
    ungrilledPlanned = findings.filter(f => f.status === 'planned' && !proceeded.has(f.slug)).length;
  } catch { /* soft */ }
  try {
    if (changedFiles.length) {
      const { buildBrief } = await import('./brain-brief.mjs');
      const { activeStateJson } = await import('./active-state.mjs');
      const state = activeStateJson();
      const brief = buildBrief({ files: changedFiles, leases: state.leases || [], workstreams: state.workstreams || [], actor: process.env.BRAIN_ACTOR || '' });
      leaseConflicts = brief.conflicts.length;
    }
  } catch { /* soft */ }

  // Commits-ahead-no-PR (best-effort; gh is optional).
  let commitsAhead = 0, commitsAheadNoPr = false, base = '';
  if (!detachedHead && /^(feature|fix|refactor|chore|docs|test|hotfix)\//.test(branch)) {
    base = pickBase();
    try {
      const out = spawnSync('git', ['rev-list', '--count', `${base}..HEAD`], { cwd: ROOT, encoding: 'utf8' });
      commitsAhead = Number((out.stdout || '0').trim()) || 0;
    } catch { /* soft */ }
    if (commitsAhead > 0) {
      const pr = spawnSync('gh', ['pr', 'list', '--head', branch, '--json', 'number'], { cwd: ROOT, encoding: 'utf8' });
      // gh absent or errored → assume no PR (flagged in the reason via ghUnavailable).
      const hasPr = pr.status === 0 && /\"number\"/.test(pr.stdout || '');
      commitsAheadNoPr = !hasPr;
    }
  }

  // Optional index-dependent signals: one soft open for stale + gaps.
  let indexStale = null, gaps = null;
  if (indexed && !opts.noIndex && !isFastMode()) {
    try {
      const { openEmbedder } = await import('./embed.mjs');
      const { openStore } = await import('./store.mjs');
      const embedder = openEmbedder();
      const store = await openStore({ model: embedder.modelName, dims: embedder.dims });
      const records = await store.getAll();
      const stale = staleIndexFromRecords(records);
      indexStale = { deleted: stale.deleted.length, changed: stale.changed.length };
      try {
        const { runGaps } = await import('./brain-gaps.mjs');
        gaps = runGaps(records).counts;
      } catch { /* soft */ }
      try { await store.close?.(); } catch { /* soft */ }
    } catch { /* no index / model blocked → leave null */ }
  }

  return {
    branch, detachedHead, brainInitialized, indexed,
    changedFiles: changedFiles.length, stagedFiles: stagedFiles.length,
    changeBand: band, riskKeyword, recommendedPackages,
    backlog, ungrilledPlanned, leaseConflicts,
    commitsAhead, commitsAheadNoPr, base,
    indexStale, gaps
  };
}

function pickBase() {
  for (const b of ['develop', 'dev', 'main', 'master']) {
    const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', b], { cwd: ROOT, encoding: 'utf8' });
    if (r.status === 0) return b;
  }
  return 'main';
}

// ---------------------------------------------------------------------------
// Rendering + --auto runner.
// ---------------------------------------------------------------------------

function renderText(result, signals) {
  const lines = ['# Route — next actions'];
  if (result.quiet) {
    lines.push('');
    lines.push('✅ brain is fresh and quiet — nothing recommended.');
    return lines.join('\n') + '\n';
  }
  lines.push('');
  for (const r of result.recommendations) {
    const cmd = `npm run ${r.command} -- ${r.args.join(' ')}`.replace(/ -- $/, '');
    const tag = classifyBoundary(r.command, r.args) === 'auto' ? '·auto' : '·human';
    lines.push(`- [P${r.rank}${tag}] ${cmd}`);
    lines.push(`    ${r.reason}`);
  }
  lines.push('');
  if (result.autoEntry) lines.push(`auto-entry: \`${result.autoEntry}\` (run with --auto)`);
  if (result.stopBoundary) lines.push(`--auto stops before: \`${result.stopBoundary.command}\` — ${result.stopBoundary.reason}`);
  return lines.join('\n') + '\n';
}

// Commands too chatty / persistent to inject on EVERY prompt — kept in the
// explicit `brain:route` output but suppressed from the auto-activation hook so
// it nags only on genuinely interrupt-worthy state (stale index, lease conflict,
// risky uncommitted change, open/planned backlog).
const HOOK_SUPPRESS = new Set(['brain:radar', 'brain:pr']);

/**
 * Compact, low-noise routing text for the auto-activation hooks. Only
 * interrupt-worthy recommendations (rank < 11 drops the "audit for more work"
 * filler; HOOK_SUPPRESS drops the chatty/persistent ones) — so a clean repo
 * injects nothing every prompt. Returns '' when there is nothing worth
 * interrupting the agent for. PURE given the result.
 */
export function renderHookText(result) {
  const actionable = (result.recommendations || []).filter(r => r.rank < 11 && !HOOK_SUPPRESS.has(r.command));
  if (!actionable.length) return '';
  const lines = ['Project Brain routing (auto-surfaced) — next steps for the current repo state:'];
  for (const r of actionable) {
    const tag = classifyBoundary(r.command, r.args) === 'auto' ? 'safe to run' : 'your call';
    lines.push(`• [${tag}] npm run ${r.command} -- ${r.args.join(' ')}`.replace(/ -- $/, '') + ` — ${r.reason}`);
  }
  lines.push('Act on the [safe to run] items; treat [your call] as a decision. Run `npm run brain:route` for detail or `--auto` to run the safe subset.');
  return lines.join('\n');
}

// Hard cap on the TEXT the hook injects (decisions/0024). A safety net, not a
// behaviour change — measured payloads are ~10× under this. The cap applies to
// the injected text BEFORE JSON.stringify, so the envelope always stays valid.
export const HOOK_MAX_BYTES_DEFAULT = 4000;
const TRUNC_NOTE = '\n… truncated — run npm run brain:route';

function hookMaxBytes() {
  const v = Number(process.env.BRAIN_HOOK_MAX_BYTES);
  return Number.isFinite(v) && v > 0 ? v : HOOK_MAX_BYTES_DEFAULT;
}

/**
 * Truncate `text` to at most `maxBytes` UTF-8 bytes, appending a truncation
 * note (which is itself counted against the budget). PURE. Never splits a
 * multi-byte codepoint into a replacement char at the tail.
 */
export function capHookText(text, maxBytes = hookMaxBytes()) {
  const t = String(text || '');
  if (!t) return '';
  if (Buffer.byteLength(t, 'utf8') <= maxBytes) return t;
  const noteBytes = Buffer.byteLength(TRUNC_NOTE, 'utf8');
  const budget = Math.max(0, maxBytes - noteBytes);
  let cut = Buffer.from(t, 'utf8').subarray(0, budget).toString('utf8');
  // Drop a trailing U+FFFD left by a codepoint split at the byte boundary.
  cut = cut.replace(/�+$/, '');
  return cut + TRUNC_NOTE;
}

/**
 * Build the raw stdout payload for a hook event, capping the injected TEXT
 * (never the JSON envelope). PURE. Returns '' when there is nothing to inject.
 * UserPromptSubmit requires a JSON `hookSpecificOutput.additionalContext`
 * envelope (plain stdout is ignored there); SessionStart accepts plain stdout.
 */
export function buildHookPayload(event, text, maxBytes = hookMaxBytes()) {
  if (!text) return '';
  const capped = capHookText(text, maxBytes);
  const ev = String(event || 'userpromptsubmit').toLowerCase();
  if (ev === 'sessionstart') {
    return capped + '\n'; // plain stdout is added to session context
  }
  // UserPromptSubmit (default): must be JSON to inject context.
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: capped }
  }) + '\n';
}

/**
 * Emit the hook payload for the given Claude Code event. Empty text → emit
 * nothing (no injection, no noise). Always exit 0 (never block a prompt).
 */
function emitHook(event, text) {
  const payload = buildHookPayload(event, text);
  if (!payload) return 0;
  process.stdout.write(payload);
  return 0;
}

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_FOR = (command) => path.join(SCRIPTS_DIR, `${command.replace(/^brain:/, 'brain-')}.mjs`);

function runAuto(result, { dryRun }) {
  const ran = [];
  for (const r of result.recommendations) {
    if (classifyBoundary(r.command, r.args) === 'human') {
      process.stdout.write(`\n⏹ STOPPED before \`${r.command} ${r.args.join(' ')}\` — ${r.reason}\n   (mutating/irreversible — run it yourself)\n`);
      return { ran, stoppedAt: r };
    }
    // Skip placeholder-arg recommendations (they need a concrete slug).
    if (r.args.some(a => /^<.+>$/.test(a))) {
      process.stdout.write(`\n↷ skip \`${r.command} ${r.args.join(' ')}\` — needs a concrete target; run it yourself\n`);
      continue;
    }
    const script = SCRIPT_FOR(r.command);
    if (!exists(script)) { process.stdout.write(`↷ skip ${r.command} (no script ${path.basename(script)})\n`); continue; }
    if (dryRun) { process.stdout.write(`▷ would run: ${r.command} ${r.args.join(' ')}\n`); ran.push(r); continue; }
    process.stdout.write(`\n▶ ${r.command} ${r.args.join(' ')}\n`);
    const res = spawnSync(process.execPath, [script, ...r.args.map(stripQuotes)], { cwd: ROOT, encoding: 'utf8', stdio: 'inherit' });
    ran.push({ ...r, exitCode: res.status });
    if (res.status !== 0) { process.stdout.write(`\n✗ ${r.command} exited ${res.status} — stopping auto run\n`); return { ran, failedAt: r }; }
  }
  return { ran, stoppedAt: null };
}
function stripQuotes(a) { return String(a).replace(/^"(.*)"$/, '$1'); }

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function helpText() {
  return [
    'Usage: npm run brain:route -- [--auto [--dry-run]] [--intent "..."] [--files a,b]',
    '                              [--top N] [--project NAME] [--explain] [--json] [--no-index]',
    '',
    'The brain decides which command to run next. Plain run RECOMMENDS only.',
    '--auto runs only the read-only/advisory/idempotent subset and STOPS at the',
    'first mutating boundary (record write, branch/worktree/PR creation). It never',
    'runs git commit/push/merge.',
    '',
    'Flags:',
    '  --intent "..."   bias ranking toward a stated goal (deterministic keyword match)',
    '  --files a,b      override the changed-file target set',
    '  --explain        dump every sensed signal + which rules fired',
    '  --auto           execute the safe subset, stop at the first human boundary',
    '  --dry-run        with --auto: show what would run, execute nothing',
    '  --no-index       skip the optional index open (faster; drops stale/gaps signals)',
    '  --json           machine-readable output',
    '  --top N          cap recommendations (default 5)',
    '  --project NAME   fleet: annotate recommendations with --project',
    '  --hook [--event userpromptsubmit|sessionstart]',
    '                   auto-activation mode: fast (model-free), silent on a quiet repo,',
    '                   exit 0 always. UserPromptSubmit emits JSON additionalContext;',
    '                   SessionStart emits plain stdout. Wired by the install hooks.'
  ].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  if (takeFlag(args, '--help') || takeFlag(args, '-h')) { process.stdout.write(helpText() + '\n'); return 0; }
  const json = takeFlag(args, '--json');
  const explain = takeFlag(args, '--explain');
  const auto = takeFlag(args, '--auto');
  const dryRun = takeFlag(args, '--dry-run');
  const hook = takeFlag(args, '--hook');
  const hookEvent = takeOption(args, '--event');
  let noIndex = takeFlag(args, '--no-index');
  const intent = takeOption(args, '--intent');
  const project = takeOption(args, '--project');
  const top = Number(takeOption(args, '--top')) || 5;
  const filesOpt = takeOption(args, '--files');
  const files = filesOpt ? filesOpt.split(/[,\n]/).map(s => s.trim()).filter(Boolean) : null;

  // Auto-activation hook: fast (model-free), silent on a quiet repo, exit 0
  // always — it runs on every prompt / session start and must never block.
  if (hook) {
    noIndex = true;
    try {
      const signals = await senseState({ files, noIndex });
      const result = applyRules(signals, { intent, project, top: 3 });
      return emitHook(hookEvent, renderHookText(result));
    } catch { return 0; } // never block a prompt on a routing error
  }

  const signals = await senseState({ files, noIndex });
  const result = applyRules(signals, { intent, project, top });

  if (explain) {
    process.stdout.write(JSON.stringify({ signals, fired: result.recommendations.map(r => ({ rank: r.rank, command: r.command, reason: r.reason, signals: r.signals })) }, null, 2) + '\n');
    return 0;
  }
  if (json && !auto) {
    process.stdout.write(JSON.stringify({ branch: signals.branch, signals, ...result }, null, 2) + '\n');
    return 0;
  }
  if (!auto) { process.stdout.write(renderText(result, signals)); return 0; }

  // --auto
  process.stdout.write(renderText(result, signals));
  if (result.quiet) return 0;
  process.stdout.write(`\n${dryRun ? '# --auto --dry-run (executing nothing)' : '# --auto: running the safe subset until a boundary'}\n`);
  const outcome = runAuto(result, { dryRun });
  // A human-boundary stop is the EXPECTED, correct halt (exit 0), not a failure.
  return outcome.failedAt ? 1 : 0;
}

// MANDATORY isMain guard: importing this module for tests must NOT run the CLI.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => process.exit(code)).catch(err => {
    process.stderr.write(`[brain:route] ${err.message || err}\n`);
    process.exit(1);
  });
}
