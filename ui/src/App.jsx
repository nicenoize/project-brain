import { useEffect, useMemo, useState } from 'react';
import { api, subscribe, TOKEN } from './api.js';
import Board from './components/Board.jsx';
import LeaseBoard from './components/LeaseBoard.jsx';
import Intel from './components/Intel.jsx';
import AuditFeed from './components/AuditFeed.jsx';
import Records from './components/Records.jsx';
import NextPanel from './components/NextPanel.jsx';
import RiskPanel from './components/RiskPanel.jsx';
import BlastPanel from './components/BlastPanel.jsx';
import MapPanel from './components/MapPanel.jsx';
import FleetPanel from './components/FleetPanel.jsx';
import GraphPanel from './components/GraphPanel.jsx';
import SecurityPanel from './components/SecurityPanel.jsx';

function useData() {
  const [data, setData] = useState({ loading: true });
  const load = async () => {
    try {
      const [meta, state, events, hotspots, health, coChange, ownership, records, runnersInfo, changed, next, risk, blast, brief, map, fleet, graph, security] =
        await Promise.all([
          api.meta(), api.state(), api.events(),
          api.hotspots(), api.health(), api.coChange(), api.ownership(),
          api.records('decision').catch(() => ({ records: [] })),
          api.runners().catch(() => ({ runners: [], runnerCmdConfigured: false })),
          api.changed().catch(() => null),
          api.next().catch(() => null),
          api.risk().catch(() => null),
          api.blast().catch(() => null),
          api.brief().catch(() => null),
          api.map().catch(() => null),
          api.fleet().catch(() => null),
          api.graph().catch(() => null),
          api.security().catch(() => null)
        ]);
      setData({ meta, state, events, hotspots, health, coChange, ownership, records, runnersInfo, changed, next, risk, blast, brief, map, fleet, graph, security, loading: false });
    } catch (error) {
      setData({ error, loading: false });
    }
  };
  useEffect(() => {
    load();
    return subscribe(load);
  }, []);
  return { ...data, reload: load };
}

/** Which lease targets clash with another actor's active work — feeds both
    the red row wash on the board and the conflict wash on the lease table. */
function findConflicts(workstreams, leases) {
  const conflictsByTask = new Map();
  const conflictTargets = new Set();
  for (const l of leases) {
    for (const ws of workstreams) {
      if (!ws.owner || !l.lockedBy) continue;
      if (ws.owner === l.lockedBy) continue;
      const note = `${l.notes || ''} ${l.target || ''}`;
      if (ws.task && note.includes(ws.task)) {
        conflictsByTask.set(ws.task, l.target);
        conflictTargets.add(l.target);
      }
    }
  }
  return { conflictsByTask, conflictTargets };
}

/**
 * Does this section hold something now, and does it want a human?
 * The andon move: the board tells you WHERE to look before you read it.
 * `state` maps onto the same three lamps the work rows use — nothing else
 * on the board may spend those colours (see theme.css).
 */
function sectionState(id, d, { workstreams, leases, conflictsByTask }) {
  switch (id) {
    case 'fleet': {
      const top = (d.fleet?.projects || [])[0];
      if (d.fleet?.degraded) return 'quiet';
      return top?.attention >= 50 ? 'stop' : top?.attention >= 20 ? 'attn' : 'run';
    }
    case 'next': {
      const acts = d.next?.actions || [];
      if (!acts.length) return 'quiet';
      // A queue of safe-to-run commands is information; only a decision that
      // needs a person earns the lamp.
      return acts.some((a) => a.boundary === 'human') ? 'attn' : 'run';
    }
    case 'risk': {
      const sc = d.risk?.score;
      if (sc == null) return 'quiet';
      return sc >= 6.5 ? 'stop' : sc >= 3.5 ? 'attn' : 'run';
    }
    case 'blast':
      // A measured radius is evidence, not an alarm.
      return (d.blast?.nodes || []).some((n) => n.kind !== 'seed') ? 'run' : 'quiet';
    case 'security': {
      const reach = d.security?.vulnerabilities?.reachable || [];
      const secrets = d.security?.secrets?.findings || [];
      if (secrets.length || reach.some((v) => v.severity === 'critical')) return 'stop';
      return reach.length ? 'attn' : 'quiet';
    }
    case 'board':
      if (conflictsByTask.size) return 'stop';
      return workstreams.length ? 'run' : 'quiet';
    case 'leases':
      return leases.length ? 'run' : 'quiet';
    case 'graph':
      return (d.graph?.cycles || []).length ? 'attn' : 'quiet';
    case 'danger': {
      const files = d.health?.files || [];
      if (!files.length) return 'quiet';
      // A ranking always exists; only a file in the top band asks for someone.
      return files[0]?.score >= 6.5 ? 'attn' : 'run';
    }
    case 'map':
      return (d.map?.orphans?.codeDirs || []).length ? 'attn' : 'quiet';
    case 'audit':
      return (d.events?.events || []).length ? 'run' : 'quiet';
    case 'records':
      return (d.records?.records || []).length ? 'run' : 'quiet';
    default:
      return 'quiet';
  }
}

/** Urgency rank: a section that wants a human comes before one that does not. */
const STATE_RANK = { stop: 0, attn: 1, run: 2, quiet: 3 };

/** One section: lamped head, then its panel. A quiet section stays legible
    but stops competing — same stock, less presence. */
function Section({ id, heading, node, state }) {
  return (
    <section className={`bay-section state-${state}`} aria-labelledby={`h-${id}`}>
      <h2 id={`h-${id}`}>
        {/* Only a state that wants a human lights the head; 'run' and 'quiet'
            stay dark. Green at section level would mean "has content", which
            is how the lamp lost its meaning the first time. */}
        <span className={`lamp ${state === 'stop' || state === 'attn' ? state : ''}`} aria-hidden="true" />
        {heading}
      </h2>
      <div className="sheet">{node}</div>
    </section>
  );
}

export default function App() {
  const [density, setDensity] = useState('deployed'); // miura raise: one control
  const d = useData();

  const state = d.state || {};
  // The state API names the column taskId; the board speaks of a task.
  const workstreams = (state.workstreams || []).map((w) => ({ ...w, task: w.task || w.taskId || '' }));
  const leases = state.leases || [];
  const { conflictsByTask, conflictTargets } = useMemo(
    () => findConflicts(workstreams, leases), [workstreams, leases]
  );

  const meta = d.meta || {};
  const stateAge = d.state?.state_age;
  // An old state file is only *stale* when something claims to be in flight;
  // an empty board that hasn't changed in weeks is simply quiet.
  const inFlight = workstreams.length > 0 || leases.length > 0;
  const freshLabel = (() => {
    if (stateAge == null) return 'live';
    const s = Math.round(stateAge);
    if (s < 90) return 'live';
    if (s < 5400) return `state ${Math.round(s / 60)} min old`;
    if (s < 172800) return `state ${Math.round(s / 3600)} h old`;
    return `state ${Math.round(s / 86400)} d old`;
  })();
  const staleAmber = inFlight && stateAge != null && stateAge > 6 * 3600;

  if (!TOKEN) {
    return (
      <div className="shell">
        <header className="masthead">
          <h1 className="wordmark">Control Room<small>project brain</small></h1>
        </header>
        <main className="floor"><div className="bay">
          <p className="error-note">
            No session token. Start the daemon with <code>project-brain serve</code>{' '}
            and open the printed URL — the token rides in it.
          </p>
        </div></main>
      </div>
    );
  }

  // Sections declare themselves; the board decides order and emphasis. A lamp
  // at the head is the andon move: you see WHERE to look before you read.
  const ctx = { workstreams, leases, conflictsByTask };
  const describe = (id, heading, node) => ({ id, heading, node, state: sectionState(id, d, ctx) });

  const mainSections = [
    ...(d.fleet && !d.fleet.degraded
      ? [describe('fleet', 'Which repo needs attention?', <FleetPanel fleet={d.fleet} />)] : []),
    describe('next', 'What should happen next?', <NextPanel next={d.next} />),
    describe('risk', 'Is this change dangerous?',
      <RiskPanel changed={d.changed} risk={d.risk} brief={d.brief} />),
    describe('blast', 'What breaks if I change this?', <BlastPanel blast={d.blast} />),
    describe('security', 'What here is exploitable?', <SecurityPanel security={d.security} />),
    describe('board', 'What is running right now?',
      <Board workstreams={workstreams} conflictsByTask={conflictsByTask} runnersInfo={d.runnersInfo} onChanged={d.reload} />),
    describe('danger', 'Which files are most dangerous?',
      <Intel hotspots={d.hotspots} health={d.health} coChange={d.coChange} ownership={d.ownership} leases={leases} />),
    describe('graph', 'What is tangled?', <GraphPanel graph={d.graph} />),
    describe('map', 'Why is it built this way?', <MapPanel map={d.map} records={d.records} />)
  ].sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state]);

  // The rail-and-T-card board is the surface's signature. Rank may move it up,
  // never far down: a quiet board is still the thing this product IS.
  const boardIdx = mainSections.findIndex((x) => x.id === 'board');
  if (boardIdx > 1) mainSections.splice(1, 0, mainSections.splice(boardIdx, 1)[0]);

  const sideSections = [
    describe('leases', 'Who holds what — until when?',
      <LeaseBoard leases={leases} conflictTargets={conflictTargets} onChanged={d.reload} />),
    describe('audit', 'What happened — and who acknowledged it?',
      <AuditFeed events={d.events?.events || []} />),
    ...(d.fleet?.degraded
      ? [describe('fleet', 'How large is the fleet?', <FleetPanel fleet={d.fleet} />)] : []),
    describe('records', 'Which decisions are on record?',
      <Records records={d.records?.records || []} />)
  ].sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state]);

  // The side column is NOT ranked by urgency the way the answer column is.
  // Leases are the coordination primitive and the other end of raise 3
  // (treemap cell <-> lease row); a settled-decision archive is the least
  // time-sensitive thing on the surface. An empty lease board still belongs
  // first — its emptiness is the answer to its own question.
  const SIDE_ORDER = ['leases', 'audit', 'fleet', 'records'];
  sideSections.sort((a, b) => SIDE_ORDER.indexOf(a.id) - SIDE_ORDER.indexOf(b.id));

  return (
    <div className={`shell ${density === 'packet' ? 'compact' : ''}`}>
      <header className="masthead">
        <h1 className="wordmark">Control Room<small>project brain</small></h1>
        <span className="repo num">{meta.root || ''}</span>
        <span className="fresh">
          {staleAmber
            ? <span className="stale">{freshLabel} — verify before trusting</span>
            : freshLabel}
        </span>
        <div className="density" role="group" aria-label="Density">
          <button aria-pressed={density === 'packet'} onClick={() => setDensity('packet')}>packet</button>
          <button aria-pressed={density === 'deployed'} onClick={() => setDensity('deployed')}>deployed</button>
        </div>
      </header>

      <main className="floor">
        <section className="bay" aria-label="Work board">
          {d.loading && <><div className="skeleton" style={{ width: '60%' }} /><div className="skeleton" style={{ width: '80%' }} /><div className="skeleton" style={{ width: '45%' }} /></>}
          {d.error && (
            <p className="error-note">
              Daemon unreachable ({String(d.error.message || d.error)}). Is{' '}
              <code>project-brain serve</code> still running?
            </p>
          )}
          {!d.loading && !d.error && mainSections.map((sec) => (
            <Section key={sec.id} {...sec} />
          ))}
        </section>

        {!d.loading && !d.error && (
          <aside className="bay" aria-label="Leases, audit and decisions">
            {sideSections.map((sec) => <Section key={sec.id} {...sec} />)}
          </aside>
        )}
      </main>
    </div>
  );
}
