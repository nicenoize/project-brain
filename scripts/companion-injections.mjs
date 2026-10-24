/**
 * What the agent got: every piece of context a hook put in front of the
 * agent, read back from the transcript (Claude Code records each one as an
 * `attachment` of type `hook_additional_context`, with the text, the event
 * and the tool call it rode on). No hook has to log anything.
 *
 * "Followed" is deliberately narrow and checkable: an injection that names a
 * brain command (`brain:search`, `npm run brain:radar`, the MCP tool
 * `brain_why`…) counts as followed when one of the agent's next five tool
 * calls runs that command. Only hints are scored (kindOf): a warm snapshot or
 * an answer before an edit may mention a command without asking for it.
 */

export const FOLLOW_WINDOW = 5;
const MAX_LAST = 20;

/** Who injected this text. PURE. */
export function sourceOf(text, hookName = '') {
  const t = String(text || '').trimStart();
  if (/^Notes? from the user, sent from the companion/.test(t)) return 'companion';
  if (/^(Project Brain|=== Project Brain|## Brain:|brain:|Brain:)/i.test(t) || /\bproject-brain\b/i.test(t.slice(0, 200))) return 'brain';
  return 'other';
}

/**
 * What kind of brain injection this is. Only a `hint` asks the agent to run
 * something, so only hints are scored for "followed":
 *   state   — the warm snapshot after a compaction (the session's own state)
 *   answer  — the ambient answer before an edit (danger, decisions, leases)
 *   hint    — routing and tool nudges ("run brain:search instead")
 * PURE.
 */
export function kindOf(text) {
  const t = String(text || '').trimStart();
  if (/^## Brain: session state/.test(t) || /^(=== )?Project Brain state\b/i.test(t)) return 'state';
  if (/^Project Brain \(ambient, deterministic\)/.test(t)) return 'answer';
  return 'hint';
}

/** Brain commands an injection asks for, normalised to their name ("search", "radar"). PURE. */
export function namedCommands(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/\bbrain[:_-]([a-z][a-z-]*[a-z])\b/g)) out.add(m[1].replace(/_/g, '-'));
  return [...out];
}

/** Did a tool call run one of these commands? Bash `brain:x` / `brain-x.mjs`, or the MCP tool `brain_x`. PURE. */
export function callRuns(call, commands) {
  if (!commands.length || !call) return null;
  const hay = `${call.name || ''} ${typeof call.input === 'string' ? call.input : JSON.stringify(call.input || {})}`;
  for (const c of commands) {
    const u = c.replace(/-/g, '_');
    if (hay.includes(`brain:${c}`) || hay.includes(`brain-${c}`) || hay.includes(`brain_${u}`)) return c;
  }
  return null;
}

export function createInjectionTracker({ keepLast = MAX_LAST, sinceMs = 0 } = {}) {
  const totals = { count: 0, chars: 0, bySource: {}, byKind: {}, byEvent: {} };
  const open = []; // { injection, commands, left }
  const last = [];
  const bump = (bag, key, chars) => { const b = (bag[key] ||= { count: 0, chars: 0, actionable: 0, followed: 0 }); b.count += 1; b.chars += chars; return b; };

  function record(r) {
    if (!r || typeof r !== 'object') return;
    const ts = r.timestamp ? Date.parse(r.timestamp) : NaN;
    const inWindow = !sinceMs || ts >= sinceMs;
    const a = r.type === 'attachment' ? r.attachment : null;
    if (a && a.type === 'hook_additional_context') {
      const text = (Array.isArray(a.content) ? a.content.join('\n') : String(a.content || '')).trim();
      if (!text || !inWindow) return;
      const source = sourceOf(text, a.hookName);
      const kind = source === 'brain' ? kindOf(text) : null;
      const event = String(a.hookName || a.hookEvent || '');
      // only a hint asks for a command: a warm snapshot or an answer that mentions one is not scored
      const commands = kind === 'hint' ? namedCommands(text) : [];
      const inj = { at: Number.isFinite(ts) ? ts : null, source, kind, event, chars: text.length, text: text.slice(0, 600), commands, followed: null };
      totals.count += 1;
      totals.chars += text.length;
      const s = bump(totals.bySource, source, text.length);
      const k = kind ? bump(totals.byKind, kind, text.length) : null;
      bump(totals.byEvent, `${source} · ${event.split(':')[0] || 'other'}`, text.length);
      if (commands.length) { s.actionable += 1; k.actionable += 1; inj.followed = false; open.push({ inj, commands, left: FOLLOW_WINDOW, bags: [s, k] }); }
      last.push(inj);
      if (last.length > keepLast) last.shift();
      return;
    }
    if (r.type === 'assistant' && !r.isSidechain && open.length) {
      for (const c of Array.isArray(r.message && r.message.content) ? r.message.content : []) {
        if (!c || c.type !== 'tool_use') continue;
        for (let i = open.length - 1; i >= 0; i--) {
          const o = open[i];
          const hit = callRuns(c, o.commands);
          if (hit) { o.inj.followed = hit; for (const b of o.bags) b.followed += 1; open.splice(i, 1); continue; }
          o.left -= 1;
          if (o.left <= 0) open.splice(i, 1);
        }
      }
    }
  }

  function summary() {
    const shape = (b) => ({ count: b.count, chars: b.chars, estTokens: Math.round(b.chars / 4), actionable: b.actionable, followed: b.followed, followedShare: b.actionable ? Math.round((b.followed / b.actionable) * 1000) / 1000 : null });
    return {
      count: totals.count,
      chars: totals.chars,
      estTokens: Math.round(totals.chars / 4),
      bySource: Object.fromEntries(Object.entries(totals.bySource).map(([k, v]) => [k, shape(v)])),
      byKind: Object.fromEntries(Object.entries(totals.byKind).map(([k, v]) => [k, shape(v)])),
      byEvent: Object.fromEntries(Object.entries(totals.byEvent).sort((a, b) => b[1].count - a[1].count).map(([k, v]) => [k, { count: v.count, chars: v.chars }])),
      last: [...last]
    };
  }

  return { record, summary };
}

/** Merge several summaries (per transcript → per project → everything). PURE. */
export function mergeInjectionSummaries(list) {
  const out = { count: 0, chars: 0, estTokens: 0, bySource: {}, byKind: {}, byEvent: {}, last: [] };
  // Slim summaries (the state's) carry estTokens but no chars: fall back to
  // estTokens × 4, never to undefined (NaN serialises as null and breaks readers).
  const chars = (x) => (Number.isFinite(x && x.chars) ? x.chars : Number.isFinite(x && x.estTokens) ? x.estTokens * 4 : 0);
  const n = (x) => (Number.isFinite(x) ? x : 0);
  for (const s of list) {
    if (!s) continue;
    out.count += n(s.count); out.chars += chars(s);
    for (const bag of ['bySource', 'byKind']) {
      for (const [k, v] of Object.entries(s[bag] || {})) {
        const b = (out[bag][k] ||= { count: 0, chars: 0, estTokens: 0, actionable: 0, followed: 0, followedShare: null });
        b.count += n(v.count); b.chars += chars(v); b.actionable += n(v.actionable); b.followed += n(v.followed);
      }
    }
    for (const [k, v] of Object.entries(s.byEvent || {})) {
      const b = (out.byEvent[k] ||= { count: 0, chars: 0 });
      b.count += n(v.count); b.chars += chars(v);
    }
  }
  out.estTokens = Math.round(out.chars / 4);
  for (const b of [...Object.values(out.bySource), ...Object.values(out.byKind)]) {
    b.estTokens = Math.round(b.chars / 4);
    b.followedShare = b.actionable ? Math.round((b.followed / b.actionable) * 1000) / 1000 : null;
  }
  out.byEvent = Object.fromEntries(Object.entries(out.byEvent).sort((a, b) => b[1].count - a[1].count));
  return out;
}
