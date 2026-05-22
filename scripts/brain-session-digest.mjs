#!/usr/bin/env node
/**
 * Layer 2 of the auto-compaction system: session digest extractor.
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
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const SESSIONS_DIR = join(ROOT, '.project-brain', 'sessions')

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

function extractTags(transcriptPath) {
  if (!transcriptPath) {
    process.stderr.write('[brain:digest] no transcript_path in hook payload\n')
    return []
  }
  if (!existsSync(transcriptPath)) {
    process.stderr.write(`[brain:digest] transcript not found: ${transcriptPath}\n`)
    return []
  }
  let raw
  try {
    raw = readFileSync(transcriptPath, 'utf8')
  } catch (error) {
    process.stderr.write(`[brain:digest] transcript read failed: ${error.message || error}\n`)
    return []
  }
  const lines = raw.split('\n').filter(Boolean)
  const hits = []
  for (const line of lines) {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    // Assistant text blocks live at entry.message.content[i].text
    const content = entry?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const text = typeof block === 'string' ? block : block?.text
      if (typeof text !== 'string') continue
      let m
      TAG_RE.lastIndex = 0
      while ((m = TAG_RE.exec(text))) {
        hits.push(`- **${m[1]}:** ${m[2].trim()}`)
      }
    }
  }
  // Dedupe while preserving order
  return [...new Set(hits)]
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

  const hits = extractTags(transcriptPath)
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

main()
