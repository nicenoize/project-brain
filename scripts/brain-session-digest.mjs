#!/usr/bin/env node
/**
 * Layer 2 of the auto-compaction system: session digest extractor.
 * (TRANSCRIPT digest — not scripts/brain-state-digest.mjs, which is the byte-capped SessionStart ACTIVE-STATE digest.)
 *
 * Invoked by Claude Code PreCompact and Stop hooks. Reads the transcript
 * JSON (path supplied on stdin via the hook payload), pulls out tagged
 * lines I emit during work, and appends a dated digest to
 * .project-brain/sessions/YYYY-MM-DD.md so the next session inherits
 * the gist instead of re-reading 80KB of full transcript.
 *
 * Tags scraped (case-insensitive, anywhere in an assistant text block):
 *   ## Decided: …
 *   ## Memory: …
 *   ## Followup: …
 *
 * Hook payload schema (Claude Code):
 *   { "transcript_path": "/abs/path/to/transcript.jsonl",
 *     "session_id": "…",
 *     "hook_event_name": "PreCompact" | "Stop" }
 *
 * Always exits 0 + emits `{"continue": true}` so the host workflow
 * (built-in compactor / stop handling) proceeds even on script error.
 */
import { isMainModule } from './is-main.mjs';
import { readFileSync, appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, statSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.cwd()
export const SESSIONS_DIR = join(ROOT, '.project-brain', 'sessions')

function emitContinue() {
  process.stdout.write(JSON.stringify({ continue: true }))
  process.exit(0)
}

function readStdinSync() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

const TAG_RE = /^##\s+(Decided|Memory|Followup):\s*(.+)$/gim

/**
 * A line can only hold a tag if it carries one of the three words and a
 * colon. Deliberately wider than TAG_RE (no "##", any spacing), so the
 * filter can never drop a line the full parse would have used.
 */
const MAY_TAG = /(decided|memory|followup):/gi

/**
 * Call `fn` with each line of a file that may hold a tag, decoded as UTF-8.
 * A long session's transcript runs to hundreds of MB and this runs at every
 * Stop: chunks are searched as latin1 (one byte per char, ASCII intact, no
 * UTF-8 decoding), and only candidate lines are decoded and parsed.
 */
function forEachCandidateLine(file, fn, startAt = 0) {
  const fd = openSync(file, 'r')
  let complete = startAt // byte offset just after the last newline read
  const scan = (b) => {
    const s = b.latin1Slice(0, b.length)
    MAY_TAG.lastIndex = 0
    let m
    while ((m = MAY_TAG.exec(s))) {
      const start = s.lastIndexOf('\n', m.index) + 1
      let end = s.indexOf('\n', m.index)
      if (end === -1) end = s.length
      fn(b.subarray(start, end).toString('utf8'))
      MAY_TAG.lastIndex = end // one call per line, however many words it holds
    }
  }
  try {
    const buf = Buffer.allocUnsafe(4 << 20)
    let carry = Buffer.alloc(0)
    let pos = startAt
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, pos)
      if (n <= 0) break
      pos += n
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n)
      const last = chunk.lastIndexOf(10)
      if (last === -1) { carry = Buffer.from(chunk); continue }
      scan(chunk.subarray(0, last))
      carry = Buffer.from(chunk.subarray(last + 1))
      complete = pos - carry.length
    }
    if (carry.length) scan(carry) // a last line without its newline: read now, read again next time
  } finally {
    closeSync(fd)
  }
  return complete
}

/**
 * Where the Stop hook remembers how far it read a transcript and what it found
 * (temp dir: a reboot only costs one full read). Transcripts only grow, so
 * the next turn reads the new bytes, not the whole session again.
 */
function cacheFile(transcriptPath) {
  const name = String(transcriptPath).replace(/[^A-Za-z0-9._-]+/g, '_').slice(-180)
  return join(tmpdir(), 'brain-digest', `${name}.json`)
}

export function extractTags(transcriptPath, { cache = false } = {}) {
  if (!transcriptPath) {
    process.stderr.write('[brain:digest] no transcript_path in hook payload\n')
    return []
  }
  if (!existsSync(transcriptPath)) {
    process.stderr.write(`[brain:digest] transcript not found: ${transcriptPath}\n`)
    return []
  }
  let hits = []
  let startAt = 0
  let size = 0
  try { size = statSync(transcriptPath).size } catch { /* raced */ }
  if (cache) {
    try {
      const c = JSON.parse(readFileSync(cacheFile(transcriptPath), 'utf8'))
      if (Number.isFinite(c.offset) && c.offset <= size && Array.isArray(c.hits)) { startAt = c.offset; hits = c.hits }
    } catch { /* no cache yet: read it all */ }
  }
  let offset = startAt
  try {
    offset = forEachCandidateLine(transcriptPath, (line) => {
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        return
      }
      // Assistant text blocks live at entry.message.content[i].text
      const content = entry?.message?.content
      if (!Array.isArray(content)) return
      for (const block of content) {
        const text = typeof block === 'string' ? block : block?.text
        if (typeof text !== 'string') continue
        let m
        TAG_RE.lastIndex = 0
        while ((m = TAG_RE.exec(text))) {
          hits.push(`- **${m[1]}:** ${m[2].trim()}`)
        }
      }
    }, startAt)
  } catch (error) {
    process.stderr.write(`[brain:digest] transcript read failed: ${error.message || error}\n`)
    return []
  }
  // Dedupe while preserving order
  const out = [...new Set(hits)]
  if (cache) {
    try {
      const f = cacheFile(transcriptPath)
      mkdirSync(dirname(f), { recursive: true })
      const tmp = `${f}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ offset, hits: out }))
      renameSync(tmp, f)
    } catch { /* the cache only saves time */ }
  }
  return out
}

function main() {
  const raw = readStdinSync()
  let payload = {}
  try {
    payload = raw ? JSON.parse(raw) : {}
  } catch (error) {
    process.stderr.write(`[brain:digest] hook payload parse failed: ${error.message || error}\n`)
    emitContinue()
  }

  const transcriptPath = payload.transcript_path
  const sessionId = payload.session_id || 'unknown'
  const event = payload.hook_event_name || 'Hook'

  const hits = extractTags(transcriptPath, { cache: true })
  if (hits.length === 0) emitContinue()

  const date = new Date().toISOString().slice(0, 10)
  const target = join(SESSIONS_DIR, `${date}-digest.md`)
  try {
    mkdirSync(SESSIONS_DIR, { recursive: true })
    const header = existsSync(target)
      ? `\n## ${event} ${new Date().toISOString().slice(11, 16)} — session ${sessionId.slice(0, 8)}\n`
      : `# Session digests — ${date}\n\n## ${event} ${new Date().toISOString().slice(11, 16)} — session ${sessionId.slice(0, 8)}\n`
    appendFileSync(target, header + hits.join('\n') + '\n')
  } catch (error) {
    process.stderr.write(`[brain:digest] digest write failed (${target}): ${error.message || error}\n`)
  }

  emitContinue()
}

// Only parse stdin / run the hook when invoked directly. Importing for reuse
// (brain:close reuses extractTags) must NOT block on readFileSync(0) or exit.
if (isMainModule(import.meta.url)) {
  main()
}
