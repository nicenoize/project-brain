import { useState } from 'react';
import { api } from '../api.js';

// Live lease board: who holds which paths, TTL, conflicts washed red.
// Rows are anchor targets so a treemap cell can land here (map = list).
// Operable: claim a new lease, release one — the board is a control, not a
// readout. A claim that overlaps another actor is gated exactly like the
// runner brief gate: you must acknowledge, and the audit records that you did.

function ttlInfo(until) {
  if (!until) return { label: 'unspecified', cls: '' };
  const t = Date.parse(until);
  if (!Number.isFinite(t)) return { label: until, cls: '' };
  const mins = Math.round((t - Date.now()) / 60000);
  if (mins < 0) return { label: 'expired', cls: 'expired' };
  if (mins < 30) return { label: `${mins} min`, cls: 'expiring' };
  if (mins < 600) return { label: `${Math.round(mins / 60 * 10) / 10} h`, cls: '' };
  return { label: new Date(t).toLocaleDateString(), cls: '' };
}

function ClaimForm({ onDone }) {
  const [form, setForm] = useState({ target: '', task: '', actor: '' });
  const [gate, setGate] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (acknowledged) => {
    setBusy(true); setError('');
    try {
      await api.claimLease({ ...form, acknowledged });
      setForm({ target: '', task: '', actor: form.actor });
      setGate(null);
      onDone?.();
    } catch (err) {
      if (err.status === 409 && err.data?.conflictGate) setGate(err.data.conflicts || []);
      else setError(err.data?.reason || err.data?.hint || err.message);
    } finally {
      setBusy(false);
    }
  };

  const ready = form.target.trim() && form.task.trim() && form.actor.trim();

  return (
    <form className="claim" onSubmit={(e) => { e.preventDefault(); if (ready) submit(false); }}>
      <input
        aria-label="Path or glob to claim" placeholder="src/auth/**"
        value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })}
      />
      <input
        aria-label="Task" placeholder="task"
        value={form.task} onChange={(e) => setForm({ ...form, task: e.target.value })}
      />
      <input
        aria-label="Actor" placeholder="who"
        value={form.actor} onChange={(e) => setForm({ ...form, actor: e.target.value })}
      />
      <button className="btn" type="submit" disabled={!ready || busy}>
        {busy ? 'claiming…' : 'claim'}
      </button>
      {error && <p className="error-note" role="alert">{error}</p>}
      {gate && (
        <div className="gate">
          <p className="gate-head">Overlaps a live lease held by someone else:</p>
          <ul>
            {gate.map((c, i) => (
              <li key={i}>
                <span className="path">{c.target}</span> — {c.lockedBy}
                {c.until ? ` until ${c.until}` : ''}
              </li>
            ))}
          </ul>
          <div className="gate-actions">
            <button className="btn" type="button" disabled={busy} onClick={() => submit(true)}>
              claim anyway — recorded in audit
            </button>
            <button className="btn quiet" type="button" onClick={() => setGate(null)}>cancel</button>
          </div>
        </div>
      )}
    </form>
  );
}

export default function LeaseBoard({ leases, conflictTargets, onChanged }) {
  const [busy, setBusy] = useState('');

  const release = async (lease) => {
    setBusy(lease.target);
    try {
      await api.releaseLease({ target: lease.target, actor: lease.lockedBy });
      onChanged?.();
    } finally {
      setBusy('');
    }
  };

  return (
    <div>
      {leases.length === 0 ? (
        <p className="empty">
          No active leases. Claim files before an agent touches them — the claim
          below is the same one <code>brain:lease add</code> writes.
        </p>
      ) : (
        <table>
          <thead>
            <tr><th>Target</th><th>Held by</th><th>TTL</th><th /></tr>
          </thead>
          <tbody>
            {leases.map((l, i) => {
              const ttl = ttlInfo(l.until);
              const conflict = conflictTargets.has(l.target);
              return (
                <tr
                  key={`${l.target}-${i}`}
                  id={`lease-${encodeURIComponent(l.target)}`}
                  className={`row-target lease-row${conflict ? ' conflict' : ''}`}
                >
                  <td className="path">{l.target}</td>
                  <td>{l.lockedBy || 'unowned'}</td>
                  <td data-label="ttl"><span className={`ttl ${ttl.cls}`}>{ttl.label}</span></td>
                  <td>
                    <button
                      className="btn quiet"
                      disabled={busy === l.target}
                      onClick={() => release(l)}
                    >
                      {busy === l.target ? '…' : 'release'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <ClaimForm onDone={onChanged} />
    </div>
  );
}
