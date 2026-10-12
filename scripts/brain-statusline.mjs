#!/usr/bin/env node
/**
 * brain-statusline — the context segment for Claude Code's status line (K7,
 * docs/roadmap-next.md). The status line JSON is the only DOCUMENTED live
 * source of the context size, so this is where the user sees it:
 *
 *   ctx 412k/1M (41%) · compacts at 300k · 2× compacted
 *
 * Reads the status-line JSON on stdin, prints one line, never fails (an
 * empty line on any error — a broken status line is worse than none).
 *
 * Use it alone   ("statusLine": {"type":"command","command":"node …/brain-statusline.mjs"})
 * or append it to your own status line script:
 *   input=$(cat); mine=$(…); seg=$(printf '%s' "$input" | node …/brain-statusline.mjs); echo "$mine · $seg"
 *
 * The settings sync installs it only with --statusline and only when no
 * status line is configured, because a project status line would replace
 * the user's own.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isMainModule } from './is-main.mjs';

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : `${Math.round(n / 1000)}k`);

/**
 * PURE. One line from the status-line JSON. `compactions` comes from the warm
 * record (brain-warm), `window` from CLAUDE_CODE_AUTO_COMPACT_WINDOW.
 */
export function segment(input = {}, { window = null, compactions = 0 } = {}) {
  const cw = input.context_window || {};
  const size = Number(cw.context_window_size) || 0;
  const u = cw.current_usage;
  const used = u ? (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) : null;
  const parts = [];
  if (used != null && size) parts.push(`ctx ${k(used)}/${k(size)} (${Math.round((used / size) * 100)}%)`);
  else if (Number.isFinite(cw.used_percentage)) parts.push(`ctx ${Math.round(cw.used_percentage)}%`);
  else parts.push('ctx —');
  if (window) parts.push(`compacts at ${k(window)}`);
  if (compactions) parts.push(`${compactions}× compacted`);
  return parts.join(' · ');
}

function compactionsFor(sessionId, cwd) {
  try {
    const safe = String(sessionId || '').replace(/[^\w-]/g, '');
    if (!safe) return 0;
    const s = JSON.parse(fs.readFileSync(path.join(cwd, '.project-brain', '.warm', `${safe}.json`), 'utf8'));
    return Array.isArray(s.compactions) ? s.compactions.length : 0;
  } catch { return 0; }
}

function main() {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    const cwd = (input.workspace && input.workspace.project_dir) || input.cwd || process.cwd();
    const window = Number(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) || null;
    process.stdout.write(segment(input, { window, compactions: compactionsFor(input.session_id, cwd) }));
  } catch {
    process.stdout.write('');
  }
}

if (isMainModule(import.meta.url)) main();
