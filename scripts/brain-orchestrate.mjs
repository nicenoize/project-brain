/**
 * Multi-agent backlog orchestrator.
 *
 * Pulls runnable issues from GitHub (or --from-file), sizes them into
 * work packages, and assigns parallel worker slots up to --concurrency.
 * Optionally --spawn-worktrees (one git worktree per slot) and
 * --launch-runners (one detached agent process per worktree). Honors
 * the active_state lock + per-slot orchestration lease so concurrent
 * orchestrators never over-spawn.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BRAIN_DIR, ROOT, ensureDir, slugify, write } from './common.mjs';
import { activeStateJson, addWorkstream, addLease, releaseLeases } from './active-state.mjs';
import { spawnDetachedRunner } from './runner-supervisor.mjs';
import { fileURLToPath } from 'node:url';
import { targetsOverlap, UnsupportedPatternError } from './lease-overlap.mjs';

/** Extensions we treat as source/doc files when a path carries one. */
const SCOPE_FILE_EXT = /\.(?:[cm]?[jt]sx?|mdx?|json|ya?ml|css|scss|sql|sh|go|py|rb|rs|php|toml)$/i;

const args = process.argv.slice(2);
const opts = parseArgs(args);

/* Importing this module must not run an orchestration. Every other script here
   guards its CLI; this one did not, so `import { extractScopes } from
   './brain-orchestrate.mjs'` planned and printed a real orchestration as a side
   effect — which is also why its pure helpers had no unit tests. The argv parse
   and the derived consts stay at module scope: runOnce() closes over them, and
   they are pure computation. Only the side effects are gated. */
const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain && opts.help) {
  console.log(`Usage:
  npm run brain:orchestrate -- --limit 6 --concurrency 3 --write
  npm run brain:orchestrate -- --refill --limit 6 --concurrency 3 --write
  npm run brain:orchestrate -- --watch --interval 120 --concurrency 3 --label agent-ready --write
  npm run brain:orchestrate -- --label agent-ready --concurrency 4 --spawn-worktrees
  npm run brain:orchestrate -- --label agent-ready --concurrency 4 --spawn-worktrees --launch-runners --runner-cmd 'codex exec {prompt}'
  npm run brain:orchestrate -- --from-file issues.json --concurrency 2 --json

Options:
  --limit N             Number of GitHub issues to pull (default: 10)
  --concurrency N       Number of worker slots to plan at once (default: 3)
  --label a,b           Filter GitHub issues by labels
  --assignee login      Filter GitHub issues by assignee
  --search query        Extra gh issue list --search query
  --repo owner/name     GitHub repo override
  --from-file file.json Read issues from JSON instead of gh
  --base develop        GitFlow base branch for work
  --tool codex          Worker tool label
  --write              Write .project-brain/orchestration/<timestamp>.md
  --write-packages     Also write one work-package plan per issue
  --spawn-worktrees     Create worktrees for the first runnable worker slots
  --launch-runners      Launch one runner process in each spawned worktree
  --runner-cmd cmd      Shell command template for each runner; placeholders: {prompt},{task},{actor},{tool},{branch},{issue},{title},{cwd}
  --runner-log-dir dir  Runner log directory (default: .project-brain/runner-logs)
  --refill             Only assign open slots after counting active workstreams
  --watch              Keep polling/refilling until stopped
  --interval seconds   Watch polling interval (default: 120)
  --max-cycles N       Stop watch mode after N cycles
  --json               Print JSON instead of Markdown
`);
  process.exit(0);
}

const limit = Math.max(1, Number(opts.limit || 10));
const concurrency = Math.min(Math.max(1, Number(opts.concurrency || 3)), 24);
const tool = normalizeTool(opts.tool || process.env.BRAIN_WORKTREE_TOOL || process.env.BRAIN_TOOL || 'codex');
const base = opts.base || 'develop';

if (isMain) {
  if (opts.watch) {
    await watchLoop();
  } else {
    const plan = runOnce();
    if (opts.json) console.log(JSON.stringify(plan, null, 2));
    else console.log(renderMarkdown(plan));
  }
}

async function watchLoop() {
  const intervalMs = Math.max(10, Number(opts.interval || 120)) * 1000;
  const maxCycles = Number(opts.maxCycles || 0);
  let cycle = 0;
  while (true) {
    cycle++;
    const plan = runOnce({ cycle });
    const line = `[brain:orchestrate] cycle=${cycle} active=${plan.activeSlots} assigned=${plan.workerSlots.length} open=${plan.openSlots}`;
    console.log(line);
    if (opts.json) console.log(JSON.stringify(plan, null, 2));
    else if (!opts.write) console.log(renderMarkdown(plan));
    if (maxCycles && cycle >= maxCycles) break;
    await sleep(intervalMs);
  }
}

function runOnce(extra = {}) {
  const state = activeStateJson();
  const active = activeWorkstreams(state);
  const openSlots = opts.refill || opts.watch ? Math.max(0, concurrency - active.length) : concurrency;
  const issueLimit = Math.max(limit, openSlots);
  const issues = opts.fromFile ? readIssues(opts.fromFile).slice(0, issueLimit) : fetchGithubIssues({ ...opts, limit: issueLimit }).slice(0, issueLimit);
  const plan = buildOrchestration({ issues, concurrency, tool, base, openSlots, active, state, extra });
  if (opts.spawnWorktrees && plan.workerSlots.length) {
    if (opts.launchRunners) ensureRunnerCommand(opts);
    const spawned = spawnWorktrees(plan, opts);
    plan.spawnedWorktrees = spawned;
    recordSpawnedWorkstreams(spawned);
    if (opts.launchRunners) launchRunners(plan, spawned, opts);
  }
  if (opts.write || opts.writePackages) writePlan(plan, opts);
  return plan;
}

function buildOrchestration({ issues, concurrency, tool, base, openSlots = concurrency, active = [], state = {}, extra = {} }) {
  const normalized = issues.map(normalizeIssue);
  const activeIssueNumbers = new Set(active.map(w => issueNumberFromText(`${w.taskId} ${w.branch} ${w.scope}`)).filter(Boolean));
  const activeTasks = new Set(active.map(w => w.taskId).filter(Boolean));
  const usedWorkerNumbers = workerNumbers(active, tool);
  const planned = normalized.map(issue => {
    const size = scoreIssue(issue);
    const packages = packageCountFor(size);
    return {
      ...issue,
      size,
      packageCount: packages,
      slug: `${issue.number ? `issue-${issue.number}-` : ''}${slugify(issue.title)}`,
      strategy: strategyFor(size, packages),
      workPackages: buildPackages(issue, size, packages, tool, base)
    };
  });
  const runnable = [];
  for (const issue of planned) {
    if (issue.number && activeIssueNumbers.has(String(issue.number))) continue;
    const first = issue.workPackages[0];
    if (first && activeTasks.has(first.taskId)) continue;
    if (first) runnable.push({ issueNumber: issue.number, issueTitle: issue.title, ...first });
  }
  const workerSlots = runnable.slice(0, openSlots).map(pkg => {
    const slot = nextWorkerNumber(usedWorkerNumbers);
    const actor = `${tool}-worker-${slot}`;
    return {
      slot,
      actor,
      tool,
      assignment: pkg,
      sessionStart: `npm run brain:session -- start --task ${pkg.taskId} --actor ${actor} --tool ${tool}`,
      pack: `BRAIN_TASK=${pkg.taskId} BRAIN_ACTOR=${actor} npm run brain:pack -- "${pkg.issueTitle}" --mode resume --max-tokens 1200`,
      runnerPrompt: runnerPrompt(pkg, actor, tool)
    };
  });
  return {
    type: 'issue-orchestration',
    generatedAt: new Date().toISOString(),
    ...extra,
    base,
    tool,
    concurrency,
    activeSlots: active.length,
    openSlots,
    pulledIssues: planned.length,
    runnableCount: runnable.length,
    workerSlots,
    issues: planned,
    activeWorkstreams: active,
    leases: state.leases || [],
    spawnedWorktrees: [],
    nextPull: `npm run brain:orchestrate -- --refill --limit ${concurrency} --concurrency ${concurrency} --write`
  };
}

function buildPackages(issue, size, count, tool, base) {
  const files = issue.files.length ? issue.files : ['Needs discovery'];
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const kind = packageKind(n, count);
    const id = `${issue.number ? `issue-${issue.number}` : slugify(issue.title)}-wp${String(n).padStart(2, '0')}`;
    const assignedFiles = files.filter((_, idx) => idx % count === i);
    return {
      id,
      kind,
      title: `${kind}: ${issue.title}`,
      taskId: id,
      branch: `feature/${id}-${slugify(issue.title).slice(0, 32)}`,
      base,
      tool,
      dependsOn: n === 1 ? [] : [`${issue.number ? `issue-${issue.number}` : slugify(issue.title)}-wp${String(n - 1).padStart(2, '0')}`],
      files: assignedFiles.length ? assignedFiles : ['Needs discovery'],
      modules: issue.modules,
      objective: objective(kind, issue.title),
      verification: verification(kind),
      stopRule: 'If scope expands beyond this package, stop and create/fetch another package instead of continuing in the same context.'
    };
  });
}

function renderMarkdown(plan) {
  const lines = [
    '---',
    `type: ${JSON.stringify(plan.type)}`,
    `generated_at: ${JSON.stringify(plan.generatedAt)}`,
    `concurrency: ${plan.concurrency}`,
    `base: ${JSON.stringify(plan.base)}`,
    `tool: ${JSON.stringify(plan.tool)}`,
    '---',
    '',
    '# Issue Orchestration Plan',
    '',
    `Pulled issues: ${plan.pulledIssues}`,
    `Active slots: ${plan.activeSlots}/${plan.concurrency}`,
    `Open slots: ${plan.openSlots}`,
    `Assigned worker slots: ${plan.workerSlots.length}/${plan.openSlots}`,
    `Next pull: \`${plan.nextPull}\``,
    '',
    '## Active Workstreams',
    ''
  ];
  if (!plan.activeWorkstreams.length) lines.push('- None', '');
  for (const w of plan.activeWorkstreams) {
    lines.push(`- \`${w.taskId}\` ${w.owner || 'unowned'} ${w.branch || ''} ${w.status || 'active'}`.trim());
  }
  lines.push(
    '',
    '## Worker Slots',
    ''
  );
  if (!plan.workerSlots.length) lines.push('- No runnable issues found.', '');
  for (const slot of plan.workerSlots) {
    const a = slot.assignment;
    lines.push(
      `### Worker ${slot.slot}: ${a.issueTitle}`,
      '',
      `- Actor: \`${slot.actor}\``,
      `- Task: \`${a.taskId}\``,
      `- Branch: \`${a.branch}\``,
      `- Issue: ${a.issueNumber ? `#${a.issueNumber}` : 'Needs Review'}`,
      `- Session: \`${slot.sessionStart}\``,
      `- Pack: \`${slot.pack}\``,
      `- Runner prompt: ${a.runnerPrompt}`,
      ''
    );
  }
  if (plan.spawnedWorktrees?.length) {
    lines.push('## Spawned Worktrees', '');
    for (const w of plan.spawnedWorktrees) {
      lines.push(`- Worker ${w.slot}: \`${w.path}\` branch=\`${w.branch}\`${w.runnerPid ? ` runner_pid=${w.runnerPid}` : ''}`);
    }
    lines.push('');
  }
  lines.push('## Issues', '');
  for (const issue of plan.issues) {
    lines.push(
      `### ${issue.number ? `#${issue.number} ` : ''}${issue.title}`,
      '',
      `- URL: ${issue.url || 'Needs Review'}`,
      `- Score: ${issue.size.score}/100 (${issue.size.band})`,
      `- Strategy: ${issue.strategy}`,
      `- Packages: ${issue.packageCount}`,
      `- Files: ${issue.files.length ? issue.files.map(f => `\`${f}\``).join(', ') : 'Needs discovery'}`,
      `- Modules: ${issue.modules.length ? issue.modules.map(m => `\`${m}\``).join(', ') : 'Needs Review'}`,
      '',
      '#### Work Packages',
      ...issue.workPackages.map(pkg => `- \`${pkg.taskId}\` ${pkg.kind}: ${pkg.files.map(f => `\`${f}\``).join(', ')}`),
      ''
    );
  }
  return `${lines.join('\n').trim()}\n`;
}

function writePlan(plan, opts) {
  const dir = path.join(BRAIN_DIR, 'orchestration');
  ensureDir(dir);
  const stamp = timestampSlug();
  const file = path.join(dir, `${stamp}-issue-orchestration.md`);
  if (opts.write) {
    write(file, renderMarkdown(plan));
    console.log(`Wrote ${path.relative(ROOT, file)}`);
  }
  if (opts.writePackages) {
    const pkgDir = path.join(BRAIN_DIR, 'work-packages');
    ensureDir(pkgDir);
    for (const issue of plan.issues) {
      const pkgFile = path.join(pkgDir, `${stamp}-${issue.slug}.md`);
      write(pkgFile, renderIssuePackagePlan(issue, plan));
      console.log(`Wrote ${path.relative(ROOT, pkgFile)}`);
    }
  }
}

function renderIssuePackagePlan(issue, plan) {
  return [
    '---',
    'type: "agent-work-packages"',
    `source_issue: ${JSON.stringify(issue.number ? `#${issue.number}` : issue.title)}`,
    `base: ${JSON.stringify(plan.base)}`,
    `generated_at: ${JSON.stringify(plan.generatedAt)}`,
    '---',
    '',
    `# Agent Work Packages: ${issue.title}`,
    '',
    `Issue: ${issue.url || (issue.number ? `#${issue.number}` : 'Needs Review')}`,
    `Score: ${issue.size.score}/100 (${issue.size.band})`,
    `Strategy: ${issue.strategy}`,
    '',
    ...issue.workPackages.flatMap(pkg => [
      `## ${pkg.taskId}: ${pkg.title}`,
      '',
      `- Branch: \`${pkg.branch}\``,
      `- Depends on: ${pkg.dependsOn.length ? pkg.dependsOn.map(d => `\`${d}\``).join(', ') : 'None'}`,
      `- Files: ${pkg.files.map(f => `\`${f}\``).join(', ')}`,
      '',
      '### Objective',
      pkg.objective,
      '',
      '### Verification',
      ...pkg.verification.map(v => `- [ ] ${v}`),
      '',
      '### Stop Rule',
      pkg.stopRule,
      ''
    ])
  ].join('\n');
}

/**
 * Acquire the per-slot orchestration lease (ADR 0006) so a concurrent
 * orchestrator sees this slot as taken even though the workstream row
 * isn't written yet. Returns the lease target for the paired release.
 */
export function acquireSlotLease({ slot, lockedBy, taskId }) {
  const slotTarget = `orchestration-slot/${slot}`;
  addLease({ target: slotTarget, lockedBy, until: '', notes: `spawning ${taskId || 'unassigned'}` });
  return slotTarget;
}

/** Release a per-slot orchestration lease acquired via acquireSlotLease. */
export function releaseSlotLease(slotTarget) {
  releaseLeases({ target: slotTarget });
}

/**
 * Create one git worktree for a worker slot via `npm run brain:worktree spawn`.
 * Returns { status, worker } — status is the spawn exit code (0 = ok),
 * worker is the parsed worker entry (path/branch) or null.
 */
export function spawnSlotWorktree({ base, tool, issue, slug, slot, cwd = ROOT }) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    'run', 'brain:worktree', '--', 'spawn',
    '--count', '1',
    '--base', base,
    '--type', 'feature',
    ...(issue ? ['--issue', String(issue)] : []),
    '--slug', `${slug}-wp${slot}`,
    '--tool', tool,
    '--json'
  ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.status) return { status: result.status, worker: null };
  const parsed = parseJsonFromOutput(result.stdout || '{}');
  return { status: 0, worker: parsed.workers?.[0] || null };
}

export function spawnWorktrees(plan) {
  const spawned = [];
  const lockedBy = `orchestrator:${process.pid}`;
  for (const slot of plan.workerSlots) {
    // Re-read active_state immediately before each spawn. Another orchestrator
    // (or any agent) may have claimed slots since the plan was built, so we
    // honor the concurrency cap on live state, not the stale snapshot.
    const liveActive = activeWorkstreams(activeStateJson());
    if (plan.concurrency && liveActive.length >= plan.concurrency) {
      console.log(`brain:orchestrate: concurrency cap (${plan.concurrency}) reached before slot ${slot.slot}; stopping further spawns.`);
      break;
    }
    const a = slot.assignment;
    const issue = a.issueNumber || '';
    const slug = slugify(a.issueTitle).slice(0, 48);
    // Hold an orchestration-slot lease so a concurrent orchestrator sees this
    // slot as taken even though the workstream row isn't written yet.
    const slotTarget = acquireSlotLease({ slot: slot.slot, lockedBy, taskId: a.taskId });
    try {
      const { status, worker } = spawnSlotWorktree({
        base: plan.base,
        tool: plan.tool,
        issue,
        slug,
        slot: slot.slot
      });
      if (status) {
        releaseSlotLease(slotTarget);
        process.exit(status);
      }
      if (worker) {
        a.branch = worker.branch;
        slot.runnerPrompt = runnerPrompt(a, slot.actor, plan.tool);
        for (const issuePlan of plan.issues) {
          const pkg = issuePlan.workPackages.find(candidate => candidate.taskId === a.taskId);
          if (pkg) pkg.branch = worker.branch;
        }
        spawned.push({
          slot: slot.slot,
          path: worker.path,
          branch: worker.branch,
          task: a.taskId,
          actor: slot.actor,
          tool: plan.tool,
          issueNumber: a.issueNumber || '',
          title: a.issueTitle,
          // The files/directories this package said it would touch, so the
          // workstream row is paired with real file leases (see below).
          scope: a.files || []
        });
        console.log(`Spawned worker ${slot.slot}: ${worker.path}`);
      }
    } finally {
      // Workstream row (added by recordSpawnedWorkstreams) supersedes the lease.
      releaseSlotLease(slotTarget);
    }
  }
  return spawned;
}

export function launchRunners(plan, spawned, opts) {
  const runnerCmd = ensureRunnerCommand(opts);
  const logDir = path.resolve(ROOT, opts.runnerLogDir || process.env.BRAIN_RUNNER_LOG_DIR || '.project-brain/runner-logs');
  ensureDir(logDir);
  for (const worker of spawned) {
    const slot = plan.workerSlots.find(s => s.slot === worker.slot);
    if (!slot) continue;
    const assignment = slot.assignment;
    const prompt = assignment.runnerPrompt;
    const command = renderTemplate(runnerCmd, {
      prompt,
      task: assignment.taskId,
      actor: slot.actor,
      tool: plan.tool,
      branch: assignment.branch,
      issue: assignment.issueNumber || '',
      title: assignment.issueTitle,
      cwd: worker.path
    });
    const logPath = path.join(logDir, `${assignment.taskId}.log`);
    // Detached spawn lives in runner-supervisor.mjs (extracted from here) so
    // the serve daemon's supervisor and the orchestrator share one spawn path.
    const { pid } = spawnDetachedRunner({
      command,
      cwd: worker.path,
      logFile: logPath,
      env: {
        BRAIN_TASK: assignment.taskId,
        BRAIN_ACTOR: slot.actor,
        BRAIN_TOOL: plan.tool,
        BRAIN_ISSUE: String(assignment.issueNumber || ''),
        BRAIN_BRANCH: assignment.branch,
        BRAIN_RUNNER_PROMPT: prompt
      }
    });
    worker.runnerPid = pid;
    worker.runnerLog = logPath;
    console.log(`Launched runner ${slot.actor} pid=${pid} log=${logPath}`);
  }
}

function ensureRunnerCommand(opts) {
  const runnerCmd = opts.runnerCmd || process.env.BRAIN_RUNNER_CMD || '';
  if (!runnerCmd) {
    console.error('brain:orchestrate --launch-runners requires --runner-cmd or BRAIN_RUNNER_CMD.');
    process.exit(1);
  }
  return runnerCmd;
}

/**
 * PURE. Which of these lease targets collide with a lease someone else holds?
 *
 * This is the mechanism the whole "agents that do not step on each other"
 * claim rests on, and it had no caller: `targetsOverlap` — the glob-vs-glob
 * intersection in lease-overlap.mjs, written for exactly this — was imported
 * by nobody. Overlap is the right test, not string equality: `scripts/serve/**`
 * and `scripts/serve/records.mjs` are the same work seen at two granularities,
 * and comparing them as strings finds nothing.
 *
 * A lease held by the SAME actor is not a conflict (re-planning its own slot).
 * An unsupported pattern is reported as a conflict rather than assumed safe:
 * "I cannot tell" must not read as "clear".
 *
 * @returns {Array<{target: string, heldBy: string, existing: string, reason: string}>}
 */
export function leaseConflicts(targets = [], leases = [], { actor = '' } = {}) {
  const out = [];
  for (const target of targets) {
    for (const lease of leases) {
      const existing = String(lease.target || '').trim();
      if (!existing) continue;
      const heldBy = String(lease.lockedBy || '').trim();
      if (heldBy && actor && heldBy === actor) continue;
      let hit = false;
      let reason = 'overlapping claim';
      try {
        hit = targetsOverlap(target, existing);
      } catch (error) {
        if (error instanceof UnsupportedPatternError) {
          hit = true;
          reason = `cannot decide overlap (${error.message}) — treated as a conflict`;
        } else throw error;
      }
      if (hit) out.push({ target, heldBy: heldBy || '(unattributed)', existing, reason });
    }
  }
  return out;
}

/**
 * Default life of an orchestration file lease. A crashed or abandoned runner
 * must not hold `scripts/**` forever; `until` is advisory today (nothing sweeps
 * expired rows yet) but it is READ by brief/lease/the Control Room, so a stale
 * claim is at least visibly stale rather than silently authoritative.
 */
export const ORCHESTRATION_LEASE_HOURS = 4;

/** PURE. The `until` stamp for an orchestration lease, given a start instant. */
export function leaseUntil(nowMs, hours = ORCHESTRATION_LEASE_HOURS) {
  return new Date(nowMs + hours * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Record the workstream row AND the file leases for each spawned worker.
 *
 * The file leases are the point. Until now the only lease this orchestrator
 * ever took was `orchestration-slot/<n>` — a lock on its own spawner slot,
 * released again the moment the worktree existed. Nothing ever claimed a FILE.
 * So `brain:orchestrate --launch-runners` started N agents whose coordination
 * was, in full, "each one has its own branch" — which is what git does for
 * humans already, and not what "agents that do not step on each other" means.
 * The parts were all here (addLease, lease-overlap.mjs, brain:lease); they were
 * simply never wired to the one command that launches parallel agents.
 *
 * A package whose scope could not be extracted takes no lease and says so:
 * claiming nothing is honest, claiming everything would deadlock the fleet.
 */
export function recordSpawnedWorkstreams(spawned, { now = Date.now() } = {}) {
  const unscoped = [];
  const conflicts = [];
  for (const worker of spawned) {
    addWorkstream({
      taskId: worker.task,
      owner: worker.actor,
      tool: worker.tool,
      branch: worker.branch,
      scope: worker.issueNumber ? `#${worker.issueNumber} ${worker.title}` : worker.title,
      status: 'active'
    });
    const targets = scopeToLeaseTargets(splitScope(worker.scope));
    if (!targets.length) { unscoped.push(worker.task || worker.actor); continue; }
    // Re-read leases per worker: the previous iteration just added some.
    const held = activeStateJson().leases || [];
    const clashes = leaseConflicts(targets, held, { actor: worker.actor });
    const blocked = new Set(clashes.map((c) => c.target));
    for (const c of clashes) conflicts.push({ worker: worker.task || worker.actor, ...c });
    const until = leaseUntil(now);
    for (const target of targets) {
      if (blocked.has(target)) continue;   // never overwrite someone else's claim
      addLease({
        target,
        lockedBy: worker.actor,
        until,
        notes: `${worker.task || 'work package'} on ${worker.branch}`
      });
    }
  }
  if (unscoped.length) {
    // Never silent: an agent running without a lease is exactly the case the
    // board is supposed to make visible.
    console.warn(
      `brain:orchestrate: no file scope found for ${unscoped.join(', ')} — ` +
      'launched WITHOUT a lease. Name the files or directories in the issue body ' +
      '(a trailing slash marks a directory) so siblings can see the claim.'
    );
  }
  for (const c of conflicts) {
    console.warn(
      `brain:orchestrate: ${c.worker} did NOT claim ${c.target} — ${c.heldBy} already ` +
      `holds ${c.existing} (${c.reason}). Two agents are now aimed at the same files.`
    );
  }
  return { unscoped, conflicts };
}

/** PURE. Split a mixed scope list back into files and trailing-slash dirs. */
export function splitScope(scope = []) {
  const files = [];
  const dirs = [];
  for (const entry of scope) {
    const e = String(entry || '').trim();
    if (!e || e === 'Needs discovery') continue;
    if (e.endsWith('/')) dirs.push(e); else files.push(e);
  }
  return { files, dirs };
}

function fetchGithubIssues(opts) {
  const gh = spawnSync('gh', ['--version'], { cwd: ROOT, encoding: 'utf8' });
  if (gh.status !== 0) {
    console.error('brain:orchestrate requires gh or --from-file issues.json.');
    process.exit(1);
  }
  const cmd = ['issue', 'list', '--state', 'open', '--limit', String(Math.max(1, Number(opts.limit || 10))), '--json', 'number,title,body,labels,assignees,url,createdAt,updatedAt'];
  for (const label of splitList(opts.label)) cmd.push('--label', label);
  if (opts.assignee) cmd.push('--assignee', opts.assignee);
  if (opts.search) cmd.push('--search', opts.search);
  if (opts.repo) cmd.push('--repo', opts.repo);
  const result = spawnSync('gh', cmd, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || 'gh issue list failed\n');
    process.exit(result.status || 1);
  }
  return JSON.parse(result.stdout || '[]');
}

function readIssues(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(parsed) ? parsed : parsed.issues || [];
}

function normalizeIssue(issue) {
  const body = String(issue.body || '');
  const labels = (issue.labels || []).map(label => typeof label === 'string' ? label : label.name).filter(Boolean);
  return {
    number: issue.number || issue.id || '',
    title: String(issue.title || issue.name || 'Untitled issue'),
    body,
    labels,
    url: issue.url || issue.html_url || '',
    files: extractFiles(body),
    modules: extractModules(body, labels),
    assignees: (issue.assignees || []).map(a => typeof a === 'string' ? a : a.login).filter(Boolean)
  };
}

function scoreIssue(issue) {
  let score = 20;
  if (!issue.files.length) score += 20;
  else if (issue.files.length > 5) score += Math.min(25, (issue.files.length - 5) * 4);
  if (issue.modules.length > 1) score += Math.min(25, (issue.modules.length - 1) * 12);
  if (/\b(auth|billing|payment|security|deploy|infra|schema|migration|refactor|multi-agent|parallel)\b/i.test(`${issue.title}\n${issue.body}\n${issue.labels.join(' ')}`)) score += 25;
  if (issue.body.length > 4000) score += 10;
  score = Math.min(100, score);
  const band = score >= 70 ? 'large' : score >= 45 ? 'medium' : 'small';
  return { score, band };
}

function packageCountFor(size) {
  if (size.band === 'large') return 5;
  if (size.band === 'medium') return 3;
  return 1;
}

function strategyFor(size, packages) {
  if (size.band === 'large') return `Discovery first, then ${packages - 2} implementation/integration packages, then verification. Do not run integration in parallel.`;
  if (size.band === 'medium') return 'One discovery/context pass, one implementation package, one verification package.';
  return 'Single worker is enough unless discovery reveals hidden coupling.';
}

function packageKind(index, total) {
  if (total === 1) return 'Implementation';
  if (index === 1) return 'Discovery';
  if (index === total) return 'Verification';
  if (index === total - 1 && total > 3) return 'Integration';
  return 'Implementation';
}

function objective(kind, title) {
  if (kind === 'Discovery') return `Map scope, files, dependencies, risks, and exact implementation package boundaries for ${title}.`;
  if (kind === 'Integration') return `Integrate completed slices for ${title} and resolve conflicts/assumptions.`;
  if (kind === 'Verification') return `Verify ${title}, update Project Brain docs, and prepare PR evidence.`;
  return `Implement the bounded package for ${title} without expanding scope.`;
}

function verification(kind) {
  const base = ['Run `npm run brain:guard`.', 'Run relevant project checks from `.project-brain/repo_context.md`.'];
  if (kind === 'Discovery') return ['Run `npm run brain:ask -- "issue context" --pack --max-tokens 1200`.', 'Confirm package boundaries and dependencies.'];
  if (kind === 'Verification') return [...base, 'Run `npm run brain:maintain`.', 'Generate PR body with `npm run brain:pr -- prepare`.'];
  return base;
}

/**
 * PURE. Pull the work-package SCOPE out of an issue body: the files and the
 * DIRECTORIES it says it will touch.
 *
 * Why directories matter as much as files. This used to require an extension on
 * both patterns, and to whitelist a fixed set of top-level directory names
 * (app|src|lib|...|e2e). Planning three real packages against this repo, two of
 * them came back `Needs discovery` — one said "Touches .project-brain/decisions/
 * and docs/", the other "Touches scripts/serve/ and ui/src/components/". Both
 * named their scope perfectly clearly; neither used a filename, and `ui/` and
 * `.project-brain/` were not on the whitelist. Describing a package by AREA is
 * the normal case, not the exception, and a package with no scope cannot hold a
 * lease — which is precisely the mechanism that is supposed to keep parallel
 * agents apart.
 *
 * Conservative by construction: a bare directory must end in `/` to count,
 * which is a deliberate author signal and keeps prose ("and/or", "he/she"),
 * dates ("2026/08") and URLs out. Anything inside backticks is trusted as a
 * path either way.
 *
 * @returns {{files: string[], dirs: string[]}} dirs keep their trailing slash
 */
export function extractScopes(text) {
  const body = String(text || '');
  const files = new Set();
  const dirs = new Set();

  // Strip sentence punctuation BEFORE anything inspects the path: "…and
  // tests/foo.test.mjs." arrives as `foo.test.mjs.`, which matches no extension
  // and used to be dropped without a word. Normalising inside addPath was not
  // enough — the extension guard at the call site ran on the raw string first.
  const clean = (raw) => String(raw).trim().replace(/[.,;:]+$/, '').replace(/^\.\//, '');

  const addPath = (raw) => {
    const p = clean(raw);
    if (!p || p.startsWith('http') || p.includes('://')) return;
    if (p.endsWith('/')) { if (p.length > 1) dirs.add(p); return; }
    if (SCOPE_FILE_EXT.test(p)) { files.add(p); return; }
    // A backticked path with no extension and no trailing slash: only trust it
    // as a directory when it actually looks like a path, never a bare word.
    if (p.includes('/')) dirs.add(`${p}/`);
  };

  // Backticked paths — the author marked them up, so trust the shape.
  for (const m of body.matchAll(/`([^`\n\s]+)`/g)) {
    const c = clean(m[1]);
    if (c.includes('/') || SCOPE_FILE_EXT.test(c)) addPath(c);
  }
  // Bare file paths: any depth, any top-level name, but a real extension.
  for (const m of body.matchAll(/(?:^|[\s(,"'\[])((?:\.{0,2}[A-Za-z0-9_.-]+)(?:\/[A-Za-z0-9_.-]+)+)(?=[\s),.;:!?"'\]]|$)/gm)) {
    const c = clean(m[1]);
    if (SCOPE_FILE_EXT.test(c)) addPath(c);
  }
  // Bare directories: must end in a slash — the author's own signal.
  for (const m of body.matchAll(/(?:^|[\s(,"'\[])((?:\.{0,2}[A-Za-z0-9_.-]+)(?:\/[A-Za-z0-9_.-]+)*\/)(?=[\s),.;:!?"'\]]|$)/gm)) {
    addPath(m[1]);
  }

  // A directory that already contains a named file adds nothing to the scope.
  const covered = new Set([...files].map((f) => `${f.split('/').slice(0, -1).join('/')}/`));
  return {
    files: [...files].sort().slice(0, 40),
    dirs: [...dirs].filter((d) => !covered.has(d) || files.size === 0).sort().slice(0, 20)
  };
}

/**
 * PURE. Lease targets for a work package: files verbatim, directories widened
 * to a `**` glob so lease-overlap.mjs can intersect them against anything a
 * sibling agent claims underneath.
 */
export function scopeToLeaseTargets({ files = [], dirs = [] } = {}) {
  const out = [];
  for (const f of files) if (f && f !== 'Needs discovery' && !out.includes(f)) out.push(f);
  for (const d of dirs) {
    const glob = `${String(d).replace(/\/+$/, '')}/**`;
    if (!out.includes(glob)) out.push(glob);
  }
  return out;
}

function extractFiles(text) {
  const { files, dirs } = extractScopes(text);
  // Directories are part of the scope, carried with their slash so a reader
  // (and scopeToLeaseTargets) can tell them from files.
  return [...files, ...dirs].slice(0, 40);
}

function extractModules(body, labels) {
  const modules = new Set();
  for (const label of labels) {
    const match = label.match(/^(?:module|area|component)[:/-](.+)$/i);
    if (match) modules.add(slugify(match[1]));
  }
  for (const file of extractFiles(body)) {
    const parts = file.split('/');
    if (parts.length > 1) modules.add(parts.slice(0, 2).join('/'));
  }
  return [...modules].slice(0, 20);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    const val = next && !next.startsWith('--') ? next : '';
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--write') { opts.write = true; continue; }
    if (a === '--write-packages') { opts.writePackages = true; continue; }
    if (a === '--spawn-worktrees') { opts.spawnWorktrees = true; continue; }
    if (a === '--launch-runners') { opts.launchRunners = true; opts.spawnWorktrees = true; continue; }
    if (a === '--refill') { opts.refill = true; continue; }
    if (a === '--watch') { opts.watch = true; opts.refill = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--limit') { opts.limit = val; i += val ? 1 : 0; continue; }
    if (a === '--concurrency') { opts.concurrency = val; i += val ? 1 : 0; continue; }
    if (a === '--label') { opts.label = val; i += val ? 1 : 0; continue; }
    if (a === '--assignee') { opts.assignee = val; i += val ? 1 : 0; continue; }
    if (a === '--search') { opts.search = val; i += val ? 1 : 0; continue; }
    if (a === '--repo') { opts.repo = val; i += val ? 1 : 0; continue; }
    if (a === '--from-file') { opts.fromFile = val; i += val ? 1 : 0; continue; }
    if (a === '--base') { opts.base = val; i += val ? 1 : 0; continue; }
    if (a === '--tool') { opts.tool = val; i += val ? 1 : 0; continue; }
    if (a === '--interval') { opts.interval = val; i += val ? 1 : 0; continue; }
    if (a === '--max-cycles') { opts.maxCycles = val; i += val ? 1 : 0; continue; }
    if (a === '--runner-cmd') { opts.runnerCmd = val; i += val ? 1 : 0; continue; }
    if (a === '--runner-log-dir') { opts.runnerLogDir = val; i += val ? 1 : 0; continue; }
  }
  return opts;
}

function activeWorkstreams(state) {
  return (state.workstreams || []).filter(w => {
    const status = String(w.status || '').toLowerCase();
    return w.taskId && !['done', 'closed', 'complete', 'completed', 'cancelled', 'canceled'].includes(status);
  });
}

function workerNumbers(workstreams, tool) {
  const prefix = `${tool}-worker-`;
  return new Set(workstreams.map(w => String(w.owner || ''))
    .filter(owner => owner.startsWith(prefix))
    .map(owner => Number(owner.slice(prefix.length)))
    .filter(Number.isInteger));
}

function nextWorkerNumber(used) {
  let n = 1;
  while (used.has(n)) n++;
  used.add(n);
  return n;
}

function issueNumberFromText(text) {
  return String(text || '').match(/(?:issue-|#|\/)(\d+)/)?.[1] || '';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runnerPrompt(pkg, actor, tool) {
  return [
    'Use the project-brain skill.',
    `You are ${actor} (${tool}) working on ${pkg.taskId}.`,
    `Issue: ${pkg.issueNumber ? `#${pkg.issueNumber}` : 'Needs Review'} ${pkg.issueTitle}.`,
    `Branch: ${pkg.branch}.`,
    `Package kind: ${pkg.kind}.`,
    `Objective: ${pkg.objective}`,
    `Owned files/globs: ${pkg.files.join(', ')}.`,
    `Dependencies: ${pkg.dependsOn.length ? pkg.dependsOn.join(', ') : 'None'}.`,
    'Start by running the session command from the orchestration plan, inspect the context pack, implement only this package, run verification, compact before handoff, and end the workstream when complete.'
  ].join(' ');
}

function renderTemplate(template, values) {
  return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => shellQuote(values[key] ?? ''));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function splitList(value) {
  return String(value || '').split(/[,\n]/).map(item => item.trim()).filter(Boolean);
}

function normalizeTool(value) {
  const v = String(value || '').toLowerCase().trim();
  if (['cursor', 'claude', 'gemini', 'codex', 'human', 'other'].includes(v)) return v;
  if (v === 'claude-code') return 'claude';
  if (v === 'openai' || v === 'codex-cli' || v === 'gpt') return 'codex';
  return v ? 'other' : 'codex';
}

function timestampSlug() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function parseJsonFromOutput(output) {
  const text = String(output || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return {};
  return JSON.parse(text.slice(start, end + 1));
}
