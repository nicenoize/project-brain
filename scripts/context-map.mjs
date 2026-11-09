/**
 * context-map — what fills a session's context window, estimated from the
 * transcript since its last compaction. The usage numbers say HOW MUCH is in
 * the context; this says WHAT: tool results by tool (and the biggest single
 * reads and commands), the agent's own writing, your prompts, what hooks
 * injected, the compaction summary. Whatever the transcript cannot show (the
 * system prompt, tool definitions, CLAUDE.md and memory files) is the
 * difference to the real context and reported as `base`.
 *
 * The base is MEASURED: the first request's context minus what the transcript
 * shows before it. The parts are ESTIMATED (characters / 4; an image ≈ 1,600
 * tokens), which runs about 2× low on code and JSON, so they are scaled to
 * the real remainder (context − base) and the factor is reported. Without a
 * measured base (the start of the transcript was not read) they stay raw.
 * PURE but for the state it keeps; never reads anything itself.
 */

const est = (chars) => Math.round(chars / 4);
const IMAGE_CHARS = 6400;

export function kindOf(name = '') {
  if (name === 'Read') return 'read';
  if (name === 'Bash' || name === 'BashOutput') return 'bash';
  if (/^(Grep|Glob|LS)$/.test(name)) return 'search';
  if (/^(WebFetch|WebSearch)$/.test(name)) return 'web';
  if (/^(Task|Agent)$/.test(name)) return 'agents';
  if (name.startsWith('mcp__')) return 'mcp';
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return 'edits';
  return 'tools';
}

/** A short label for one call: the file, the command, the pattern. */
export function labelOf(name = '', input = {}) {
  const i = input && typeof input === 'object' ? input : {};
  const cut = (s, n = 48) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
  if (i.file_path || i.notebook_path) return String(i.file_path || i.notebook_path).split('/').slice(-2).join('/');
  if (name === 'Bash') return cut(i.command);
  if (i.pattern) return cut(i.pattern, 32);
  if (i.url) return cut(i.url, 40);
  if (i.query) return cut(i.query, 40);
  if (i.description) return cut(i.description, 40);
  if (name.startsWith('mcp__')) return name.split('__').slice(1).join(' ');
  return '';
}

function contentChars(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return content == null ? 0 : JSON.stringify(content).length;
  let n = 0;
  for (const c of content) {
    if (!c) continue;
    if (c.type === 'text' && typeof c.text === 'string') n += c.text.length;
    else if (c.type === 'image') n += IMAGE_CHARS;
    else n += JSON.stringify(c).length;
  }
  return n;
}

export function createContextMap({ maxItems = 400 } = {}) {
  let parts = new Map();
  let items = new Map();
  let uses = new Map();
  let summary = 0;
  let compacted = false;
  let base = null;
  let seenTotal = 0;

  const add = (kind, tokens, label = '') => {
    if (!tokens) return;
    seenTotal += tokens;
    parts.set(kind, (parts.get(kind) || 0) + tokens);
    if (!label) return;
    const key = `${kind}\u0000${label}`;
    items.set(key, (items.get(key) || 0) + tokens);
    if (items.size > maxItems) {
      // keep the bigger half: the top five can only come from there
      items = new Map([...items].sort((a, b) => b[1] - a[1]).slice(0, maxItems / 2));
    }
  };

  function feed(r) {
    if (!r || typeof r !== 'object' || r.isSidechain) return;
    if (r.type === 'system' && r.subtype === 'compact_boundary') {
      parts = new Map(); items = new Map(); uses = new Map();
      summary = (r.compactMetadata && r.compactMetadata.postTokens) || 0;
      compacted = true;
      return;
    }
    if (r.type === 'attachment') {
      const a = r.attachment || {};
      if (a.type === 'hook_additional_context') {
        const text = Array.isArray(a.content) ? a.content.join('\n') : String(a.content || '');
        add('hooks', est(text.length), String(a.hookName || 'hook').split(':')[0]);
      }
      return;
    }
    const content = r.message && r.message.content;
    if (r.type === 'assistant') {
      const u = r.message && r.message.usage;
      if (u && base === null && !compacted) {
        const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        if (ctx > 0) base = Math.max(0, ctx - seenTotal);
      }
      for (const c of Array.isArray(content) ? content : []) {
        if (!c) continue;
        if (c.type === 'text' && typeof c.text === 'string') add('assistant', est(c.text.length));
        else if (c.type === 'tool_use') {
          uses.set(c.id, { kind: kindOf(c.name), label: labelOf(c.name, c.input) });
          add('assistant', est(JSON.stringify(c.input || {}).length));
        }
      }
      return;
    }
    if (r.type === 'user') {
      if (typeof content === 'string') { add(r.isMeta ? 'other' : 'you', est(content.length)); return; }
      for (const c of Array.isArray(content) ? content : []) {
        if (!c) continue;
        if (c.type === 'tool_result') {
          const u = uses.get(c.tool_use_id);
          uses.delete(c.tool_use_id);
          add(u ? u.kind : 'tools', est(contentChars(c.content)), u ? u.label : '');
        } else if (c.type === 'text' && typeof c.text === 'string') add(r.isMeta ? 'other' : 'you', est(c.text.length));
        else if (c.type === 'image') add('you', est(IMAGE_CHARS));
      }
    }
  }

  /** `ctx`: the real context from the last request's usage. */
  function snapshot(ctx = 0) {
    const raw = [...parts].map(([kind, tokens]) => ({ kind, tokens }));
    if (summary) raw.push({ kind: 'summary', tokens: summary }); // measured by Claude Code: not scaled
    const estimated = raw.filter((p) => p.kind !== 'summary').reduce((a, p) => a + p.tokens, 0);
    // scale the estimates to what the real context leaves for them; a factor far off means a bad base: stay raw
    let scale = 1;
    if (base !== null && estimated > 0 && ctx > 0) {
      const f = (ctx - base - summary) / estimated;
      if (f >= 0.5 && f <= 4) scale = Math.round(f * 100) / 100;
    }
    const k = (p) => (p.kind === 'summary' ? p.tokens : Math.round(p.tokens * scale));
    const list = raw.map((p) => ({ kind: p.kind, tokens: k(p) }));
    if (base !== null) list.push({ kind: 'base', tokens: base });
    list.sort((a, b) => b.tokens - a.tokens);
    const top = [...items].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([key, tokens]) => {
      const [kind, label] = key.split('\u0000');
      return { kind, label, tokens: Math.round(tokens * scale) };
    });
    return { ctx, base, scale, since: compacted ? 'compaction' : 'start', parts: list, top };
  }

  return { feed, snapshot };
}
