import { motion } from 'motion/react';

// Andon lamp state for a workstream row.
function laneState(ws, conflictsByTask) {
  const status = (ws.status || '').toLowerCase();
  if (conflictsByTask.has(ws.task)) return 'stop';
  if (status.includes('block') || status.includes('stuck')) return 'stop';
  if (status.includes('review') || status.includes('wait')) return 'attn';
  if (status.includes('active') || status.includes('progress') || status.includes('running')) return 'run';
  return 'idle';
}

const WASH = { run: 'wash-run', attn: 'wash-attn', stop: 'wash-stop', idle: '' };

/** The kamishibai board: one rail row per workstream, lamp at the card head.
    A state change washes the whole row (cyclorama raise), a conflict lifts
    the card — the one authored motion moment. */
export default function Board({ workstreams, conflictsByTask }) {
  if (!workstreams.length) {
    return (
      <p className="empty">
        No work in flight. Start one with{' '}
        <code>npm run brain:work -- start --task &lt;slug&gt;</code> — the card
        appears here with its lamp.
      </p>
    );
  }
  return (
    <div>
      {workstreams.map((ws) => {
        const state = laneState(ws, conflictsByTask);
        return (
          <motion.div
            key={ws.task || ws.branch}
            layout
            className={`rail-row ${WASH[state]}`}
            animate={state === 'stop' ? { y: -2 } : { y: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
          >
            <span className={`lamp ${state}`} aria-hidden="true" />
            <div className="tcard">
              <div className="head">
                <span className="task">{ws.task || ws.branch || 'untitled'}</span>
                <span className={`chip ${state === 'idle' ? 'idle' : state}`}>
                  {conflictsByTask.has(ws.task) ? 'lease conflict' : (ws.status || 'idle')}
                </span>
              </div>
              <div className="meta">
                <span className="actor">{ws.owner || 'unassigned'}</span>
                {ws.tool ? ` · ${ws.tool}` : ''}
                {ws.branch ? ` · ${ws.branch}` : ''}
                {ws.project ? ` · ${ws.project}` : ''}
              </div>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
