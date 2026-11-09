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
import fs from 'node:fs';
import path from 'node:path';

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
 * A name a person recognises for whoever injected this: the plugin from the
 * command's path, the brain, or the text's own first line ("# Vercel Plugin
 * Session Context", "CAVEMAN MODE ACTIVE"). PURE.
 */
export function nameOf(text, command = '', plugins = null) {
  const cmd = String(command || '');
  const owner = plugins && cmd ? plugins.get(cmd) : null;
  if (owner) return owner.split('@')[0];
  const plugin = cmd.match(/plugins\/cache\/[^/]+\/([^/\s"']+)/);
  if (plugin) return plugin[1];
  const src = sourceOf(text);
  if (src !== 'other') return src;
  const tagged = String(text || '').trimStart().match(/^\[([a-z0-9][\w.-]*)@[\w.-]+\]/i); // "[impeccable@1] …"
  if (tagged) return tagged[1];
  if (/project-brain|brain-[a-z-]+\.mjs/.test(cmd)) return 'brain';
  const first = String(text || '').trimStart().split('\n')[0].replace(/^[#=\s*>-]+|[=\s*:.]+$/g, '').replace(/\s+/g, ' ');
  const words = first.split(' ').slice(0, 5).join(' ');
  return (words.length > 40 ? words.slice(0, 39) + '…' : words) || 'unnamed hook';
}

/** Plain stdout of these events goes into the agent's context (JSON stdout is recorded as hook_additional_context). PURE. */
export function stdoutIsContext(a) {
  if (!a || a.type !== 'hook_success') return false;
  const ev = String(a.hookEvent || a.hookName || '').split(':')[0];
  if (ev !== 'SessionStart' && ev !== 'UserPromptSubmit') return false;
  const out = String(a.content ?? a.stdout ?? '').trim();
  return out.length > 0 && !out.startsWith('{');
}

/**
 * What kind of brain injection this is. Only a `hint` asks the agent to run
 * something, so only hints are scored for "followed":
 *   state   — the warm snapshot after a compaction (the session's own state)
 *   answer  — the ambient answer before an edit (danger, decisions, leases)
 *   digest  — the repo state file, budgeted, at session start
 *   hint    — routing and tool nudges ("run brain:search instead")
 * PURE.
 */
export function kindOf(text) {
  const t = String(text || '').trimStart();
  if (/^## Brain: session state/.test(t) || /^(=== )?Project Brain state\b/i.test(t)) return 'state';
  if (/^Project Brain \(ambient, deterministic\)/.test(t)) return 'answer';
  if (/^=== Project Brain: Active State/.test(t)) return 'digest'; // SessionStart: the repo's state file, budgeted
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

export function createInjectionTracker({ keepLast = MAX_LAST, sinceMs = 0, plugins = null } = {}) {
  const totals = { count: 0, chars: 0, bySource: {}, byKind: {}, byEvent: {}, byName: {} };
  const open = []; // { injection, commands, left }
  const recent = new Map(); // event + text head → attachment type, to drop the second recording of one output
  const learned = new Map(); // opening words → plugin, from outputs that named their command
  const last = [];
  const bump = (bag, key, chars) => { const b = (bag[key] ||= { count: 0, chars: 0, actionable: 0, followed: 0 }); b.count += 1; b.chars += chars; return b; };

  function record(r) {
    if (!r || typeof r !== 'object') return;
    const ts = r.timestamp ? Date.parse(r.timestamp) : NaN;
    const inWindow = !sinceMs || ts >= sinceMs;
    const a = r.type === 'attachment' ? r.attachment : null;
    if (a && (a.type === 'hook_additional_context' || stdoutIsContext(a))) {
      const text = (Array.isArray(a.content) ? a.content.join('\n') : String(a.content ?? a.stdout ?? '')).trim();
      if (!text || !inWindow) return;
      // Claude Code sometimes records the same output both ways: count it once
      const key = `${String(a.hookEvent || a.hookName || '').split(':')[0]}\u0000${text.slice(0, 200)}`;
      const seenAs = recent.get(key);
      if (seenAs && seenAs !== a.type) { recent.delete(key); return; }
      recent.set(key, a.type);
      if (recent.size > 200) recent.delete(recent.keys().next().value);
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
      // a plugin's prompt-time note carries no command; its session-start output did, with the same opening words
      const opening = text.split(/\s+/).slice(0, 3).join(' ').toLowerCase();
      let owner = plugins && a.command ? plugins.get(String(a.command)) : null;
      if (owner) learned.set(opening, owner);
      else if (learned.has(opening)) owner = learned.get(opening);
      const nb = bump(totals.byName, owner ? owner.split('@')[0] : nameOf(text, a.command, plugins), text.length);
      if (owner) nb.plugin = owner;
      const ev = event.split(':')[0] || null;
      nb.event = nb.count === 1 ? ev : nb.event === ev ? ev : null; // one event, or none named
      nb.source ||= source;
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
      byName: topNames(totals.byName),
      last: [...last]
    };
  }

  return { record, summary };
}

const NAMES_KEPT = 12;
/** The biggest named sources, by characters. PURE. */
export function topNames(bag, n = NAMES_KEPT) {
  return Object.fromEntries(Object.entries(bag || {})
    .sort((a, b) => (b[1].chars || 0) - (a[1].chars || 0))
    .slice(0, n)
    .map(([k, v]) => [k, { count: v.count, chars: v.chars, estTokens: Math.round((v.chars || 0) / 4), event: v.event || null, source: v.source || null, ...(v.plugin ? { plugin: v.plugin } : {}) }]));
}

/** Merge several summaries (per transcript → per project → everything). PURE. */
export function mergeInjectionSummaries(list) {
  const out = { count: 0, chars: 0, estTokens: 0, bySource: {}, byKind: {}, byEvent: {}, byName: {}, last: [] };
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
    for (const [k, v] of Object.entries(s.byName || {})) {
      const fresh = !out.byName[k];
      const b = (out.byName[k] ||= { count: 0, chars: 0, event: v.event || null, source: v.source || null });
      if (v.plugin) b.plugin = v.plugin;
      if (!fresh && b.event !== v.event) b.event = null;
      b.count += n(v.count); b.chars += chars(v);
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
  out.byName = topNames(out.byName);
  return out;
}

/**
 * Hook command → the plugin that registered it ("vercel@claude-plugins-official"),
 * from the hooks.json of every plugin in the config dirs' plugin cache. A
 * transcript records the command as written (with ${CLAUDE_PLUGIN_ROOT}
 * unexpanded), so the text alone names the plugin. A command two plugins share
 * names neither.
 */
export function pluginHookIndex(configDirs = []) {
  const candidates = new Map(); // command → Set of plugin keys
  const enabled = new Set();
  for (const dir of configDirs) {
    try { for (const [k, on] of Object.entries(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).enabledPlugins || {})) if (on) enabled.add(k); } catch { /* no settings */ }
    const cache = path.join(dir, 'plugins', 'cache');
    let markets = [];
    try { markets = fs.readdirSync(cache); } catch { continue; }
    for (const market of markets) {
      let plugins = [];
      try { plugins = fs.readdirSync(path.join(cache, market)); } catch { continue; }
      for (const plugin of plugins) {
        let versions = [];
        try { versions = fs.readdirSync(path.join(cache, market, plugin)); } catch { continue; }
        for (const v of versions) {
          // hooks/hooks.json, or inline under "hooks" in .claude-plugin/plugin.json
          const read = (f) => { try { const h = JSON.parse(fs.readFileSync(path.join(cache, market, plugin, v, f), 'utf8')).hooks; return h && typeof h === 'object' ? h : null; } catch { return null; } };
          const hooks = { ...(read(path.join('.claude-plugin', 'plugin.json')) || {}), ...(read(path.join('hooks', 'hooks.json')) || {}) };
          for (const groups of Object.values(hooks)) for (const g of Array.isArray(groups) ? groups : []) for (const h of g.hooks || []) {
            for (const c of [h.command, h.statusMessage].filter(Boolean)) (candidates.get(c) || candidates.set(c, new Set()).get(c)).add(`${plugin}@${market}`);
          }
        }
      }
    }
  }
  // one owner, or the one of several that is switched on; two switched on name neither
  const map = new Map();
  for (const [c, keys] of candidates) {
    const on = [...keys].filter((k) => enabled.has(k));
    const pick = keys.size === 1 ? [...keys] : on;
    if (pick.length === 1) map.set(c, pick[0]);
  }
  return map;
}
