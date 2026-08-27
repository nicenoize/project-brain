#!/usr/bin/env node
/**
 * SessionStart STATE digest — a deterministic, read-only, 1-page summary of
 * `.project-brain/active_state.md`, hard-capped at a byte budget and printed
 * to stdout for the Claude Code SessionStart hook (settings.recommended.json).
 *
 * It replaces the historical raw `cat .project-brain/active_state.md` hook
 * line: in the field that raw cat cost ≈30 kB ≈ 7,555 tokens on EVERY session
 * start (decisions/0024 + docs/eval-methodology.md consumer baseline). The
 * digest is budgeted at BUDGETS.stateDigestBytes (default 8,000 B ≈ 2k tok;
 * env override BRAIN_STATE_DIGEST_BUDGET_BYTES) — enforced red-build by
 * tests/footprint-budget.test.mjs.
 *
 * NOT to be confused with scripts/brain-session-digest.mjs: that script is the
 * PreCompact/Stop TRANSCRIPT digest (scrapes `## Decided:/Memory:/Followup:`
 * tags out of the conversation transcript and appends them to
 * `.project-brain/sessions/`). This one never reads transcripts and never
 * writes anything — it reads active state + session filenames and prints a
 * capped summary.
 *
 * Content, in priority order (finished workstreams / expired leases are
 * DROPPED first — only counted — then whole lines are truncated with an
 * explicit marker so the agent knows the digest is partial):
 *   1. active workstreams (compact one-liners)
 *   2. open leases with owner + TTL
 *   3. blockers / overlaps bullets
 *   4. the 3 most recent session pointer files
 *
 * Pure core `buildStateDigest(state, { budgetBytes, now })` is exported and
 * unit-tested. Parsing is reused from active-state.mjs (activeStateJson).
 * Hook contract: always exits 0; errors go to stderr only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVE_STATE, activeStateJson } from './active-state.mjs';
import { BRAIN_DIR } from './common.mjs';
import { stateDigestBudgetBytes } from './footprint.mjs';

/** Appended when the budget forces line truncation — points at the full report. */
export const TRUNCATION_MARKER = '[digest truncated — run: project-brain x health]';

// Workstream statuses that count as finished (dropped from the digest, only
// counted). Anything unrecognized is treated as still active — fail open.
const FINISHED_STATUS_RE = /^(done|closed|merged|complete|completed|finished|landed|shipped|abandoned|cancelled|canceled)\b/i;

/** True when a workstream row's status marks it finished. PURE. */
export function isFinishedWorkstream(ws) {
  return FINISHED_STATUS_RE.test(String((ws && ws.status) || '').trim());
}

/**
 * True when a lease's `until` TTL is a parseable timestamp in the past.
 * Empty or unparseable TTLs keep the lease visible (fail open — a lease we
 * cannot date must not silently vanish from the digest). PURE given `now`.
 */
export function isExpiredLease(lease, now) {
  const until = String((lease && lease.until) || '').trim();
  if (!until) return false;
  const t = Date.parse(until);
  return Number.isFinite(t) && t < now;
}

/** Collapse whitespace + clip a cell to `max` chars (ellipsis when cut). PURE. */
function clip(value, max) {
  const v = String(value || '').replace(/\s+/g, ' ').trim();
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

/**
 * Hard byte cap. Under budget → text unchanged. Over budget → keep whole
 * lines from the top while `lines + marker` still fit, then append the
 * marker. Output is guaranteed ≤ budgetBytes for any budget that fits the
 * marker itself (the 8,000 B default always does). PURE.
 */
export function capBytes(text, budgetBytes, marker = TRUNCATION_MARKER) {
  const t = String(text ?? '');
  if (Buffer.byteLength(t, 'utf8') <= budgetBytes) return t;
  const markerBytes = Buffer.byteLength(marker, 'utf8') + 1; // marker + '\n'
  const kept = [];
  let used = 0;
  for (const line of t.split('\n')) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // line + '\n'
    if (used + lineBytes + markerBytes > budgetBytes) break;
    kept.push(line);
    used += lineBytes;
  }
  return kept.length ? `${kept.join('\n')}\n${marker}\n` : `${marker}\n`;
}

/**
 * Build the digest. PURE + deterministic: same `state`/`opts` in, byte-identical
 * text out (time enters only via the injected `now`).
 *
 * @param {object} state  activeStateJson() shape: { workstreams, leases,
 *   blockers, overlaps } plus optional `sessions` (recent pointer paths).
 * @param {object} opts   { budgetBytes?, now? (ms epoch) }
 * @returns {string} newline-terminated digest, ≤ budgetBytes.
 */
/**
 * Headings this digest already reports through the structured path. Anything
 * else in active_state.md is prose the schema never anticipated.
 */
export const CANONICAL_SECTIONS = Object.freeze([
  'workstreams', 'file leases', 'leases', 'blockers', 'overlaps', 'last sync'
]);

/**
 * PURE. Summarize the sections of active_state.md that this digest's schema
 * does NOT know about.
 *
 * WHY. The digest was built to cap a file written in its own table format. On
 * a repo that never adopted that format it reported "Workstreams — 0 active /
 * Leases — 0 open" and stopped: 547 bytes of nothing, out of a 51 KB file
 * holding `## Developers`, `## Active Work`, `## Known Warts`. It did not cost
 * tokens — it FAILED TO SAVE them, because an agent that actually needed the
 * state then had to read all 51 KB (≈12,957 tokens) raw. A tool that only
 * understands the structure it invented is useless on every repo that did not
 * adopt it, which is the same defect as a whitelist of directory names or a
 * lease board that stays empty until everyone declares intent.
 *
 * What it emits per unknown section: the heading, how many lines it holds, and
 * the first few non-empty lines — bullets preferred, because a bullet is
 * usually the point of the paragraph around it. What it never does is pretend
 * to be complete: the shown/total counts are printed so a reader knows whether
 * opening the file would tell them more.
 *
 * @param {string} markdown  raw active_state.md
 * @param {object} [opts]
 * @param {number} [opts.maxSections]   sections to report (newest-first order of the file)
 * @param {number} [opts.maxLinesEach]  preview lines per section
 * @returns {{sections: Array<{heading, lines, shown: string[]}>, totalLines: number, omittedSections: number}}
 */
export function summarizeProseSections(markdown, opts = {}) {
  const maxSections = Number.isFinite(opts.maxSections) ? opts.maxSections : 8;
  const maxLinesEach = Number.isFinite(opts.maxLinesEach) ? opts.maxLinesEach : 3;
  const text = String(markdown || '');
  if (!text.trim()) return { sections: [], totalLines: 0, omittedSections: 0 };

  const known = new Set(CANONICAL_SECTIONS);
  const found = [];
  let current = null;
  let totalLines = 0;
  for (const raw of text.split('\n')) {
    const h = raw.match(/^##\s+(.+?)\s*$/);
    if (h) {
      const heading = h[1].trim();
      // Match on the leading words so "Overlaps / Conflict Risks" is still the
      // canonical Overlaps section and is not reported twice.
      const key = heading.toLowerCase();
      const isKnown = [...known].some((k) => key === k || key.startsWith(`${k} `) || key.startsWith(`${k}/`) || key.startsWith(`${k} /`));
      current = isKnown ? null : { heading, lines: 0, body: [] };
      if (current) found.push(current);
      continue;
    }
    if (!current) continue;
    const line = raw.trim();
    if (!line) continue;
    current.lines += 1;
    totalLines += 1;
    current.body.push(line);
  }

  // Bullets first — a bullet is usually the point of the prose around it —
  // then whatever else came first, so a section of plain paragraphs is not
  // reported as empty.
  const sections = found
    .filter((s) => s.lines > 0)
    .slice(0, maxSections)
    .map((s) => {
      const bullets = s.body.filter((l) => /^[-*+]\s+/.test(l));
      const pick = (bullets.length ? bullets : s.body).slice(0, maxLinesEach);
      return { heading: s.heading, lines: s.lines, shown: pick.map((l) => clip(l, 160)) };
    });

  return {
    sections,
    totalLines,
    omittedSections: Math.max(0, found.filter((s) => s.lines > 0).length - sections.length)
  };
}

export function buildStateDigest(state = {}, opts = {}) {
  const budgetBytes = Number.isFinite(opts.budgetBytes) && opts.budgetBytes > 0
    ? opts.budgetBytes
    : stateDigestBudgetBytes();
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();

  const workstreams = state.workstreams || [];
  const leases = state.leases || [];
  const isNoise = (b) => !b || /^none( recorded)?\.?$/i.test(b.trim());
  const blockers = (state.blockers || []).filter((b) => !isNoise(b));
  const overlaps = (state.overlaps || []).filter((b) => !isNoise(b));
  const sessions = state.sessions || [];

  const active = workstreams.filter((w) => !isFinishedWorkstream(w));
  const finishedCount = workstreams.length - active.length;
  const open = leases.filter((l) => !isExpiredLease(l, now));
  const expiredCount = leases.length - open.length;

  const lines = [];
  lines.push('=== Project Brain: Active State (digest) ===');
  lines.push('Bounded digest of .project-brain/active_state.md (decisions/0024) — read that file for full detail.');
  lines.push('');

  lines.push(`Workstreams — ${active.length} active${finishedCount ? ` (${finishedCount} finished omitted)` : ''}:`);
  if (!active.length) lines.push('- none');
  for (const w of active) {
    const cells = [
      clip(w.taskId, 48),
      clip(w.owner, 24),
      clip(w.tool, 16),
      clip(w.project, 24),
      clip(w.branch, 48),
      clip(w.scope, 100)
    ].filter(Boolean);
    lines.push(`- ${cells.join(' · ')} [${clip(w.status, 24) || 'active'}]`);
  }
  lines.push('');

  lines.push(`Leases — ${open.length} open${expiredCount ? ` (${expiredCount} expired omitted)` : ''}:`);
  if (!open.length) lines.push('- none');
  for (const l of open) {
    const cells = [
      clip(l.target, 80),
      l.lockedBy ? `locked_by=${clip(l.lockedBy, 32)}` : '',
      `until=${clip(l.until, 40) || 'no TTL'}`,
      clip(l.project, 24),
      clip(l.notes, 80)
    ].filter(Boolean);
    lines.push(`- ${cells.join(' · ')}`);
  }

  if (blockers.length) {
    lines.push('');
    lines.push('Blockers:');
    for (const b of blockers) lines.push(`- ${clip(b, 160)}`);
  }
  if (overlaps.length) {
    lines.push('');
    lines.push('Overlaps:');
    for (const o of overlaps) lines.push(`- ${clip(o, 160)}`);
  }
  // Sections the schema does not know about. Reported LAST so the structured
  // answer is never pushed out by prose when the budget bites, and only when
  // there is prose to report — a canonical file is byte-identical to before.
  const prose = summarizeProseSections(opts.markdown);
  if (prose.sections.length) {
    lines.push('');
    lines.push(
      `Other sections in active_state.md (${prose.sections.length}` +
      `${prose.omittedSections ? ` of ${prose.sections.length + prose.omittedSections}` : ''}` +
      `, ${prose.totalLines} line(s) total) — this file does not use the workstream/lease tables:`
    );
    for (const sec of prose.sections) {
      lines.push(`- ## ${clip(sec.heading, 80)} (${sec.lines} line(s))`);
      for (const l of sec.shown) lines.push(`    ${l}`);
    }
    lines.push('  ^ excerpt only — open .project-brain/active_state.md for the rest.');
  }

  if (sessions.length) {
    lines.push('');
    lines.push(`Recent sessions: ${sessions.map((s) => clip(s, 80)).join(' · ')}`);
  }

  return capBytes(`${lines.join('\n')}\n`, budgetBytes);
}

/**
 * Newest `limit` session files under `.project-brain/sessions/` as relative
 * pointer paths, newest first. Filenames start with YYYY-MM-DD, so a plain
 * lexical sort is chronological. Missing dir → [] (never throws).
 */
export function recentSessionPointers(sessionsDir, limit = 3) {
  try {
    return fs.readdirSync(sessionsDir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .slice(-limit)
      .reverse()
      .map((f) => path.posix.join('.project-brain', 'sessions', f));
  } catch {
    return [];
  }
}

function main() {
  try {
    // No active state → inject nothing (and, unlike activeStateJson's
    // ensure-on-read, create nothing: a SessionStart hook must not scaffold).
    if (!fs.existsSync(ACTIVE_STATE)) {
      process.exit(0);
    }
    const state = activeStateJson();
    state.sessions = recentSessionPointers(path.join(BRAIN_DIR, 'sessions'));
    // The raw file, so sections outside the schema can be summarized too.
    let markdown = '';
    try { markdown = fs.readFileSync(ACTIVE_STATE, 'utf8'); } catch { /* digest degrades to the structured half */ }
    process.stdout.write(buildStateDigest(state, {
      budgetBytes: stateDigestBudgetBytes(), now: Date.now(), markdown
    }));
  } catch (error) {
    process.stderr.write(`[brain:state-digest] ${error.message || error}\n`);
  }
  process.exit(0); // hook contract: never block a session start
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
