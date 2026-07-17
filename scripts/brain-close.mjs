/**
 * brain:close — end-of-session retrospective (the "/close" pattern).
 *
 * A composite command that DETERMINISTICALLY collects and prints a structured
 * end-of-session checklist so the next session doesn't rebuild context from
 * scratch. The brain gathers and structures; the AGENT in the session does the
 * synthesis (capturing the "why"). NO LLM in the brain — every section is a
 * mechanical read of existing state:
 *
 *   digest         — tagged lines the session-digest hook scraped into
 *                    .project-brain/sessions/YYYY-MM-DD-digest.md (Decided /
 *                    Memory / Followup), plus optional --transcript extraction
 *                    via scripts/brain-session-digest.mjs#extractTags.
 *   open leases    — active file leases from active_state.md (who's holding what).
 *   ADR candidates — open/planned findings (scripts/findings.mjs) whose rationale
 *                    is worth capturing as a decision before it evaporates.
 *   learn candidates — staged eval cases from brain:learn (usage the benchmark
 *                    could grow from).
 *   commit SUGGESTION — a message skeleton + file list derived from
 *                    `git status --short` / `git diff --stat`. A SUGGESTION only:
 *                    brain:close never stages or commits — the human-merge
 *                    boundary stays. The agent fills the <summary>.
 *
 * WRITES: only a session-log entry under .project-brain/sessions/ (derived,
 * gitignored). Never a record under decisions/ or findings/. Never a commit.
 * `--dry-run` skips even the session-log write.
 *
 * On a clean/quiet repo (nothing changed, no leases, no digest, no candidates)
 * it prints a minimal note and writes nothing of substance.
 *
 * The collection core (collectCloseChecklist + helpers) is PURE and exported so
 * it is unit-tested without a repo. See decisions/... (#27).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  BRAIN_DIR,
  ROOT,
  ensureDir,
  exists,
  read,
  write,
  takeFlag,
  takeOption,
  gitBranchSafe
} from './common.mjs';
import { activeStateJson } from './active-state.mjs';
import { loadFindings } from './findings.mjs';
import { loadCandidates, dedupeCandidates } from './brain-learn.mjs';
import { extractTags, SESSIONS_DIR } from './brain-session-digest.mjs';

// ---------------------------------------------------------------------------
// Pure collection core (exported, unit-tested) — no I/O.
// ---------------------------------------------------------------------------

/** Parse `git status --short` porcelain into structured entries. PURE. */
export function parseGitStatusShort(text) {
  const entries = [];
  for (const line of String(text || '').split('\n')) {
    if (line.trim() === '') continue;
    const x = line[0];
    const y = line[1];
    let p = line.slice(3).trim();
    if (p.includes(' -> ')) p = p.split(' -> ').pop().trim(); // rename: keep the new path
    p = p.replace(/^"|"$/g, ''); // git quotes paths with odd chars
    if (!p) continue;
    const untracked = x === '?' && y === '?';
    const staged = !untracked && x !== ' ';
    const deleted = x === 'D' || y === 'D';
    entries.push({ x, y, path: p, staged, untracked, deleted });
  }
  return entries;
}

/**
 * Deterministic Conventional-Commit type from the changed file set. PURE.
 * docs-only → docs, tests-only → test, otherwise feat (the honest default for a
 * mixed working tree — the agent downgrades to fix/chore when it knows better).
 */
export function suggestCommitType(files = []) {
  const list = files.filter(Boolean);
  if (!list.length) return 'chore';
  const isDoc = (f) => /\.mdx?$/i.test(f) || /(^|\/)docs\//.test(f) || /(^|\/)README/i.test(f);
  const isTest = (f) => /\.(test|spec)\.[a-z]+$/i.test(f) || /(^|\/)(tests?|__tests__|e2e)\//.test(f);
  if (list.every(isDoc)) return 'docs';
  if (list.every(isTest)) return 'test';
  return 'feat';
}

/**
 * Deterministic commit scope from the changed file set. PURE. Brain-plumbing
 * paths collapse to `brain` (mirrors the repo's own `feat(brain): ...` habit);
 * otherwise the most common top-level directory wins (ties → alphabetical).
 */
export function suggestScope(files = []) {
  const list = files.filter(Boolean);
  if (!list.length) return '';
  const isBrain = (f) =>
    /(^|\/)scripts\/brain-/.test(f) ||
    /^SKILL\.md$/.test(f) ||
    /(^|\/)references\//.test(f) ||
    /(^|\/)\.project-brain\//.test(f);
  if (list.some(isBrain)) return 'brain';
  const counts = new Map();
  for (const f of list) {
    const seg = f.includes('/') ? f.split('/')[0] : '';
    if (seg) counts.set(seg, (counts.get(seg) || 0) + 1);
  }
  if (!counts.size) return '';
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

/**
 * Build the commit-message SUGGESTION from parsed status + diff stat. PURE.
 * Returns null when nothing changed. The subject is a skeleton — the <summary>
 * placeholder is intentional: NO LLM, so the agent supplies the "why". This is
 * a suggestion the human accepts/edits; brain:close never runs git commit.
 */
export function suggestCommitMessage(status = {}) {
  const entries = status.entries || [];
  const files = entries.map((e) => e.path);
  if (!files.length) return null;
  const type = suggestCommitType(files);
  const scope = suggestScope(files);
  return {
    subject: `${type}${scope ? `(${scope})` : ''}: <summarize this change>`,
    files,
    changedCount: files.length,
    stagedCount: entries.filter((e) => e.staged).length,
    untrackedCount: entries.filter((e) => e.untracked).length,
    diffStat: String(status.diffStat || '').trim()
  };
}

/**
 * ADR candidates = active (open/planned) findings whose rationale is worth a
 * decision record. PURE. Sorted by impact desc, then slug. resolved/wontfix are
 * excluded (already closed out). We never write an ADR here — we only surface
 * the candidate; brain:adr (a human-boundary write) records it.
 */
export function adrCandidatesFromFindings(findings = []) {
  const active = new Set(['open', 'planned']);
  return (findings || [])
    .filter((f) => f && active.has(String(f.status || '').toLowerCase()))
    .map((f) => ({
      slug: f.slug || '',
      title: f.title || '',
      category: f.category || '',
      status: f.status || '',
      impact: Number(f.impact) || 0
    }))
    .sort((a, b) => b.impact - a.impact || String(a.slug).localeCompare(String(b.slug)));
}

/**
 * PURE: assemble the structured end-of-session checklist from already-gathered
 * (I/O-free) inputs. Decides `quiet` — true when there is genuinely nothing to
 * report (clean tree, no leases, no digest, no candidates), which the caller
 * renders as a minimal note.
 */
export function collectCloseChecklist(inputs = {}) {
  const digest = [...new Set((inputs.digestLines || []).map((s) => String(s).trim()).filter(Boolean))];
  const openLeases = (inputs.leases || []).filter((l) => l && l.target && l.target !== '_None_');
  const adrCandidates = adrCandidatesFromFindings(inputs.findings || []);
  const learnCandidates = (inputs.learnCandidates || [])
    .filter((c) => c && String(c.query || '').trim())
    .map((c) => ({
      query: String(c.query).trim(),
      used: Array.isArray(c.used) ? c.used.filter(Boolean) : [],
      uses: Number.isFinite(c.uses) ? c.uses : 1
    }));
  const commit = suggestCommitMessage(inputs.status || {});
  const quiet =
    digest.length === 0 &&
    openLeases.length === 0 &&
    adrCandidates.length === 0 &&
    learnCandidates.length === 0 &&
    !commit;
  return {
    branch: inputs.branch || '',
    actor: inputs.actor || '',
    quiet,
    digest,
    openLeases,
    adrCandidates,
    learnCandidates,
    commit,
    counts: {
      digest: digest.length,
      leases: openLeases.length,
      adrCandidates: adrCandidates.length,
      learnCandidates: learnCandidates.length,
      changed: commit ? commit.changedCount : 0,
      staged: commit ? commit.stagedCount : 0
    }
  };
}

// ---------------------------------------------------------------------------
// Rendering (PURE, exported).
// ---------------------------------------------------------------------------

const MINIMAL_NOTE = 'Nothing to close out: clean working tree, no held leases, no digest, no candidates. Session was quiet.';

/** Render the checklist as human-readable stdout. PURE. */
export function renderChecklist(cl) {
  const lines = [];
  const head = `# brain:close — end-of-session checklist${cl.branch ? ` (${cl.branch})` : ''}`;
  lines.push(head, '');
  if (cl.quiet) {
    lines.push(MINIMAL_NOTE);
    return lines.join('\n') + '\n';
  }

  lines.push('## Session digest');
  if (cl.digest.length) for (const d of cl.digest) lines.push(d.startsWith('-') ? d : `- ${d}`);
  else lines.push('- (none captured — tag work with `## Decided:` / `## Memory:` / `## Followup:` to feed the digest hook)');
  lines.push('');

  lines.push(`## Open leases (${cl.openLeases.length})`);
  if (cl.openLeases.length) {
    for (const l of cl.openLeases) {
      const who = l.lockedBy ? ` — ${l.lockedBy}` : '';
      const until = l.until ? ` (until ${l.until})` : '';
      lines.push(`- ${l.target}${who}${until}`);
    }
    lines.push('  → release with `brain:lease` if you are done editing these.');
  } else lines.push('- none held.');
  lines.push('');

  lines.push(`## ADR candidates — unwritten findings (${cl.adrCandidates.length})`);
  if (cl.adrCandidates.length) {
    for (const f of cl.adrCandidates) lines.push(`- [${f.status}/${f.category}] ${f.title || f.slug} (${f.slug})`);
    lines.push('  → capture rationale with `brain:adr` before it evaporates.');
  } else lines.push('- none.');
  lines.push('');

  lines.push(`## brain:learn candidates (${cl.learnCandidates.length})`);
  if (cl.learnCandidates.length) {
    for (const c of cl.learnCandidates) lines.push(`- "${c.query}" → ${c.used.join(', ') || '(no files)'} (uses=${c.uses})`);
    lines.push('  → `brain:learn promote` to grow the eval set (never changes ranking).');
  } else lines.push('- none staged.');
  lines.push('');

  lines.push('## Commit suggestion (SUGGESTION only — you stage & commit)');
  if (cl.commit) {
    lines.push('```');
    lines.push(cl.commit.subject);
    lines.push('```');
    lines.push(`Changed: ${cl.commit.changedCount} file(s), ${cl.commit.stagedCount} staged, ${cl.commit.untrackedCount} untracked.`);
    if (cl.commit.diffStat) {
      lines.push('', 'diff --stat:');
      for (const s of cl.commit.diffStat.split('\n')) lines.push(`  ${s}`);
    }
    lines.push('', 'brain:close never stages or commits — the human-merge boundary stays.');
  } else lines.push('- clean working tree — nothing to commit.');
  lines.push('');
  return lines.join('\n') + '\n';
}

/** Render the checklist as the session-log markdown entry appended to sessions/. PURE. */
export function renderSessionLog(cl, meta = {}) {
  const ts = meta.timestamp || new Date().toISOString();
  const lines = [];
  lines.push(`## close ${ts}${cl.branch ? ` — ${cl.branch}` : ''}`);
  if (cl.quiet) {
    lines.push(MINIMAL_NOTE);
    return lines.join('\n') + '\n';
  }
  if (cl.digest.length) {
    lines.push('', '### Digest');
    for (const d of cl.digest) lines.push(d.startsWith('-') ? d : `- ${d}`);
  }
  if (cl.openLeases.length) {
    lines.push('', `### Open leases (${cl.openLeases.length})`);
    for (const l of cl.openLeases) lines.push(`- ${l.target}${l.lockedBy ? ` — ${l.lockedBy}` : ''}`);
  }
  if (cl.adrCandidates.length) {
    lines.push('', `### ADR candidates (${cl.adrCandidates.length})`);
    for (const f of cl.adrCandidates) lines.push(`- ${f.title || f.slug} (${f.slug})`);
  }
  if (cl.learnCandidates.length) {
    lines.push('', `### brain:learn candidates (${cl.learnCandidates.length})`);
    for (const c of cl.learnCandidates) lines.push(`- "${c.query}" (uses=${c.uses})`);
  }
  if (cl.commit) {
    lines.push('', '### Commit suggestion (suggestion only)', '```', cl.commit.subject, '```');
    lines.push(`Changed ${cl.commit.changedCount} file(s), ${cl.commit.stagedCount} staged.`);
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// I/O gathering + CLI (untested beyond a spawn sanity check).
// ---------------------------------------------------------------------------

function gitStatusShort() {
  try {
    return execSync('git status --short', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return ''; }
}
function gitDiffStat() {
  try {
    // Include both worktree and staged changes in the stat display.
    return execSync('git diff --stat HEAD', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    try {
      return execSync('git diff --stat', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return ''; }
  }
}

/** Today's digest bullet lines scraped by the session-digest hook, plus optional transcript extraction. */
function gatherDigestLines(transcriptPath) {
  const out = [];
  try {
    if (exists(SESSIONS_DIR)) {
      const today = new Date().toISOString().slice(0, 10);
      for (const name of fs.readdirSync(SESSIONS_DIR).sort()) {
        if (!name.startsWith(today) || !name.endsWith('-digest.md')) continue;
        for (const line of read(path.join(SESSIONS_DIR, name)).split('\n')) {
          if (/^-\s+\*\*(Decided|Memory|Followup):\*\*/.test(line.trim())) out.push(line.trim());
        }
      }
    }
  } catch (error) {
    process.stderr.write(`[brain:close] digest read skipped: ${error.message || error}\n`);
  }
  if (transcriptPath) {
    try {
      for (const hit of extractTags(transcriptPath)) out.push(hit);
    } catch (error) {
      process.stderr.write(`[brain:close] transcript extraction skipped: ${error.message || error}\n`);
    }
  }
  return out;
}

function gather(opts = {}) {
  const status = {
    entries: parseGitStatusShort(gitStatusShort()),
    diffStat: gitDiffStat()
  };
  let leases = [];
  try { leases = activeStateJson().leases || []; }
  catch (error) { process.stderr.write(`[brain:close] leases read skipped: ${error.message || error}\n`); }
  let findings = [];
  try { findings = loadFindings(); }
  catch (error) { process.stderr.write(`[brain:close] findings read skipped: ${error.message || error}\n`); }
  let learnCandidates = [];
  try { learnCandidates = dedupeCandidates(loadCandidates()); }
  catch (error) { process.stderr.write(`[brain:close] learn candidates read skipped: ${error.message || error}\n`); }
  return {
    branch: gitBranchSafe(),
    actor: process.env.BRAIN_ACTOR || '',
    status,
    leases,
    findings,
    learnCandidates,
    digestLines: gatherDigestLines(opts.transcript)
  };
}

function usage() {
  return [
    'Usage:',
    '  npm run brain:close [--json] [--dry-run] [--transcript <path>]',
    '',
    'Collects and prints a deterministic end-of-session checklist: session digest,',
    'open leases, ADR candidates (unwritten findings), brain:learn candidates, and a',
    'commit-message SUGGESTION (brain:close never stages or commits). Writes only a',
    "session-log entry under .project-brain/sessions/ (--dry-run skips even that)."
  ].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  if (takeFlag(args, '--help') || takeFlag(args, '-h')) { console.log(usage()); process.exit(0); }
  const json = takeFlag(args, '--json');
  const dryRun = takeFlag(args, '--dry-run');
  const transcript = takeOption(args, '--transcript').trim();

  const inputs = gather({ transcript });
  const checklist = collectCloseChecklist(inputs);

  let sessionLogPath = '';
  if (!dryRun) {
    try {
      ensureDir(SESSIONS_DIR);
      const date = new Date().toISOString().slice(0, 10);
      const target = path.join(SESSIONS_DIR, `${date}-close.md`);
      const header = exists(target) ? '\n' : `# Session close log — ${date}\n\n`;
      fs.appendFileSync(target, header + renderSessionLog(checklist, { timestamp: new Date().toISOString() }));
      sessionLogPath = path.relative(ROOT, target);
    } catch (error) {
      process.stderr.write(`[brain:close] session-log write skipped: ${error.message || error}\n`);
    }
  }

  if (json) {
    process.stdout.write(JSON.stringify({ ...checklist, sessionLog: sessionLogPath || null, dryRun }, null, 2) + '\n');
    return;
  }
  process.stdout.write(renderChecklist(checklist));
  if (sessionLogPath) process.stdout.write(`\nsession-log: ${sessionLogPath}\n`);
  else if (dryRun) process.stdout.write('\n(dry run — no session-log written)\n');
}

// Only run the CLI when invoked directly; importing for unit tests must not
// trigger argv parsing / process.exit / git I/O.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[brain:close] ${error.message || error}\n`);
    process.exit(1);
  }
}
