import { useState } from 'react';
import { copyText } from '../api.js';

const gb = (mb) => `${(mb / 1024).toFixed(1)} GB`;
const mbs = (mb) => (mb >= 1024 ? gb(mb) : `${mb} MB`);
function ago(ms) {
  if (!ms) return 'no transcript';
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

/** "Room for another agent, and what can go?" — the machine as the agents see
    it. Idle is judged by the last real message in a session's project, never
    by process age. Read-only: what is yours to stop arrives as a command to
    copy, because the daemon does not kill processes it did not start. */
export default function ResourcesPanel({ resources }) {
  const [copied, setCopied] = useState('');
  const copy = async (key, text) => {
    if (await copyText(text)) {
      setCopied(key);
      setTimeout(() => setCopied(''), 1400);
    }
  };

  if (!resources) return <p className="loading">reading the process table…</p>;
  if (resources.degraded) return <p className="empty">{resources.reason || 'process table not readable here.'}</p>;

  const s = resources.system || {};
  const gate = resources.admission || { ok: true, reasons: [] };
  const idle = resources.sessions.filter((x) => x.verdict === 'idle');
  const idleStacks = resources.stacks.filter((x) => x.verdict === 'idle');
  const sessionMb = resources.sessions.reduce((a, x) => a + x.mb, 0);
  const cmds = [
    ...(resources.idleCmd ? [{ key: 'idle', label: `close ${idle.length} idle session${idle.length === 1 ? '' : 's'} (resume later with claude --resume)`, cmd: resources.idleCmd }] : []),
    ...(resources.orphans > 0 ? [{ key: 'orphans', label: `reap ${resources.orphans} orphaned helper${resources.orphans === 1 ? '' : 's'}`, cmd: 'npm run brain:ps -- --apply --yes' }] : []),
    ...idleStacks.map((st) => ({ key: `stack-${st.project}`, label: `stop idle docker stack ${st.project}`, cmd: st.stopCmd }))
  ];

  return (
    <div>
      <p className="receipt-note">
        <strong className="num">{s.freePct ?? '?'}%</strong> of {s.totalGb} GB free
        {s.pressure && <> · pressure <strong>{s.pressure}</strong></>}
        {s.swapUsedGb != null && <> · swap {s.swapUsedGb.toFixed(1)} / {s.swapTotalGb.toFixed(1)} GB</>}
      </p>
      <p className={gate.ok ? 'receipt-note' : 'error-note'} role={gate.ok ? undefined : 'alert'}>
        {gate.ok ? 'Room for another agent.' : `New agents are held: ${gate.reasons.join('; ')}.`}
      </p>

      <ul className="reason-list">
        <li>
          <strong className="num">{resources.sessions.length}</strong> agent session{resources.sessions.length === 1 ? '' : 's'} · {gb(sessionMb)}
          {idle.length > 0 && <> · <strong>{idle.length} idle</strong> (no message for {resources.idleHours} h)</>}
        </li>
        {resources.sessions.slice(0, 8).map((x) => (
          <li key={x.pid}>
            <span className="path">{x.cwd || '?'}</span> — {x.verdict}, {mbs(x.mb)}, last message {ago(x.lastActivityMs)}
          </li>
        ))}
        {Object.entries(resources.helpers).filter(([, h]) => h.count).map(([k, h]) => (
          <li key={k}>{h.count} {k} process{h.count === 1 ? '' : 'es'} · {mbs(h.mb)} resident</li>
        ))}
        {resources.dockerMb > 0 && (
          <li>docker VM {gb(resources.dockerMb)}{resources.stacks.length > 0 && <> · {resources.stacks.map((st) => `${st.project} (${st.verdict})`).join(', ')}</>}</li>
        )}
      </ul>

      {cmds.length > 0 ? (
        <ul className="reason-list">
          {cmds.map((c) => (
            <li key={c.key}>
              {c.label}:{' '}
              <button className="btn quiet" onClick={() => copy(c.key, c.cmd)} title={c.cmd}>
                {copied === c.key ? 'copied' : 'copy command'}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">Nothing to reclaim — no idle sessions, orphans or idle stacks.</p>
      )}

      {resources.mcp.length > 0 && (
        <ul className="reason-list">
          {resources.mcp.map((f, i) => (
            <li key={i}><span className="path">{f.server}</span> ({f.kind}) — {f.fix}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
