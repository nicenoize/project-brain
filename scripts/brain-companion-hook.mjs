#!/usr/bin/env node
/**
 * brain-companion-hook — how the companion reaches a running agent. Claude
 * Code calls it on PreToolUse (every tool) and UserPromptSubmit; it
 *
 *   1. delivers steer notes queued for this session (additionalContext), so a
 *      note typed into the notch lands at the agent's next tool call;
 *   2. holds edits under a held glob: the edit waits up to 45 s for Approve /
 *      Deny in the companion, then falls back to Claude Code's own prompt
 *      (`ask`). With no companion engine running it asks right away, so a
 *      hold can never wedge a session;
 *   3. marks the session as reachable (seen/), so the companion can say
 *      "control" instead of "monitor only".
 *
 * Not registered by default: `npm run brain:companion -- install-hooks`
 * adds it to the user's Claude settings (every session on this machine).
 * Exit 0 always; any error means "no opinion" (CONTRIBUTING rule 3). The
 * module graph is fs + path + os on purpose: it runs on every tool call.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  busDir, statePath, EDIT_TOOLS, HOLD_TIMEOUT_MS, claimInbox, matchingHold, engineFresh, createPending,
  awaitDecision, clearPending, appendEvent, markSeen
} from './companion-bus.mjs';

/** The additionalContext for delivered notes. PURE. */
export function steerContext(notes) {
  if (!notes.length) return '';
  const lines = notes.map((n) => {
    const t = new Date(n.at || Date.now());
    const hh = String(t.getHours()).padStart(2, '0'), mm = String(t.getMinutes()).padStart(2, '0');
    return `- ${hh}:${mm} ${n.text}`;
  });
  return `Note${notes.length > 1 ? 's' : ''} from the user, sent from the companion while you were working — take ${notes.length > 1 ? 'them' : 'it'} into account from this step on:\n${lines.join('\n')}`;
}

/** The file an edit tool is about to touch, absolute, or ''. PURE. */
export function editTarget(input, cwd) {
  const ti = (input && (input.tool_input || input.toolInput)) || {};
  const f = ti.file_path || ti.notebook_path || ti.path || '';
  if (!f) return '';
  return path.isAbsolute(f) ? f : path.resolve(cwd || process.cwd(), f);
}

/** Shape the hook's stdout. PURE. */
export function hookOutput(event, { context = '', decision = null, reason = '' } = {}) {
  const out = { hookEventName: event };
  if (decision) { out.permissionDecision = decision; if (reason) out.permissionDecisionReason = reason; }
  if (context) out.additionalContext = context;
  return Object.keys(out).length > 1 ? { hookSpecificOutput: out } : null;
}

/**
 * A tool call made by a subagent: its context is thrown away when the
 * subagent ends, so a steer note must not be spent there. Holds still apply.
 */
export function fromSubagent(input) {
  return Boolean(input.agent_id || input.agentId || input.agent_type || input.agentType || input.isSidechain || /[\\/]subagents[\\/]/.test(String(input.transcript_path || '')));
}

/**
 * One hook call: stdin envelope in, stdout object (or null) out.
 * Order matters: a held edit is decided first (up to 45 s), and only then are
 * steer notes claimed — so a hook killed while it waits loses no note.
 */
export async function handle(input, { dir = busDir(), stateFile = null, timeoutMs = Number(process.env.BRAIN_COMPANION_HOLD_TIMEOUT_MS) || HOLD_TIMEOUT_MS, now = Date.now } = {}) {
  // The state file lives in the bus directory under the configured name (state.json unless BRAIN_COMPANION_STATE says otherwise).
  stateFile ||= path.join(dir, path.basename(statePath()));
  const event = String(input.hook_event_name || input.hookEventName || '');
  const sessionId = String(input.session_id || input.sessionId || '');
  const cwd = String(input.cwd || '');
  if (event !== 'PreToolUse' && event !== 'UserPromptSubmit') return null;
  const sub = fromSubagent(input);
  if (!sub) markSeen(dir, sessionId, now());
  const tool = String(input.tool_name || input.toolName || '');

  let decision = null, reason = '';
  if (event === 'PreToolUse' && EDIT_TOOLS.includes(tool)) {
    const file = editTarget(input, cwd);
    const hold = file ? matchingHold(dir, file, now()) : null;
    if (hold) {
      const where = hold.root ? `${hold.glob} in ${path.basename(hold.root)}` : hold.glob === '**' ? 'all edits' : hold.glob;
      if (!engineFresh(dir, now(), undefined, stateFile)) {
        appendEvent(dir, { kind: 'held-ask', session: sessionId, file, hold: hold.id, why: 'no engine' });
        decision = 'ask'; reason = `Held by the user (${where}). The companion is not running, so this edit needs a yes here.`;
      } else {
        const pending = createPending(dir, { session: sessionId, cwd, tool, file, hold: hold.id, glob: hold.glob, root: hold.root, subagent: sub || undefined, deadline: now() + timeoutMs });
        appendEvent(dir, { kind: 'held', session: sessionId, id: pending.id, file, tool, hold: hold.id });
        let answer;
        try { answer = await awaitDecision(dir, pending.id, { timeoutMs, now }); } finally { clearPending(dir, pending.id); }
        if (answer.decision === 'allow') {
          appendEvent(dir, { kind: 'approved', session: sessionId, id: pending.id, file, by: answer.by || null });
          decision = 'allow'; reason = 'Approved by the user in the companion.';
        } else if (answer.decision === 'deny') {
          appendEvent(dir, { kind: 'denied', session: sessionId, id: pending.id, file, reason: answer.reason, by: answer.by || null });
          const r = String(answer.reason || '').trim();
          const why = r ? ` Their reason: ${r}${/[.!?]$/.test(r) ? '' : '.'}` : '';
          decision = 'deny'; reason = `The user declined this edit from the companion (${where} is held).${why} Do not retry it; continue with what does not touch held files, or ask how to proceed.`;
        } else {
          appendEvent(dir, { kind: 'held-ask', session: sessionId, id: pending.id, file, why: 'timeout' });
          decision = 'ask'; reason = `Held by the user (${where}); no answer in the companion within ${Math.round(timeoutMs / 1000)} s.`;
        }
      }
    }
  }

  // Notes go to the main agent only, and only now, right before the output is written.
  let context = '';
  if (!sub) {
    const { notes, expired } = claimInbox(dir, sessionId, now());
    for (const n of expired) appendEvent(dir, { kind: 'steer-expired', session: sessionId, id: n.id, text: n.text, queuedAt: n.at || null });
    for (const n of notes) appendEvent(dir, { kind: 'steer-delivered', session: sessionId, id: n.id, text: n.text, tool: tool || null, queuedAt: n.at || null });
    context = steerContext(notes);
  }
  return hookOutput(event, { context, decision, reason });
}

async function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return; }
  const out = await handle(input);
  if (out) process.stdout.write(JSON.stringify(out));
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  main().catch(() => {}).finally(() => process.exit(0));
}
