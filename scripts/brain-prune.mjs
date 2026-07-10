#!/usr/bin/env node
/**
 * Project Brain pruning (Layer 1 of the auto-compaction system).
 *
 * Distinct from `npm run brain:compact` (upstream session-handoff packer
 * in `skills/project-brain/scripts/brain-compact.mjs`). This script only
 * trims the durable memory files.
 *
 *   - Move "Complete (>= 30 days ago)" bullets from active_state.md to
 *     .project-brain/history/YYYY-MM.md
 *   - Same for merged-PR bullets older than 30d
 *   - Optionally pipe active_state.md + context_index.md through
 *     caveman-compress (LLM call, opt-in via --with-caveman)
 *   - Report before/after line + byte counts; exit 0 even when nothing
 *     moved so it is safe in pre-commit hooks.
 *
 * Usage:
 *   node scripts/brain-prune.mjs              # dry-run preview
 *   node scripts/brain-prune.mjs --apply      # write moves
 *   node scripts/brain-prune.mjs --apply --with-caveman
 *
 * Hard rules:
 *   - Never touch the file if git status is dirty for it (loses
 *     in-progress edits).
 *   - Always leave a stub bullet pointing at the history file so
 *     `brain:ask` / grep still find it.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import './common.mjs' // usage ledger choke point (#32) — arms only when BRAIN_USAGE_LOG=1

// Run from the host project root (npm scripts run in package.json's
// directory). Avoids the "skills/project-brain/.." trap when the
// script is invoked via the vendored symlink.
const ROOT = process.cwd()
const BRAIN = join(ROOT, '.project-brain')
const HISTORY_DIR = join(BRAIN, 'history')
const ACTIVE = join(BRAIN, 'active_state.md')

const APPLY = process.argv.includes('--apply')
const WITH_CAVEMAN = process.argv.includes('--with-caveman')
const AGE_DAYS = Number(process.env.BRAIN_COMPACT_AGE_DAYS ?? 30)

const CAVEMAN_DIR = '/Users/seebo/.claude/plugins/marketplaces/caveman/caveman-compress'

const today = new Date()
const cutoff = new Date(today.getTime() - AGE_DAYS * 86_400_000)

function log(...args) {
  console.log('[brain-prune]', ...args)
}

function isGitDirty(filePath) {
  try {
    const rel = filePath.replace(ROOT + '/', '')
    const out = execFileSync('git', ['status', '--porcelain', '--', rel], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    return out.trim().length > 0
  } catch {
    return false
  }
}

/**
 * Match a bullet that documents completion with a date.
 * Examples we want to catch:
 *   - **X (#123):** ... Complete (PR #456; 2026-04-12).
 *   - **X:** ... (Complete; 2026-04-12)
 *   - **X (#123):** ... Merged (PR #459; 2026-05-12).
 *   - **X (#123):** Merged to develop ... Complete.   ← skipped (no date)
 */
const DATE_RE = /(\d{4})-(\d{2})-(\d{2})/g
const COMPLETION_RE = /\b(complete|completed|merged|shipped|released)\b/i

function newestDateInLine(line) {
  let m
  let newest = null
  DATE_RE.lastIndex = 0
  while ((m = DATE_RE.exec(line))) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`)
    if (!Number.isNaN(d.getTime()) && (!newest || d > newest)) newest = d
  }
  return newest
}

function classifyBullet(line) {
  if (!line.startsWith('- ')) return { keep: true }
  if (!COMPLETION_RE.test(line)) return { keep: true }
  const date = newestDateInLine(line)
  if (!date) return { keep: true } // no date = still load-bearing
  if (date >= cutoff) return { keep: true } // recent = stay
  return { keep: false, date }
}

function bulletTitle(line) {
  // "- **Foo (#123):** …" → "Foo (#123)"
  const m = line.match(/^- \*\*([^*]+?)\*\*/)
  if (m) return m[1].replace(/:$/, '').trim()
  return line.slice(2, 80).trim()
}

function compactActiveState() {
  if (isGitDirty(ACTIVE)) {
    log('skip active_state.md: uncommitted changes — commit or stash first')
    return { moved: 0, kept: 0 }
  }
  const before = readFileSync(ACTIVE, 'utf8')
  const lines = before.split('\n')
  const out = []
  const archives = new Map() // monthKey -> bullets[]
  let inActiveWork = false
  let moved = 0

  for (const line of lines) {
    if (/^##\s/.test(line)) {
      inActiveWork = /^##\s+Active Work\b/i.test(line)
    }
    if (!inActiveWork) {
      out.push(line)
      continue
    }
    const { keep, date } = classifyBullet(line)
    if (keep) {
      out.push(line)
      continue
    }
    const monthKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
    if (!archives.has(monthKey)) archives.set(monthKey, [])
    archives.get(monthKey).push(line)
    out.push(`- _archived → [[history/${monthKey}]]_ — ${bulletTitle(line)}`)
    moved += 1
  }

  if (moved === 0) {
    log('active_state.md: nothing to archive')
    return { moved: 0, kept: lines.length }
  }

  if (!APPLY) {
    log(`DRY-RUN active_state.md: would archive ${moved} bullets across ${archives.size} month(s)`)
    for (const [k, v] of archives) log(`  ${k}: ${v.length}`)
    return { moved, kept: out.length }
  }

  mkdirSync(HISTORY_DIR, { recursive: true })
  for (const [monthKey, bullets] of archives) {
    const target = join(HISTORY_DIR, `${monthKey}.md`)
    const header = existsSync(target) ? '' : `# Archived: ${monthKey}\n\n`
    appendFileSync(target, header + bullets.join('\n') + '\n')
  }
  writeFileSync(ACTIVE, out.join('\n'))
  log(
    `active_state.md: archived ${moved} bullets → ${[...archives.keys()].join(', ')} (${before.length} → ${out.join('\n').length} bytes)`,
  )
  return { moved, kept: out.length }
}

function runCaveman(filePath) {
  if (!existsSync(CAVEMAN_DIR)) {
    log(`skip caveman: ${CAVEMAN_DIR} not installed`)
    return
  }
  if (isGitDirty(filePath)) {
    log(`skip caveman on ${filePath}: dirty`)
    return
  }
  log(`caveman compress: ${filePath} (calls Claude — costs tokens)`)
  try {
    execFileSync('python3', ['-m', 'scripts', filePath], {
      cwd: CAVEMAN_DIR,
      stdio: 'inherit',
    })
  } catch (err) {
    log(`caveman failed: ${err.message}`)
  }
}

function maybeSync() {
  if (!APPLY) return
  try {
    execFileSync('npm', ['run', 'brain:sync'], { cwd: ROOT, stdio: 'inherit' })
  } catch {
    log('brain:sync failed — run manually with `npm run brain:sync`')
  }
}

function main() {
  log(`cutoff: ${cutoff.toISOString().slice(0, 10)} (${AGE_DAYS} days)`)
  log(`mode: ${APPLY ? 'APPLY' : 'dry-run'}${WITH_CAVEMAN ? ' +caveman' : ''}`)
  const { moved } = compactActiveState()
  if (APPLY && WITH_CAVEMAN && moved > 0) {
    runCaveman(ACTIVE)
    runCaveman(join(BRAIN, 'context_index.md'))
  }
  maybeSync()
}

main()
