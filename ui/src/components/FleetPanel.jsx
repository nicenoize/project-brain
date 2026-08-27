/** Whole-day phrasing: '9.2d since commit' reads like false precision on a
    glance surface; 'today' / '9d' is the honest resolution here. */
function sinceLabel(days) {
  if (days == null) return null;
  if (days < 1) return 'today';
  return `${Math.round(days)}d since commit`;
}

/** "Which of my repos needs attention right now?" — the multi-repo answer for
    one human running agents across an estate. Attention is never a bare
    number: every point of it is spent by a reason that carries its count.
    A single-repo setup says so plainly instead of faking a fleet. */
export default function FleetPanel({ fleet }) {
  const projects = fleet?.projects || [];

  if (!fleet) return <p className="loading">reading the fleet…</p>;

  if (fleet.degraded) {
    const me = projects[0];
    return (
      <p className="empty">
        Single repo — no fleet to compare against.
        {me ? (
          <> Working tree: {me.dirty.staged + me.dirty.unstaged} changed file(s)
            on <span className="path">{me.branch || 'detached'}</span>
            {me.ahead ? `, ${me.ahead} unpushed` : ''}.</>
        ) : null}
        {' '}Put sibling repos under one fleet root to rank them here.
      </p>
    );
  }

  return (
    <div>
      <table>
        <thead>
          <tr><th className="num">attn</th><th>Repo</th><th>Why it wants you</th></tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.path}>
              <td>
                <span
                  className="num danger-score"
                  data-band={p.attention >= 50 ? 'high' : p.attention >= 20 ? 'mid' : 'low'}
                >
                  {p.attention}
                </span>
              </td>
              <td>
                <span className="path">{p.name}</span>
                {p.isActive && <span className="chip idle here">here</span>}
                <div className="factor-evidence">
                  {p.branch || 'detached'}
                  {p.dirty.staged + p.dirty.unstaged > 0
                    ? ` · ${p.dirty.staged + p.dirty.unstaged} changed`
                    : ''}
                  {sinceLabel(p.staleDays) ? ` · ${sinceLabel(p.staleDays)}` : ''}
                </div>
              </td>
              <td>
                {p.error ? (
                  <span className="factor-evidence error-note">{p.error}</span>
                ) : p.reasons.length ? (
                  <ul className="reason-list">
                    {p.reasons.map((r) => (
                      <li key={r.kind}>
                        <span className={`basis-tag ${r.kind === 'lease-conflict' ? 'stop' : 'inferred'}`}>
                          {r.kind.replace(/-/g, ' ')}
                        </span>
                        <span className="factor-evidence">{r.message}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="factor-evidence quiet-ok">quiet — nothing to do here</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {fleet.truncated && (
        <p className="claim">Showing the first {projects.length} projects of the fleet.</p>
      )}
      <div className="provenance">
        fleet root {fleet.fleetRoot} · {fleet.discovered} project(s) · attention weights are
        reviewable defaults, not a calibrated model
      </div>
    </div>
  );
}
