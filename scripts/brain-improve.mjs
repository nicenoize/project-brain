/**
 * brain:improve — turn a `finding` into an enriched, executable `improve-plan`,
 * and keep the backlog honest. The act-axis glue.
 *
 * What makes a brain plan richer than a plain shadcn/improve plan: it is enriched
 * at generation time from the brain's OWN index instead of being re-derived by the
 * model — real blast-radius (buildImpact), real governing decisions + the working
 * agreement (packPrompt for-agent), and a real package split (brain-ticket buildPlan).
 * Everything heavy is an existing brain primitive; this file is wiring, not a system.
 * See decisions/0017-build-native-improve-act-axis.md.
 *
 * Subcommands:
 *   plan <finding-slug> [--enrich] [--max-tokens N] [--packages N]
 *        [--base develop] [--tool t] [--actor a] [--json]
 *   reconcile [--dry-run] [--json] [--strict]   refresh backlog vs cited-source drift
 *   list [--json]                               list improve-plan records
 *   execute <plan-slug> [--run] [--json]        materialize packages + route to the coordinator
 *   review  <plan-slug> [--baseline f --variant f] [--json]   run the real gate (guard/verify/eval)
 *
 * `execute` and `review` are REAL wiring (see decisions/0018): they reuse the
 * existing coordinator (brain:orchestrate / brain:worktree) and verifier
 * (brain:guard / brain:verify / brain:eval:compare) as subprocesses — no new
 * executor, no new gate. `execute` is a DRY preview by default; only `--run`
 * spawns, and even then it STOPS at the worktree boundary (no push, no merge —
 * the house human-merge rule).
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ROOT, ensureDir, exists, read, write, slugify, takeFlag, takeOption, listIndexableFiles
} from './common.mjs';
import {
  PLANS_DIR, serializeFinding, serializePlan, parsePlan, loadFindings, loadPlans
} from './findings.mjs';
import { hashSource, evaluateExplainers } from './brain-explain.mjs';
import { buildImpact } from './brain-impact.mjs';
import { packPrompt } from './brain-pack.mjs';
import { buildPlan, renderMarkdown } from './brain-ticket.mjs';
import { openEmbedder } from './embed.mjs';
import { openStore } from './store.mjs';

function usage() {
  return [
    'Usage:',
    '  npm run brain:improve -- status [--json]                       backlog dashboard + next action',
    '  npm run brain:improve -- next [--no-enrich] [--json]           advance the backlog one safe tick (loop unit)',
    '  npm run brain:improve -- plan <finding-slug> [--enrich] [--max-tokens N] [--packages N] [--base develop] [--tool t] [--actor a] [--json]',
    '  npm run brain:improve -- reconcile [--dry-run] [--json] [--strict]',
    '  npm run brain:improve -- list [--json]',
    '  npm run brain:improve -- execute <plan-slug> [--run] [--json]   (dry preview unless --run; never pushes/merges)',
    '  npm run brain:improve -- review  <plan-slug> [--baseline f.json --variant f.json] [--json]'
  ].join('\n');
}

// ---------- plan ----------

function resolveFinding(id) {
  const findings = loadFindings();
  const finding = findings.find(f => f.slug === id) || findings.find(f => f.slug === slugify(id));
  if (!finding) {
    const avail = findings.map(f => f.slug).join(', ') || '(none — run `brain:audit add` first)';
    process.stderr.write(`[brain:improve] finding not found: ${id}\nAvailable: ${avail}\n`);
    return null;
  }
  return finding;
}

/**
 * Generate (or refresh) an improve-plan for a finding and flip its status
 * open→planned. Shared by `plan` and `next`. Returns { slug, dest, files,
 * packageCount, enriched }.
 */
async function planFinding(finding, opts = {}) {
  const enrich = !!opts.enrich;
  const maxTokens = Number(opts.maxTokens || process.env.BRAIN_IMPROVE_PLAN_TOKENS || 1800);
  const base = opts.base || 'develop';
  const tool = opts.tool || process.env.BRAIN_TOOL || 'codex';
  const actor = opts.actor || process.env.BRAIN_ACTOR || '';

  const impactBlocks = [];
  let contextBlock = '';
  let files = [];

  if (enrich) {
    const embedder = openEmbedder();
    const store = await openStore({ model: embedder.modelName, dims: embedder.dims });
    const records = await store.getAll();
    const indexable = await listIndexableFiles();
    for (const symbol of finding.symbols) {
      const impact = await buildImpact(symbol, records, store, embedder, { root: ROOT, indexable, crossProject: true });
      impactBlocks.push(renderImpactBlock(impact));
      for (const r of [...impact.definitions, ...impact.callers, ...impact.callees, ...impact.tests]) {
        if (r.file) files.push(r.file);
      }
    }
    await store.close();
    // The brain writes the self-contained primer from indexed ADRs/summaries.
    const query = `${finding.title} ${finding.body}`.replace(/\s+/g, ' ').slice(0, 400);
    const packed = await packPrompt(query, { maxTokens, mode: 'for-agent', forAgent: 'executor', actor });
    contextBlock = packed.prompt;
  }

  for (const s of finding.sources) if (s.path) files.push(s.path);
  files = [...new Set(files)];

  const packageCount = Math.min(Math.max(
    Number(opts.packageCount) || (finding.impact >= 4 ? 3 : finding.impact >= 2 ? 2 : 1), 1), 12);
  const slug = `improve-${finding.slug}`;
  const plan = buildPlan({
    title: finding.title,
    slug,
    summary: `Remediate ${finding.category} finding: ${finding.title}`,
    packageCount,
    files,
    modules: finding.module ? [finding.module] : [],
    labels: ['agent-ready', 'improve', `category:${finding.category}`],
    actor, tool, base, maxFiles: 8
  });

  const body = renderPlanBody(finding, { enrich, contextBlock, impactBlocks, plan });

  const now = new Date().toISOString();
  const dest = path.join(PLANS_DIR, `${slug}.md`);
  let created = now;
  if (exists(dest)) { const prev = parsePlan(read(dest)); if (prev.created) created = prev.created; }
  ensureDir(PLANS_DIR);
  write(dest, serializePlan({
    title: finding.title, finding: finding.slug, category: finding.category,
    status: 'draft', created, updated: now, actor, module: finding.module, body
  }));

  // Lifecycle: an open finding that now has a plan becomes 'planned'.
  if (finding.status === 'open') {
    write(path.join(ROOT, finding.file), serializeFinding({ ...finding, status: 'planned', updated: now }));
  }

  return { slug, dest: path.relative(ROOT, dest), files, packageCount, enriched: enrich };
}

async function cmdPlan(args) {
  const enrich = takeFlag(args, '--enrich');
  const json = takeFlag(args, '--json');
  const maxTokens = Number(takeOption(args, '--max-tokens')) || undefined;
  const packageCount = Number(takeOption(args, '--packages')) || undefined;
  const base = takeOption(args, '--base') || undefined;
  const tool = takeOption(args, '--tool') || undefined;
  const actor = takeOption(args, '--actor') || undefined;
  const findingId = args[0];
  if (!findingId) { process.stderr.write(`[brain:improve] plan requires a finding slug\n${usage()}\n`); process.exit(1); }
  const finding = resolveFinding(findingId);
  if (!finding) process.exit(1);
  const r = await planFinding(finding, { enrich, maxTokens, packageCount, base, tool, actor });
  if (json) process.stdout.write(JSON.stringify({ finding: finding.slug, ...r }, null, 2) + '\n');
  else process.stdout.write(`${r.dest}\n`);
}

// ---------- status / next (the loop primitive) ----------

function report(json, obj, human) {
  if (json) process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  else process.stdout.write(human + '\n');
}

function cmdStatus(args) {
  const json = takeFlag(args, '--json');
  const findings = loadFindings();
  const plans = loadPlans();
  const c = { open: 0, planned: 0, wontfix: 0, resolved: 0 };
  for (const f of findings) c[f.status] = (c[f.status] || 0) + 1;
  const next = c.open ? 'plan open findings — run `brain:improve next`'
    : c.planned ? 'execute planned findings — `brain:improve execute <plan>`'
    : 'backlog clear — run `brain:audit run` to find more';
  if (json) { report(true, { findings: findings.length, ...c, plans: plans.length, next }); return; }
  process.stdout.write([
    '# Improve backlog',
    `findings: ${findings.length} (open ${c.open}, planned ${c.planned}, wontfix ${c.wontfix}, resolved ${c.resolved})`,
    `plans: ${plans.length}`,
    `next: ${next}`
  ].join('\n') + '\n');
}

/**
 * Advance the backlog one safe tick: plan the highest-impact open finding (the
 * only auto-step), or report what the agent should do next (execute / audit).
 * Execution stays explicit — `next` never mutates code. Drive it with /loop for
 * an autonomous improvement cycle; the agent supplies the judgment steps (audit,
 * review). See decisions/0018-autonomous-act-axis-loop.md.
 */
async function cmdNext(args) {
  const json = takeFlag(args, '--json');
  const noEnrich = takeFlag(args, '--no-enrich');
  const findings = loadFindings();
  const open = findings.filter(f => f.status === 'open').sort((a, b) => b.impact - a.impact);
  const planned = findings.filter(f => f.status === 'planned');

  if (open.length) {
    const target = open[0];
    const r = await planFinding(target, { enrich: !noEnrich });
    return report(json,
      { step: 'planned', finding: target.slug, plan: r.dest, remainingOpen: open.length - 1,
        next: `review ${r.dest} → \`brain:improve execute ${r.slug}\` → \`brain:improve review ${r.slug}\`` },
      `planned: ${target.slug} → ${r.dest}\nnext: review the plan, then \`brain:improve execute ${r.slug}\`, then \`brain:improve review ${r.slug}\`\n(${open.length - 1} open finding(s) left)`);
  }
  if (planned.length) {
    return report(json,
      { step: 'execute', planned: planned.map(f => `improve-${f.slug}`) },
      `${planned.length} finding(s) planned and ready. Execute one (worktree-isolated; you merge):\n  brain:improve execute improve-${planned[0].slug}\nthen \`brain:improve review\` and \`brain:improve reconcile\`.`);
  }
  return report(json,
    { step: 'audit', message: 'backlog clear' },
    'No open or planned findings. Run `brain:audit run` to find more work — or the backlog is clear.');
}

function renderImpactBlock(impact) {
  const files = (recs) => [...new Set((recs || []).map(r => r.file).filter(Boolean))];
  const fmt = (list) => list.length
    ? list.slice(0, 15).map(f => `\`${f}\``).join(', ') + (list.length > 15 ? ` … (+${list.length - 15})` : '')
    : '_none_';
  const lines = [`### \`${impact.symbol}\``];
  lines.push(`- Defined in: ${fmt(files(impact.definitions))}`);
  lines.push(`- Callers (edit surface): ${fmt(files(impact.callers))}`);
  lines.push(`- Callees: ${fmt(files(impact.callees))}`);
  lines.push(`- Tests to run: ${fmt(files(impact.tests))}`);
  if (impact.decisions?.length) lines.push(`- Governing decisions: ${fmt(files(impact.decisions))}`);
  const inbound = impact.crossProjectEdges?.toOwner || [];
  if (inbound.length) {
    lines.push(`- ⚠ Cross-project consumers (break if shape changes): ${inbound.map(e => `${e.from} →(${e.kind})`).join(', ')}`);
  }
  return lines.join('\n');
}

function renderPlanBody(finding, { enrich, contextBlock, impactBlocks, plan }) {
  const parts = [];
  parts.push(`# Improvement plan: ${finding.title}`);
  parts.push('');
  parts.push(`> **Finding:** \`${finding.slug}\` · **Category:** ${finding.category} · **Impact:** ${finding.impact}/5`);
  parts.push('');
  parts.push('## Problem');
  parts.push(finding.body.trim() || '_(no description on the finding)_');
  if (enrich && impactBlocks.length) {
    parts.push('', '## Blast radius (from the index)', '', impactBlocks.join('\n\n'));
  }
  if (enrich && contextBlock) {
    parts.push('', '## Context (retrieved)', '', contextBlock.trim());
  }
  if (!enrich) {
    parts.push('', '> _Not enriched. Re-run with `--enrich` to inject blast-radius and retrieved context from the index._');
  }
  // Reuse brain-ticket's renderer; drop its frontmatter envelope so this stays one doc.
  parts.push('', '## Work packages', '', renderMarkdown(plan).replace(/^---\n[\s\S]*?\n---\n+/, '').trim());
  return parts.join('\n') + '\n';
}

// ---------- reconcile ----------

function cmdReconcile(args) {
  const json = takeFlag(args, '--json');
  const strict = takeFlag(args, '--strict');
  const apply = !takeFlag(args, '--dry-run');
  const findings = loadFindings();
  const results = evaluateExplainers(
    findings.map(f => ({ slug: f.slug, query: f.title, sources: f.sources })),
    hashSource
  );
  const bySlug = new Map(results.map(r => [r.slug, r]));

  const resolved = [];
  const stale = [];
  for (const f of findings) {
    const r = bySlug.get(f.slug);
    if (!r || !r.stale) continue;
    if (f.status !== 'open' && f.status !== 'planned') continue;
    const drift = r.reasons.filter(x => x.status !== 'ok');
    // Auto-resolve only when EVERY cited source is gone (the code is moot).
    // Mere content drift ('changed') is surfaced for re-review, never auto-closed.
    const allMissing = drift.length > 0 && drift.every(x => x.status === 'missing');
    if (allMissing) {
      if (apply) {
        const now = new Date().toISOString();
        write(path.join(ROOT, f.file), serializeFinding({ ...f, status: 'resolved', updated: now }));
      }
      resolved.push({ slug: f.slug, from: f.status, reasons: drift });
    } else {
      stale.push({ slug: f.slug, status: f.status, reasons: drift });
    }
  }

  if (json) {
    process.stdout.write(JSON.stringify({ checked: findings.length, resolved, stale, applied: apply }, null, 2) + '\n');
  } else {
    if (!findings.length) process.stdout.write('No findings to reconcile.\n');
    for (const c of resolved) {
      process.stdout.write(`${apply ? 'resolved' : 'would resolve'}: ${c.slug} (${c.from} → resolved) — sources gone: ${c.reasons.map(x => x.path).join(', ')}\n`);
    }
    for (const c of stale) {
      process.stdout.write(`stale (re-review): ${c.slug} — ${c.reasons.map(x => `${x.status} ${x.path}`).join(', ')}\n`);
    }
    const fresh = findings.length - resolved.length - stale.length;
    process.stdout.write(`\n${findings.length} finding(s); ${resolved.length} ${apply ? 'resolved' : 'to resolve'}, ${stale.length} stale, ${fresh} fresh.\n`);
  }
  if (strict && (resolved.length || stale.length)) process.exit(1);
}

// ---------- list ----------

function cmdList(args) {
  const json = takeFlag(args, '--json');
  const plans = loadPlans();
  if (json) {
    process.stdout.write(JSON.stringify(plans.map(p => ({
      slug: p.slug, title: p.title, finding: p.finding, category: p.category, status: p.status, file: p.file
    })), null, 2) + '\n');
    return;
  }
  if (!plans.length) { process.stdout.write('No improve-plans yet. Run `brain:improve -- plan <finding-slug> --enrich`.\n'); return; }
  for (const p of plans) process.stdout.write(`[${p.status}] ${p.slug} — ${p.category}: ${p.title} (from ${p.finding})\n`);
  process.stdout.write(`\n${plans.length} plan(s).\n`);
}

// ---------- execute / review (real wiring; reuse existing orchestration/verification) ----------

// Sibling brain-* CLIs, resolved relative to THIS file so it works in both the
// dev layout (scripts/) and the installed symlink layout (skills/project-brain/
// scripts/). Invoked via spawnSync(process.execPath, [script, ...]) — never
// imported (importing an unguarded CLI would run its argv parser on load).
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const sibling = (name) => path.join(SCRIPTS_DIR, name);

/**
 * Does this plan need the statistical (eval) gate? Only retrieval/quality-
 * affecting changes do: a `performance` or `correctness` finding whose plan
 * touches the retrieval core (scripts/retrieval.mjs). Pure + exported so the
 * routing decision is unit-testable without a store. The repo rule: ship a
 * retrieval change default-ON only when the paired-bootstrap CI proves no
 * regression (see brain-eval-compare.mjs / docs/eval-methodology.md).
 */
export function needsEvalGate(plan) {
  if (!plan) return false;
  const category = String(plan.category || '').toLowerCase();
  if (category !== 'performance' && category !== 'correctness') return false;
  const haystack = `${plan.module || ''}\n${plan.body || ''}`;
  return /\bscripts\/retrieval\.mjs\b/.test(haystack);
}

/**
 * Read a brain:eval:compare JSON verdict and decide whether it CLEARS the gate.
 * Clears unless the variant is *significantly worse*: a hit@K or MRR delta that
 * is negative AND whose 95% CI excludes 0. A significant improvement or a
 * within-noise result both clear (the gate refuses regressions, it does not
 * demand wins). Pure + exported. Returns { ok, regressed, reason, verdict }.
 */
export function evalVerdictOk(report) {
  if (!report || typeof report !== 'object') {
    return { ok: false, regressed: false, reason: 'no eval:compare report', verdict: '' };
  }
  const regressedMetric = (m, label) =>
    m && m.significant && Number(m.delta) < 0
      ? `${label} regressed (Δ ${m.delta}, 95% CI ${JSON.stringify(m.ci95 || [])})`
      : '';
  const reasons = [regressedMetric(report.hit, 'hit@K'), regressedMetric(report.mrr, 'MRR')].filter(Boolean);
  if (reasons.length) {
    return { ok: false, regressed: true, reason: reasons.join('; '), verdict: report.verdict || '' };
  }
  return { ok: true, regressed: false, reason: report.verdict || 'no regression in 95% CI', verdict: report.verdict || '' };
}

/**
 * Aggregate the gate sub-results into a single pass/fail + reasons. Pure +
 * exported (the test exercises it directly with fixtures — no real guard/eval
 * needed). Each input is `{ ran, ok, detail? }`; `evalCompare` additionally
 * carries `{ required }`. A required-but-not-run eval gate FAILS (a retrieval
 * change with no proof is treated as unproven, not waved through).
 */
export function summarizeGate({ guard, verify, evalCompare } = {}) {
  const reasons = [];
  const judge = (name, res, { required = true } = {}) => {
    if (!res || res.ran === false) {
      if (!required) { reasons.push({ gate: name, status: 'skipped', detail: res?.detail || 'not applicable' }); return true; }
      reasons.push({ gate: name, status: 'fail', detail: res?.detail || 'did not run' });
      return false;
    }
    const ok = !!res.ok;
    reasons.push({ gate: name, status: ok ? 'pass' : 'fail', detail: res.detail || (ok ? 'passed' : 'failed') });
    return ok;
  };

  let pass = true;
  pass = judge('guard', guard) && pass;
  pass = judge('verify', verify) && pass;

  if (evalCompare && evalCompare.required) {
    if (evalCompare.ran === false) {
      reasons.push({ gate: 'eval:compare', status: 'fail', detail: evalCompare.detail || 'required for retrieval/quality changes but no baseline/variant reports provided (pass --baseline f.json --variant f.json)' });
      pass = false;
    } else {
      const ok = !!evalCompare.ok;
      reasons.push({ gate: 'eval:compare', status: ok ? 'pass' : 'fail', detail: evalCompare.detail || (ok ? 'no regression' : 'regression detected') });
      pass = pass && ok;
    }
  } else {
    reasons.push({ gate: 'eval:compare', status: 'skipped', detail: 'not a retrieval/quality-affecting plan' });
  }

  return { pass, reasons };
}

function resolvePlan(id) {
  const plans = loadPlans();
  const plan = plans.find(p => p.slug === id)
    || plans.find(p => p.slug === slugify(id))
    || plans.find(p => p.slug === `improve-${id}` || p.slug === `improve-${slugify(id)}`);
  if (!plan) {
    const avail = plans.map(p => p.slug).join(', ') || '(none — run `brain:improve plan <finding>` first)';
    process.stderr.write(`[brain:improve] plan not found: ${id}\nAvailable: ${avail}\n`);
    return null;
  }
  return plan;
}

/**
 * Rebuild the structured work-package plan for an improve-plan record by reusing
 * brain-ticket's buildPlan over the plan's source finding (same inputs
 * planFinding used, minus enrichment). The plan record persists only the
 * rendered body, so we re-derive the structure deterministically here.
 */
function materializePackages(plan) {
  const findings = loadFindings();
  const finding = findings.find(f => f.slug === plan.finding);
  const files = [...new Set((finding?.sources || []).map(s => s.path).filter(Boolean))];
  const packageCount = Math.min(Math.max(
    finding ? (finding.impact >= 4 ? 3 : finding.impact >= 2 ? 2 : 1) : 1, 1), 12);
  const built = buildPlan({
    title: plan.title || finding?.title || plan.slug,
    slug: plan.slug,
    summary: `Execute improve-plan ${plan.slug}`,
    packageCount,
    files,
    modules: plan.module ? [plan.module] : (finding?.module ? [finding.module] : []),
    labels: ['agent-ready', 'improve', `category:${plan.category}`],
    actor: plan.actor || '',
    tool: process.env.BRAIN_TOOL || 'codex',
    base: 'develop',
    maxFiles: 8
  });
  const dir = path.join(ROOT, '.project-brain', 'work-packages');
  ensureDir(dir);
  const dest = path.join(dir, `${plan.slug}.md`);
  write(dest, renderMarkdown(built));
  return { plan: built, file: path.relative(ROOT, dest), packageCount: built.packages.length };
}

function cmdExecute(args) {
  const json = takeFlag(args, '--json');
  const run = takeFlag(args, '--run');
  const id = args[0];
  if (!id) { process.stderr.write(`[brain:improve] execute requires a plan slug\n${usage()}\n`); process.exit(1); }
  const plan = resolvePlan(id);
  if (!plan) process.exit(1);

  const { file, packageCount } = materializePackages(plan);

  // The command we (would) hand to the EXISTING coordinator: one isolated git
  // worktree per work package. brain:worktree spawn creates the branches and
  // STOPS — it never pushes or merges (the house human-merge rule; see
  // decisions/0018). The materialized work-package file is each worker's brief.
  const slug = plan.slug.replace(/^improve-/, '').slice(0, 48) || 'improve';
  const spawnArgv = [
    sibling('brain-worktree.mjs'), 'spawn',
    '--count', String(packageCount),
    '--type', 'feature',
    '--slug', slug,
    '--json'
  ];
  const preview = `${process.execPath} ${spawnArgv.join(' ')}`;

  if (!run) {
    // DRY by default: print exactly what --run would spawn; spawn nothing.
    if (json) {
      report(true, { plan: plan.slug, mode: 'dry', packages: packageCount, workPackages: file, wouldSpawn: preview, next: `re-run with --run to spawn worktrees, then \`brain:improve review ${plan.slug}\`` });
    } else {
      process.stdout.write([
        `# Execute ${plan.slug} — DRY PREVIEW (no worktrees spawned)`,
        '',
        `Materialized ${packageCount} work-package(s) → ${file}`,
        '',
        'Would route through the existing coordinator (worktree-isolated; no push, no merge):',
        `  ${preview}`,
        '',
        `Each worktree's agent reads ${file} as its brief, implements its package, and runs`,
        '`brain:compact` before handoff. For a fuller GitHub-issue-backed run with detached',
        'runners, use `brain:orchestrate` directly.',
        '',
        `Re-run with --run to actually spawn, then \`brain:improve review ${plan.slug}\`.`
      ].join('\n') + '\n');
    }
    return;
  }

  // --run: hand off to the real coordinator as a subprocess. We never import it.
  process.stdout.write(`# Execute ${plan.slug} — spawning ${packageCount} worktree(s) via brain:worktree (no push/merge)\n`);
  const res = spawnSync(process.execPath, spawnArgv, { cwd: ROOT, encoding: 'utf8', stdio: json ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
  const ok = res.status === 0;
  if (json) {
    if (res.stdout) process.stdout.write(res.stdout);
    report(true, { plan: plan.slug, mode: 'run', packages: packageCount, workPackages: file, spawned: ok, exitCode: res.status, next: ok ? `review the worktree changes, then \`brain:improve review ${plan.slug}\`` : 'coordinator failed — see output' });
  } else if (ok) {
    process.stdout.write(`\nWorktrees spawned. Each agent reads ${file}; work, then run \`brain:improve review ${plan.slug}\`. You merge (house rule — no auto-push/merge).\n`);
  }
  if (!ok) process.exit(res.status || 1);
}

function runGate(scriptName, gateArgs) {
  const res = spawnSync(process.execPath, [sibling(scriptName), ...gateArgs], { cwd: ROOT, encoding: 'utf8' });
  return { ran: true, ok: res.status === 0, status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function cmdReview(args) {
  const json = takeFlag(args, '--json');
  const baseline = takeOption(args, '--baseline');
  const variant = takeOption(args, '--variant');
  const id = args[0];
  if (!id) { process.stderr.write(`[brain:improve] review requires a plan slug\n${usage()}\n`); process.exit(1); }
  const plan = resolvePlan(id);
  if (!plan) process.exit(1);

  // Real gate #1 + #2: guardrails and drift, run as subprocesses.
  const guardRes = runGate('brain-guard.mjs', []);
  const guard = { ran: true, ok: guardRes.ok, detail: guardRes.ok ? 'guard passed' : `guard failed (exit ${guardRes.status})` };

  const verifyRes = runGate('brain-verify.mjs', ['--strict']);
  const verify = { ran: true, ok: verifyRes.ok, detail: verifyRes.ok ? 'no drift' : `drift detected (exit ${verifyRes.status})` };

  // Real gate #3 (conditional): the paired-bootstrap statistical gate. Only for
  // retrieval/quality-affecting plans, and only runnable when the agent supplies
  // the two eval reports. Required-but-missing reports => the gate FAILS.
  const required = needsEvalGate(plan);
  let evalCompare;
  if (!required) {
    evalCompare = { required: false, ran: false, ok: true, detail: 'not a retrieval/quality-affecting plan' };
  } else if (!baseline || !variant) {
    evalCompare = { required: true, ran: false, ok: false, detail: 'retrieval/quality change needs proof: pass --baseline <eval.json> --variant <eval.json> (generate with `brain:eval -- --out f.json`)' };
  } else {
    const evalRes = runGate('brain-eval-compare.mjs', [baseline, variant, '--hard-only']);
    let parsed = null;
    try { parsed = JSON.parse(evalRes.stdout); } catch { /* fall through to !ok */ }
    const verdict = evalVerdictOk(parsed);
    evalCompare = { required: true, ran: evalRes.ran, ok: evalRes.ok && verdict.ok, detail: evalRes.ok ? verdict.reason : `eval:compare failed (exit ${evalRes.status})` };
  }

  const summary = summarizeGate({ guard, verify, evalCompare });

  if (json) {
    report(true, { plan: plan.slug, category: plan.category, pass: summary.pass, evalGateRequired: required, reasons: summary.reasons, next: summary.pass ? 'brain:improve reconcile' : 'fix the failing gate(s) and re-run review' });
    process.exit(summary.pass ? 0 : 1);
  }

  const lines = [`# Review ${plan.slug} — ${summary.pass ? 'PASS' : 'FAIL'}`, ''];
  const mark = { pass: 'PASS', fail: 'FAIL', skipped: 'skip' };
  for (const r of summary.reasons) lines.push(`- [${mark[r.status] || r.status}] ${r.gate}: ${r.detail}`);
  lines.push('');
  lines.push(summary.pass
    ? 'All gates passed. Retire the resolved finding: `brain:improve reconcile`.'
    : 'Gate FAILED — fix the issue(s) above and re-run `brain:improve review`.');
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(summary.pass ? 0 : 1);
}

// ---------- main ----------

async function main() {
  const args = process.argv.slice(2);
  const help = takeFlag(args, '--help') || takeFlag(args, '-h');
  const sub = args.shift();
  if (help || !sub) { console.log(usage()); process.exit(help ? 0 : 1); }
  try {
    if (sub === 'status') return cmdStatus(args);
    if (sub === 'next') return await cmdNext(args);
    if (sub === 'plan') return await cmdPlan(args);
    if (sub === 'reconcile') return cmdReconcile(args);
    if (sub === 'list') return cmdList(args);
    if (sub === 'execute') return cmdExecute(args);
    if (sub === 'review') return cmdReview(args);
    process.stderr.write(`[brain:improve] unknown subcommand: ${sub}\n${usage()}\n`);
    process.exit(1);
  } catch (error) {
    process.stderr.write(`[brain:improve] ${error.message || error}\n`);
    process.exit(1);
  }
}

// Only run the CLI when invoked directly.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
