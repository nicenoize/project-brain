import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { api } from '../api.js';

// Andon lamp state for a workstream row.
function laneState(ws, conflictsByTask, runner) {
  const status = (ws.status || '').toLowerCase();
  if (conflictsByTask.has(ws.task)) return 'stop';
  if (status.includes('block') || status.includes('stuck')) return 'stop';
  if (runner?.status === 'running') return 'run';
  if (status.includes('review') || status.includes('wait')) return 'attn';
  if (status.includes('active') || status.includes('progress') || status.includes('running')) return 'run';
  return 'idle';
}

const WASH = { run: 'wash-run', attn: 'wash-attn', stop: 'wash-stop', idle: '' };

/** Bounded log tail for a running agent; polls while open. */
function LogDrawer({ runnerId }) {
  const [log, setLog] = useState(null);
  useEffect(() => {
    let alive = true;
    const pull = () =>
      api.runnerLog(runnerId).then((r) => { if (alive) setLog(r); }).catch(() => {});
    pull();
    const t = setInterval(pull, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [runnerId]);
  return (
    <pre className="logview" aria-label="Agent log tail">
      {log ? (log.lines || []).join('\n') || 'log is empty so far' : 'reading log…'}
      {log?.truncated ? '\n[… earlier output trimmed]' : ''}
    </pre>
  );
}

/** The kamishibai board: one rail row per workstream, lamp at the card head.
    Start pulls the brief gate INLINE into the row (advisories must be read
    before the spawn — the governance moment); running cards carry stop + log. */
export default function Board({ workstreams, conflictsByTask, runnersInfo, onChanged }) {
  const [gate, setGate] = useState(null);       // {task, advisories}
  const [busy, setBusy] = useState('');         // task currently starting/stopping
  const [openLog, setOpenLog] = useState('');   // runner id with open drawer
  const [note, setNote] = useState(null);       // {task, text} transient error

  const runners = new Map(
    (runnersInfo?.runners || [])
      .filter((r) => r.status === 'running')
      .map((r) => [r.task, r])
  );
  const cmdReady = Boolean(runnersInfo?.runnerCmdConfigured);

  const start = async (task, acknowledged) => {
    setBusy(task); setNote(null);
    try {
      await api.startRunner(task, acknowledged);
      setGate(null);
      onChanged?.();
    } catch (err) {
      if (err.status === 409 && err.data?.briefGate) {
        setGate({ task, advisories: err.data.advisories || [] });
      } else {
        setNote({ task, text: err.data?.hint || err.message });
      }
    } finally {
      setBusy('');
    }
  };

  const stop = async (task, id) => {
    setBusy(task);
    try {
      await api.stopRunner(id);
      if (openLog === id) setOpenLog('');
      onChanged?.();
    } catch (err) {
      setNote({ task, text: err.message });
    } finally {
      setBusy('');
    }
  };

  if (!workstreams.length) {
    return (
      <p className="empty">
        No work in flight. Start one with{' '}
        <code>npm run brain:work -- start --task &lt;slug&gt;</code> — the card
        appears here with its lamp and a start control.
      </p>
    );
  }
  return (
    <div>
      {workstreams.map((ws) => {
        const runner = runners.get(ws.task);
        const state = laneState(ws, conflictsByTask, runner);
        const gated = gate?.task === ws.task;
        return (
          <motion.div
            key={ws.task || ws.branch}
            layout
            className={`rail-row ${gated ? 'wash-attn' : WASH[state]}`}
            animate={state === 'stop' ? { y: -2 } : { y: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
          >
            <span className={`lamp ${state}`} aria-hidden="true" />
            <div className="tcard">
              <div className="head">
                <span className="task">{ws.task || ws.branch || 'untitled'}</span>
                <span className={`chip ${state === 'idle' ? 'idle' : state}`}>
                  {conflictsByTask.has(ws.task)
                    ? 'lease conflict'
                    : runner ? 'agent running' : (ws.status || 'idle')}
                </span>
                <span className="card-actions">
                  {runner ? (
                    <>
                      <button
                        className="btn quiet"
                        onClick={() => setOpenLog(openLog === runner.id ? '' : runner.id)}
                        aria-expanded={openLog === runner.id}
                      >
                        {openLog === runner.id ? 'hide log' : 'log'}
                      </button>
                      <button
                        className="btn"
                        disabled={busy === ws.task}
                        onClick={() => stop(ws.task, runner.id)}
                      >
                        {busy === ws.task ? 'stopping…' : 'stop'}
                      </button>
                    </>
                  ) : cmdReady ? (
                    <button
                      className="btn"
                      disabled={busy === ws.task || gated}
                      onClick={() => start(ws.task, false)}
                    >
                      {busy === ws.task ? 'starting…' : 'start agent'}
                    </button>
                  ) : (
                    <span
                      className="cmd-hint"
                      title='Set "runnerCmd" in .project-brain/config.json (or BRAIN_RUNNER_CMD) to start agents from here'
                    >
                      no runner configured
                    </span>
                  )}
                </span>
              </div>
              <div className="meta">
                <span className="actor">{ws.owner || 'unassigned'}</span>
                {ws.tool ? ` · ${ws.tool}` : ''}
                {ws.branch ? ` · ${ws.branch}` : ''}
                {ws.project ? ` · ${ws.project}` : ''}
              </div>

              {note && note.task === ws.task && (
                <p className="error-note" role="alert">{note.text}</p>
              )}

              {gated && (
                <div className="gate" role="alertdialog" aria-label="Brief before start">
                  <p className="gate-head">
                    Read before starting — these leases are held by someone else:
                  </p>
                  <ul>
                    {gate.advisories.map((a, i) => (
                      <li key={i}>
                        <span className="path">{a.target}</span>
                        {' — '}{a.lockedBy || 'unowned'}
                        {a.until ? ` until ${a.until}` : ''}
                      </li>
                    ))}
                  </ul>
                  <div className="gate-actions">
                    <button
                      className="btn"
                      disabled={busy === ws.task}
                      onClick={() => start(ws.task, true)}
                    >
                      start anyway — recorded in audit
                    </button>
                    <button className="btn quiet" onClick={() => setGate(null)}>
                      cancel
                    </button>
                  </div>
                </div>
              )}

              {runner && openLog === runner.id && <LogDrawer runnerId={runner.id} />}
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
