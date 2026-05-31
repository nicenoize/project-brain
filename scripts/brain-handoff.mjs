/**
 * Hand-off document generator for vacation, illness, or planned absences.
 *
 * Generates HANDOFF.md at each project root (readable by colleagues who don't
 * use brain) and a consolidated handoff doc in .project-brain/handoffs/.
 * Reads active_state.md (workstreams + leases), git log/status, recent
 * `.project-brain/decisions/*.md`, and (best-effort) `gh pr list` to build
 * a self-contained brief.
 *
 * Subcommands:
 *   prepare [--until YYYY-MM-DD] [--to NAME] [--from NAME] [--reason ...]
 *           [--contact ...] [--write] [--commit] [--json]
 *   status  [--json]
 *   end     [--json]
 *
 * Hand-off state lives at .project-brain/handoff-state.json so `end` can
 * compute "what changed since handoff started" across all repos.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  BRAIN_DIR,
  ROOT,
  ensureDir,
  exists,
  read,
  write,
  takeFlag,
  takeOption
} from './common.mjs';
import { activeStateJson } from './active-state.mjs';
import { discoverProjects, isFleetMode } from './projects.mjs';

const HANDOFF_STATE = path.join(BRAIN_DIR, 'handoff-state.json');
const HANDOFFS_DIR = path.join(BRAIN_DIR, 'handoffs');

// Git --pretty=format placeholders: %x09 emits a tab byte. Tabs almost never
// appear in commit subjects/authors, so splitting on '\t' is safe and
// portable (no SOH / control-byte tricks).
const TAB = '%x09';
const SEP = '\t';

const args = process.argv.slice(2);
const command = args.shift() || 'status';
const help = takeFlag(args, '--help') || takeFlag(args, '-h');

if (help || !['prepare', 'status', 'end'].includes(command)) {
  printUsage();
  process.exit(help ? 0 : 1);
}

try {
  if (command === 'prepare') await prepare();
  else if (command === 'status') await status();
  else if (command === 'end') await endHandoff();
} catch (error) {
  process.stderr.write(`[brain:handoff] ${error.message || error}\n`);
  process.exit(1);
}

function printUsage() {
  console.log(`Usage:
  npm run brain:handoff -- prepare [--until YYYY-MM-DD] [--to NAME] [--from NAME]
                                    [--reason vacation|illness|other] [--contact "..."]
                                    [--write] [--commit] [--json]
  npm run brain:handoff -- status [--json]
  npm run brain:handoff -- end [--json]

prepare:
  Generates a self-contained brief. Without --write prints to stdout.
  With --write writes:
    - <project>/HANDOFF.md          per project root (single source for colleagues)
    - .project-brain/handoffs/YYYY-MM-DD-handoff.md   (consolidated)
    - .project-brain/handoff-state.json                (machine-readable state)
  With --commit also runs git add + commit per project (best-effort).

status:
  Reports whether a hand-off is currently active and when it ends.

end:
  Run when you return. Summarizes what changed in every repo since the
  hand-off started (commits, PRs). Clears the active flag.`);
}

async function prepare() {
  const until = takeOption(args, '--until') || '';
  const to = takeOption(args, '--to') || '';
  const from = takeOption(args, '--from') || process.env.BRAIN_ACTOR || process.env.USER || 'me';
  const reason = takeOption(args, '--reason') || 'absence';
  const contact = takeOption(args, '--contact') || '';
  const doWrite = takeFlag(args, '--write');
  const doCommit = takeFlag(args, '--commit');
  const asJson = takeFlag(args, '--json');

  const startedAt = new Date().toISOString();
  const state = safeActiveState();
  const projects = discoverProjects(ROOT);
  const fleet = isFleetMode(projects);
  const projectList = fleet
    ? projects.map(p => ({ name: p.name, dir: p.dir }))
    : [{ name: '.', dir: '.' }];

  const perProject = projectList.map(p => collectProjectStatus(p, state, fleet));
  const decisions = listRecentDecisions(30);
  const consolidated = renderConsolidatedDoc({
    from, to, until, reason, contact, startedAt, perProject, decisions, fleet
  });

  if (asJson) {
    console.log(JSON.stringify({
      startedAt, from, to, until, reason, contact, fleet, perProject, decisions
    }, null, 2));
    return;
  }

  if (!doWrite) {
    console.log(consolidated);
    return;
  }

  ensureDir(HANDOFFS_DIR);
  const dateSlug = startedAt.slice(0, 10);
  const consolidatedPath = path.join(HANDOFFS_DIR, `${dateSlug}-handoff.md`);
  write(consolidatedPath, consolidated);
  console.log(`Wrote consolidated handoff: ${path.relative(ROOT, consolidatedPath)}`);

  const writtenPerRepo = [];
  for (const p of perProject) {
    const projRoot = p.dir === '.' ? ROOT : path.join(ROOT, p.dir);
    if (!exists(projRoot)) continue;
    const perRepoDoc = renderPerRepoDoc({ from, to, until, reason, contact, project: p });
    const perRepoPath = path.join(projRoot, 'HANDOFF.md');
    write(perRepoPath, perRepoDoc);
    writtenPerRepo.push(perRepoPath);
    console.log(`Wrote per-repo handoff: ${path.relative(ROOT, perRepoPath)}`);
  }

  const stateObj = {
    active: true,
    startedAt,
    until: until || null,
    to: to || null,
    from,
    reason,
    contact: contact || null,
    fleet,
    consolidatedPath: path.relative(ROOT, consolidatedPath),
    perRepoPaths: writtenPerRepo.map(p => path.relative(ROOT, p)),
    projects: perProject.map(p => ({ name: p.name, dir: p.dir, branch: p.branch }))
  };
  ensureDir(BRAIN_DIR);
  write(HANDOFF_STATE, `${JSON.stringify(stateObj, null, 2)}\n`);
  console.log(`Wrote handoff state: ${path.relative(ROOT, HANDOFF_STATE)}`);

  if (doCommit) {
    const message = `docs: hand-off ${until ? `until ${until}` : 'in effect'} (${reason})`;
    for (const p of perProject) {
      const projRoot = p.dir === '.' ? ROOT : path.join(ROOT, p.dir);
      const result = tryCommitHandoff(projRoot, message);
      if (result.ok) console.log(`Committed HANDOFF.md in ${p.name}`);
      else console.warn(`Could not commit HANDOFF.md in ${p.name}: ${result.reason}`);
    }
  }

  console.log(`\nHand-off prepared. ${until ? `Marked until ${until}. ` : ''}When you're back: npm run brain:handoff -- end`);
}

async function status() {
  const asJson = takeFlag(args, '--json');
  if (!exists(HANDOFF_STATE)) {
    if (asJson) console.log(JSON.stringify({ active: false }, null, 2));
    else console.log('No hand-off active.');
    return;
  }
  const stateObj = JSON.parse(read(HANDOFF_STATE));
  if (asJson) {
    console.log(JSON.stringify(stateObj, null, 2));
    return;
  }
  console.log(`Hand-off active: ${stateObj.from}${stateObj.to ? ` → ${stateObj.to}` : ''}`);
  console.log(`Started: ${stateObj.startedAt}`);
  if (stateObj.until) console.log(`Until: ${stateObj.until}`);
  if (stateObj.reason) console.log(`Reason: ${stateObj.reason}`);
  if (stateObj.contact) console.log(`Contact: ${stateObj.contact}`);
  if (stateObj.consolidatedPath) console.log(`Consolidated doc: ${stateObj.consolidatedPath}`);
  console.log(`\nWhen back: npm run brain:handoff -- end`);
}

async function endHandoff() {
  const asJson = takeFlag(args, '--json');
  if (!exists(HANDOFF_STATE)) {
    process.stderr.write('No hand-off active.\n');
    process.exit(1);
  }
  const stateObj = JSON.parse(read(HANDOFF_STATE));
  if (!stateObj.active) {
    process.stderr.write('Hand-off marker exists but is not active.\n');
    process.exit(1);
  }
  const startedAt = stateObj.startedAt;
  const projects = discoverProjects(ROOT);
  const fleet = isFleetMode(projects);
  const projectList = fleet
    ? projects.map(p => ({ name: p.name, dir: p.dir }))
    : [{ name: '.', dir: '.' }];

  const report = { since: startedAt, fleet, projects: [] };
  for (const proj of projectList) {
    const projRoot = proj.dir === '.' ? ROOT : path.join(ROOT, proj.dir);
    if (!exists(path.join(projRoot, '.git'))) continue;
    const fmt = `%h${TAB}%s${TAB}%an`;
    const commits = sh(`git log --since=${q(startedAt)} --pretty=format:${q(fmt)}`, projRoot)
      .split('\n').filter(Boolean)
      .map(line => {
        const [hash, subject, author] = line.split(SEP);
        return { hash: hash || '', subject: subject || '', author: author || '' };
      })
      .slice(0, 50);
    let mergedPrs = [];
    let openPrs = [];
    if (hasGh()) {
      mergedPrs = ghPrListSince(projRoot, 'merged', startedAt);
      openPrs = ghPrListSince(projRoot, 'open', startedAt);
    }
    report.projects.push({ name: proj.name, newCommits: commits, mergedPrs, openPrs });
  }

  if (asJson) console.log(JSON.stringify(report, null, 2));
  else printEndReport(report, startedAt);

  stateObj.active = false;
  stateObj.endedAt = new Date().toISOString();
  write(HANDOFF_STATE, `${JSON.stringify(stateObj, null, 2)}\n`);
  console.log(`\nHand-off marked ended (state preserved at ${path.relative(ROOT, HANDOFF_STATE)}).`);
  console.log('To remove the per-repo briefs: delete each `HANDOFF.md` (or rely on the next prepare to overwrite).');
}

function printEndReport(report, startedAt) {
  console.log(`# What changed while you were away`);
  console.log('');
  console.log(`Hand-off period: ${startedAt} → ${new Date().toISOString()}`);
  console.log('');
  for (const p of report.projects) {
    const label = p.name === '.' ? '(this repo)' : p.name;
    console.log(`## ${label}`);
    console.log('');
    console.log(`### New commits (${p.newCommits.length})`);
    if (p.newCommits.length) {
      for (const c of p.newCommits) console.log(`- \`${c.hash}\` ${c.subject} _(by ${c.author})_`);
    } else {
      console.log('- None');
    }
    console.log('');
    if (p.mergedPrs.length) {
      console.log(`### PRs merged during absence (${p.mergedPrs.length})`);
      for (const pr of p.mergedPrs) {
        console.log(`- #${pr.number} ${pr.title} — merged ${pr.mergedAt?.slice(0, 10) || ''} by ${pr.author?.login || 'unknown'}`);
      }
      console.log('');
    }
    if (p.openPrs.length) {
      console.log(`### PRs still open`);
      for (const pr of p.openPrs) {
        console.log(`- #${pr.number} ${pr.title}${pr.isDraft ? ' [draft]' : ''}`);
      }
      console.log('');
    }
  }
}

// ---- collection helpers ----

function safeActiveState() {
  try { return activeStateJson(); }
  catch { return { workstreams: [], leases: [], blockers: [], overlaps: [] }; }
}

function collectProjectStatus(proj, state, fleet) {
  const projRoot = proj.dir === '.' ? ROOT : path.join(ROOT, proj.dir);
  const branch = sh('git rev-parse --abbrev-ref HEAD', projRoot);
  const oneFmt = `%h${TAB}%s${TAB}%ar`;
  const lastRaw = sh(`git log -1 --pretty=format:${q(oneFmt)}`, projRoot);
  let lastCommit = '';
  if (lastRaw) {
    const [h, s, a] = lastRaw.split(SEP);
    lastCommit = `${h} ${s} (${a})`;
  }
  const uncommitted = sh('git status --porcelain', projRoot).split('\n').filter(Boolean);
  const recentFmt = `%h${TAB}%s`;
  const recent = sh(`git log --since="7 days ago" --pretty=format:${q(recentFmt)}`, projRoot)
    .split('\n').filter(Boolean)
    .map(line => {
      const [h, s] = line.split(SEP);
      return `${h} ${s || ''}`;
    })
    .slice(0, 10);

  // In fleet mode, filter active_state rows by project; in single-project
  // mode pass through everything (legacy rows have empty project column).
  const workstreams = (state.workstreams || []).filter(w =>
    fleet ? w.project === proj.name : true
  );
  const leases = (state.leases || []).filter(l =>
    fleet ? l.project === proj.name : true
  );

  let openPrs = [];
  if (hasGh()) openPrs = ghPrListOpen(projRoot);

  return {
    name: proj.name,
    dir: proj.dir,
    branch,
    lastCommit,
    uncommitted,
    recentCommits: recent,
    workstreams,
    leases,
    openPrs
  };
}

function listRecentDecisions(days) {
  const dir = path.join(BRAIN_DIR, 'decisions');
  if (!exists(dir)) return [];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const items = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    const full = path.join(dir, file);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.mtimeMs < cutoff) continue;
    const content = read(full);
    const titleMatch = content.match(/^#\s+(.+)$/m);
    items.push({ file, title: titleMatch ? titleMatch[1] : file, mtime: stat.mtime.toISOString() });
  }
  return items
    .sort((a, b) => b.mtime.localeCompare(a.mtime))
    .slice(0, 10);
}

// ---- renderers ----

function renderConsolidatedDoc({ from, to, until, reason, contact, startedAt, perProject, decisions, fleet }) {
  const recipient = to ? ` → ${to}` : '';
  const untilStr = until ? ` until ${until}` : '';
  const lines = [
    `# Hand-off — ${from}${recipient}${untilStr}`,
    '',
    `> Prepared ${startedAt.slice(0, 10)} • Reason: ${reason}${contact ? ` • Contact: ${contact}` : ''}`,
    '',
    '## TL;DR',
    '',
    summarizeTldr(perProject),
    '',
    `## Where I'll be`,
    '',
    `- Away: ${startedAt.slice(0, 10)}${until ? ` → ${until}` : ' → (no fixed return)'}`,
    `- Contact: ${contact || '_not reachable_'}`,
    '',
    '## In flight',
    ''
  ];

  for (const p of perProject) {
    const label = p.name === '.' ? '(this repo)' : p.name;
    lines.push(`### ${label}`);
    lines.push('');
    if (p.branch) lines.push(`- **Current branch**: \`${p.branch}\``);
    if (p.lastCommit) lines.push(`- **Last commit**: ${p.lastCommit}`);
    if (p.uncommitted.length) {
      lines.push(`- **Uncommitted local changes** (do not lose these):`);
      for (const u of p.uncommitted.slice(0, 20)) lines.push(`  - \`${u}\``);
    }
    if (p.workstreams.length) {
      lines.push(`- **Active workstreams**:`);
      for (const w of p.workstreams) {
        lines.push(`  - \`${w.taskId}\` — ${w.status || 'active'} — ${w.scope || ''} (branch: \`${w.branch || 'n/a'}\`)`);
      }
    }
    if (p.leases.length) {
      lines.push(`- **File leases** (work-in-progress files):`);
      for (const l of p.leases) {
        lines.push(`  - \`${l.target}\`${l.notes ? ` — ${l.notes}` : ''}`);
      }
    }
    if (p.openPrs.length) {
      lines.push(`- **Open PRs**:`);
      for (const pr of p.openPrs) {
        const draft = pr.isDraft ? ' [draft]' : '';
        lines.push(`  - #${pr.number} — ${pr.title} (branch: \`${pr.headRefName || ''}\`)${draft}`);
      }
    }
    if (p.recentCommits.length) {
      lines.push(`- **Recent commits (7d)**:`);
      for (const c of p.recentCommits) lines.push(`  - ${c}`);
    }
    lines.push('');
  }

  if (decisions.length) {
    lines.push('## Recent decisions (30d)');
    lines.push('');
    for (const d of decisions) lines.push(`- \`${d.file}\` — ${d.title}`);
    lines.push('');
  }

  lines.push(`## What's OK to do without me`);
  lines.push('');
  lines.push('- Review and merge existing PRs (follow standard review rules)');
  lines.push('- Hotfixes for production incidents (use `hotfix/<issue>-…` branches)');
  lines.push('- New work that does not touch in-progress workstreams above');
  lines.push('');
  lines.push('## What to wait for me on');
  lines.push('');
  lines.push('- Non-urgent breaking changes to in-flight workstreams');
  lines.push('- Decisions affecting the modules listed under workstream scope above');
  lines.push('- Any merge that would lose the uncommitted local changes listed above');
  lines.push('');
  lines.push('## When I return');
  lines.push('');
  lines.push(fleet
    ? 'Run from the fleet root: `npm run brain:handoff -- end`'
    : 'Run: `npm run brain:handoff -- end`');
  lines.push('');
  lines.push('That will summarize every commit and PR that landed across all repos during the absence.');
  lines.push('');

  return lines.join('\n');
}

function renderPerRepoDoc({ from, to, until, reason, contact, project }) {
  const label = project.name === '.' ? 'this repo' : project.name;
  const lines = [
    `# Hand-off (${label}) — ${from}${to ? ` → ${to}` : ''}${until ? ` until ${until}` : ''}`,
    '',
    `> ${reason}${contact ? ` • ${contact}` : ' • not reachable'}`,
    '',
    `**Current branch**: \`${project.branch || 'unknown'}\`  `,
    `**Last commit**: ${project.lastCommit || 'unknown'}`,
    ''
  ];
  if (project.uncommitted.length) {
    lines.push('## ⚠️ Uncommitted local changes — do not lose');
    lines.push('');
    for (const u of project.uncommitted.slice(0, 20)) lines.push(`- \`${u}\``);
    lines.push('');
  }
  if (project.workstreams.length || project.leases.length) {
    lines.push('## In flight');
    lines.push('');
    for (const w of project.workstreams) {
      lines.push(`- **${w.taskId}**: ${w.scope || ''} (branch: \`${w.branch || 'n/a'}\`, status: ${w.status || 'active'})`);
    }
    for (const l of project.leases) {
      lines.push(`- File in progress: \`${l.target}\`${l.notes ? ` — ${l.notes}` : ''}`);
    }
    lines.push('');
  }
  if (project.openPrs.length) {
    lines.push('## Open PRs');
    lines.push('');
    for (const pr of project.openPrs) {
      lines.push(`- #${pr.number} ${pr.title}${pr.isDraft ? ' [draft]' : ''}`);
    }
    lines.push('');
  }
  lines.push('## OK to do');
  lines.push('- Review/merge existing PRs (standard rules)');
  lines.push('- Hotfixes for production incidents');
  lines.push('- New work that does not touch the in-flight items above');
  lines.push('');
  lines.push('## Wait for me on');
  lines.push('- Non-urgent breaking changes to in-flight workstreams');
  lines.push('- Anything that would drop the uncommitted changes above');
  lines.push('');
  return lines.join('\n');
}

function summarizeTldr(perProject) {
  const total = perProject.reduce((acc, p) => acc + p.workstreams.length, 0);
  const repos = perProject
    .filter(p => p.workstreams.length || p.leases.length || p.uncommitted.length)
    .map(p => p.name === '.' ? 'this repo' : p.name);
  if (!total && !repos.length) {
    return 'No active workstreams or uncommitted work across the fleet. Safe to ignore until I am back.';
  }
  return `${total} active workstream(s) across ${repos.length || perProject.length} repo(s): ${repos.join(', ') || 'all'}. See details below.`;
}

// ---- git / gh ----

function sh(cmd, cwd) {
  try { return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

function q(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function hasGh() {
  try {
    execSync('command -v gh', { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function ghPrListOpen(cwd) {
  try {
    const raw = sh(`gh pr list --state open --json number,title,headRefName,author,isDraft --limit 20`, cwd);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function ghPrListSince(cwd, state, sinceIso) {
  try {
    const flag = state === 'merged' ? '--state merged' : '--state open';
    const raw = sh(`gh pr list ${flag} --json number,title,state,author,mergedAt,updatedAt,isDraft --limit 50`, cwd);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    const since = Date.parse(sinceIso);
    return arr.filter(pr => {
      const stamp = pr.mergedAt || pr.updatedAt;
      return stamp ? Date.parse(stamp) >= since : true;
    });
  } catch { return []; }
}

function tryCommitHandoff(cwd, message) {
  try {
    execSync('git add HANDOFF.md', { cwd, stdio: 'ignore' });
    execSync(`git commit -m ${q(message)}`, { cwd, stdio: 'ignore' });
    return { ok: true };
  } catch (err) {
    const text = String(err.message || err).split('\n')[0];
    return { ok: false, reason: text };
  }
}
