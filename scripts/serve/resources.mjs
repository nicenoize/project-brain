/**
 * /api/resources — "Does this machine have room for another agent, and what
 * can go?" (R5, docs/roadmap-next.md). brain:ps's collect(), shaped for the
 * Control Room and cached briefly: a full reading walks the process table,
 * footprints, transcripts and docker (~0.5 s), and SSE reloads come in bursts.
 *
 * Read-only on purpose. Stopping a foreign session or a docker stack stays a
 * command the human copies: the daemon's write surface is the runner and
 * lease endpoints and nothing else (security model (d) in brain-serve.mjs).
 */
import os from 'node:os';
import { collect } from '../brain-ps.mjs';
import { sendJson } from './security.mjs';

const TTL_MS = 20_000;
let cache = null;

const home = (p) => (p ? p.replace(os.homedir(), '~') : null);

/** PURE. The panel's view of a brain:ps snapshot. */
export function resourcesView(r) {
  const sum = (list, f) => list.reduce((a, x) => a + f(x), 0);
  return {
    system: r.system,
    sessions: r.sessions.map((s) => ({ pid: s.pid, verdict: s.verdict, mb: Math.round(s.mb), ageSec: s.ageSec, lastActivityMs: s.lastActivityMs, cwd: home(s.cwd) })),
    helpers: Object.fromEntries(Object.entries(r.helpers).map(([k, list]) => [k, { count: list.length, mb: Math.round(sum(list, (x) => x.rssKb / 1024)) }])),
    dockerMb: Math.round(r.dockerMb),
    stacks: (r.stacks || []).map((s) => ({ project: s.project, containers: s.containers.length, verdict: s.verdict, stopCmd: s.stopCmd })),
    runners: r.runners || [],
    orphans: r.orphans.length,
    mcp: r.mcp || [],
    admission: r.admission,
    idleCmd: (() => {
      const idle = r.sessions.filter((s) => s.verdict === 'idle');
      return idle.length ? `kill -TERM ${idle.map((s) => s.pid).join(' ')}` : null;
    })(),
    idleHours: r.idleHours
  };
}

export function apiResources(api, res) {
  const now = Date.now();
  if (!cache || now - cache.at > TTL_MS) {
    try {
      cache = { at: now, view: resourcesView(collect()) };
    } catch (error) {
      return sendJson(res, 200, { degraded: true, reason: String((error && error.message) || error) });
    }
  }
  sendJson(res, 200, { ...cache.view, readAt: new Date(cache.at).toISOString() });
}
