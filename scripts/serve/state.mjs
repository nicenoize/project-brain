/**
 * serve/state.mjs — the read-only views of the brain's own state.
 *
 * /api/state, /api/events, /api/changed, /api/meta, /api/next and /api/brief:
 * everything that answers "what is this session doing right now" rather than
 * "what does the code look like". Also home to the two read-only active_state
 * accessors (`readStateSafe`/`readLeasesSafe`) the runner, lease and fleet
 * endpoints share — activeStateJson() would CREATE active_state.md via
 * ensureActiveState(), and a dashboard query must never write brain state.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_DIR } from '../common.mjs';
import { ACTIVE_STATE, activeStateJson } from '../active-state.mjs';
// Both imports are verified side-effect-free: brain-route's isMain guard is
// asserted by tests/brain-route.test.mjs, brain-brief exports its pure core.
import { applyRules, scoreChange } from '../brain-route.mjs';
import { buildBrief } from '../brain-brief.mjs';
import { getIndexProvider } from '../index-provider.mjs';
import { sendJson } from './security.mjs';
import { freshness, liveMeta, frontmatterTitle } from './records.mjs';
import { changedSnapshot, filesParam, targetFiles, MAX_FILES_PARAM } from './git.mjs';

const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 1000;

/** Read-only state view: never creates active_state.md (same guard as apiState). */
/** Read-only state view, same guard as apiState: never creates the file. */
export function readStateSafe() {
  if (!fs.existsSync(ACTIVE_STATE)) return { workstreams: [], leases: [], blockers: [], overlaps: [] };
  return activeStateJson();
}

/** Active (non-expired) leases, read-only — mirrors brain-intel#readLeasesSafe. */
export function readLeasesSafe(nowMs) {
  try {
    if (!fs.existsSync(ACTIVE_STATE)) return null;
    return activeStateJson().leases.filter((l) => {
      if (!l.target) return false;
      const until = Date.parse(l.until);
      return !(Number.isFinite(until) && until < nowMs);
    });
  } catch {
    return null;
  }
}

/**
 * Per-handler memo for the index provider probe: one lookup per daemon, shared
 * by /api/meta and the /api/brief pack preview. A factory (not a module-level
 * memo) so two handlers in one process — as the tests build — never inherit
 * each other's probe result.
 */
export function createProviderInfo() {
  let providerPromise = null;
  return function providerInfo() {
    if (!providerPromise) {
      providerPromise = getIndexProvider()
        .then((p) => ({ name: p.name, model: p.modelName || null, available: p.name !== 'none' }))
        .catch((error) => ({ name: 'unavailable', model: null, available: false, error: String(error.message || error) }));
    }
    return providerPromise;
  };
}

export function apiState(api, res) {
  // Read-only guard: activeStateJson() would CREATE the file via
  // ensureActiveState(); a dashboard query must never write brain state.
  if (!fs.existsSync(ACTIVE_STATE)) {
    return sendJson(res, 200, {
      workstreams: [], leases: [], blockers: [], overlaps: [],
      ...freshness(ACTIVE_STATE)
    });
  }
  sendJson(res, 200, { ...activeStateJson(), ...freshness(ACTIVE_STATE) });
}

export function apiEvents(api, res, url) {
  const { brainDir } = api;
  const file = path.join(brainDir, 'events.jsonl');
  const raw = Number(url.searchParams.get('limit') || DEFAULT_EVENT_LIMIT);
  const limit = Math.min(Math.max(Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_EVENT_LIMIT, 1), MAX_EVENT_LIMIT);
  if (!fs.existsSync(file)) {
    return sendJson(res, 200, { events: [], ...freshness(file) });
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  const parsed = [];
  for (const line of lines) {
    try { parsed.push(JSON.parse(line)); } catch { /* skip malformed lines */ }
  }
  // Tail AFTER parsing so malformed lines never eat into the limit.
  sendJson(res, 200, { events: parsed.slice(-limit), ...freshness(file) });
}

export function apiChanged(api, res) {
  const { root } = api;
  sendJson(res, 200, { ...changedSnapshot(root), ...liveMeta() });
}

export async function apiMeta(api, res) {
  const { root, ctx } = api;
  const provider = await api.providerInfo();
  let version = '0.0.0';
  try {
    version = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8')).version || version;
  } catch {}
  sendJson(res, 200, {
    name: 'project-brain serve',
    version,
    root,
    node: process.version,
    port: ctx.port ?? null,
    provider,
    ...freshness(ACTIVE_STATE)
  });
}

/**
 * Minimal read-only sensing for the exported brain-route rule engine.
 * brain-route's own senseState() is not exported (and opens the index /
 * calls gh), so only the cheap, highest-value signals are sensed here:
 * dirty tree + change band, index presence, backlog counts, lease
 * conflicts. Unsensed signals stay null/0 — applyRules treats them as quiet.
 */
async function senseSignals(api) {
  const { root, brainDir } = api;
  const snapshot = changedSnapshot(root);
  const changedFiles = [...new Set([...snapshot.staged, ...snapshot.unstaged])];
  const branch = snapshot.branch || '';
  const brainInitialized = fs.existsSync(brainDir) && fs.existsSync(path.join(brainDir, 'context_index.md'));
  const indexed = fs.existsSync(path.join(brainDir, 'search_index.json')) ||
    fs.existsSync(path.join(brainDir, 'index_manifest.json'));
  const { band, riskKeyword, recommendedPackages } = scoreChange(changedFiles, branch);
  let backlog = { open: 0, planned: 0, plans: 0 };
  let ungrilledPlanned = 0;
  try {
    const { loadFindings, loadPlans, loadGrills } = await import('../findings.mjs');
    const findings = loadFindings();
    backlog = {
      open: findings.filter((f) => f.status === 'open').length,
      planned: findings.filter((f) => f.status === 'planned').length,
      plans: loadPlans().length
    };
    const proceeded = new Set(loadGrills().filter((g) => g.verdict === 'proceed').map((g) => g.target));
    ungrilledPlanned = findings.filter((f) => f.status === 'planned' && !proceeded.has(f.slug)).length;
  } catch { /* soft — no findings dirs yet */ }
  let leaseConflicts = 0;
  try {
    if (changedFiles.length && fs.existsSync(ACTIVE_STATE)) {
      const state = activeStateJson();
      leaseConflicts = buildBrief({
        files: changedFiles,
        leases: state.leases || [],
        workstreams: state.workstreams || [],
        actor: process.env.BRAIN_ACTOR || ''
      }).conflicts.length;
    }
  } catch { /* soft */ }
  return {
    branch,
    detachedHead: !branch,
    brainInitialized,
    indexed,
    changedFiles: changedFiles.length,
    stagedFiles: snapshot.staged.length,
    changeBand: band,
    riskKeyword,
    recommendedPackages,
    backlog,
    ungrilledPlanned,
    leaseConflicts,
    // Deliberately unsensed (needs the index / gh — too costly per request):
    commitsAhead: 0, commitsAheadNoPr: false, base: '',
    indexStale: null, gaps: null
  };
}

export async function apiNext(api, res) {
  const signals = await senseSignals(api);
  const result = applyRules(signals, { top: 5 });
  const actions = result.recommendations.slice(0, 5).map((r) => ({
    command: `${r.command}${r.args && r.args.length ? ` ${r.args.join(' ')}` : ''}`,
    reason: r.reason,
    boundary: r.boundary
  }));
  sendJson(res, 200, {
    actions,
    provenance: { basis: 'sensed', source: 'brain-route rule engine over read-only signals', signals },
    ...liveMeta()
  });
}

/**
 * Governing ADRs for buildBrief — the loader inside brain-brief.mjs is not
 * exported, so this is the minimal read-only re-implementation: id/module/
 * title/body from frontmatter, body capped to bound cost. Fails soft to [].
 */
function loadDecisionsSafe(brainDir) {
  const dir = path.join(brainDir, 'decisions');
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(dir, name), 'utf8').slice(0, 64 * 1024); } catch { continue; }
    if (!text) continue;
    const fm = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    let module = '';
    let body = text;
    if (fm) {
      body = fm[2] || '';
      const m = fm[1].match(/^module:\s*(.*)$/m);
      if (m) module = m[1].trim();
    }
    out.push({
      id: name.replace(/\.md$/, ''),
      module,
      title: frontmatterTitle(text),
      body,
      file: `.project-brain/decisions/${name}`
    });
  }
  return out;
}

const PACK_PREVIEW_TOKENS = 1200;

/**
 * The copy-to-agent payload: brain:pack in for-agent mode over the target
 * files, ~1200-token budget. Guarded end to end — provider 'none' or any
 * throw degrades to packPreview null + packWarning, never a 500.
 */
async function packPreviewFor(api, files) {
  try {
    const provider = await api.providerInfo();
    if (!provider.available) {
      return { packPreview: null, packWarning: `no index provider (${provider.name}) — pack preview skipped` };
    }
    const { packPrompt } = await import('../brain-pack.mjs');
    const packed = await packPrompt(files.join(' ') || 'project overview', {
      maxTokens: PACK_PREVIEW_TOKENS,
      mode: 'for-agent',
      forAgent: 'control-room'
    });
    return { packPreview: packed.prompt, ...(packed.warning ? { packWarning: packed.warning } : {}) };
  } catch (error) {
    return { packPreview: null, packWarning: `pack preview unavailable: ${error.message || error}` };
  }
}

export async function apiBrief(api, res, url) {
  const { root, brainDir } = api;
  const explicit = filesParam(url);
  if (explicit && explicit.length > MAX_FILES_PARAM) {
    return sendJson(res, 400, { error: `too many files (max ${MAX_FILES_PARAM})` });
  }
  const files = targetFiles(root, url);
  let advisories = [];
  let briefWarning;
  try {
    const state = fs.existsSync(ACTIVE_STATE)
      ? activeStateJson()
      : { leases: [], workstreams: [] }; // read-only guard: never create it
    const brief = buildBrief({
      files,
      leases: state.leases || [],
      workstreams: state.workstreams || [],
      decisions: loadDecisionsSafe(brainDir),
      actor: process.env.BRAIN_ACTOR || ''
    });
    advisories = brief.advisories.map((a) => {
      const target = (a.files && a.files[0]) || a.decision || a.downstream || a.session;
      return { severity: a.severity, kind: a.kind, message: a.message, ...(target ? { target } : {}) };
    });
  } catch (error) {
    briefWarning = `advisories unavailable: ${error.message || error}`;
  }
  const { packPreview, packWarning } = await packPreviewFor(api, files);
  sendJson(res, 200, {
    files,
    advisories,
    ...(briefWarning ? { briefWarning } : {}),
    packPreview,
    ...(packWarning ? { packWarning } : {}),
    ...liveMeta()
  });
}
