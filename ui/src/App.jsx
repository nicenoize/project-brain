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
          <div className="wordmark">Control Room<small>project brain</small></div>
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

  return (
    <div className={`shell ${density === 'packet' ? 'compact' : ''}`}>
      <header className="masthead">
        <div className="wordmark">Control Room<small>project brain</small></div>
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
          {!d.loading && !d.error && (
            <>
              {d.fleet && !d.fleet.degraded && (
                <>
                  <h2>Which repo needs attention?</h2>
                  <div className="sheet">
                    <FleetPanel fleet={d.fleet} />
                  </div>
                </>
              )}
              <h2>What should happen next?</h2>
              <div className="sheet">
                <NextPanel next={d.next} />
              </div>
              <h2>Is this change dangerous?</h2>
              <div className="sheet">
                <RiskPanel changed={d.changed} risk={d.risk} brief={d.brief} />
              </div>
              <h2>What breaks if I change this?</h2>
              <div className="sheet">
                <BlastPanel blast={d.blast} />
              </div>
              <h2>What's running right now?</h2>
              <div className="sheet">
                <Board workstreams={workstreams} conflictsByTask={conflictsByTask} runnersInfo={d.runnersInfo} onChanged={d.reload} />
              </div>
              <h2>What here is actually exploitable?</h2>
              <div className="sheet">
                <SecurityPanel security={d.security} />
              </div>
              <h2>What's tangled?</h2>
              <div className="sheet">
                <GraphPanel graph={d.graph} />
              </div>
              <h2>Why is it built this way?</h2>
              <div className="sheet">
                <MapPanel map={d.map} records={d.records} />
              </div>
              <h2>Which files are actually dangerous?</h2>
              <Intel hotspots={d.hotspots} health={d.health} coChange={d.coChange} ownership={d.ownership} leases={leases} />
            </>
          )}
        </section>

        {!d.loading && !d.error && (
          <aside className="bay" aria-label="Leases, audit and decisions">
            <h2>Who holds what — until when?</h2>
            <div className="sheet">
              <LeaseBoard leases={leases} conflictTargets={conflictTargets} onChanged={d.reload} />
            </div>
            <h2>What happened — and who acknowledged it?</h2>
            <div className="sheet">
              <AuditFeed events={d.events?.events || []} />
            </div>
            {d.fleet?.degraded && (
              <>
                <h2>Fleet</h2>
                <div className="sheet">
                  <FleetPanel fleet={d.fleet} />
                </div>
              </>
            )}
            <h2>Decisions on record</h2>
            <div className="sheet">
              <Records records={d.records?.records || []} />
            </div>
          </aside>
        )}
      </main>
    </div>
  );
}
