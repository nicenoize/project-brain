// Live lease board: who holds which paths, TTL, conflicts washed red.
// Rows are anchor targets so a treemap cell can land here (map = list).

function ttlInfo(until) {
  if (!until) return { label: 'unspecified', cls: '' };
  const t = Date.parse(until);
  if (!Number.isFinite(t)) return { label: until, cls: '' };
  const mins = Math.round((t - Date.now()) / 60000);
  if (mins < 0) return { label: 'expired', cls: 'expired' };
  if (mins < 30) return { label: `${mins} min`, cls: 'expiring' };
  if (mins < 600) return { label: `${Math.round(mins / 60 * 10) / 10} h`, cls: '' };
  return { label: new Date(t).toLocaleString(), cls: '' };
}

export default function LeaseBoard({ leases, conflictTargets }) {
  if (!leases.length) {
    return (
      <p className="empty">
        No active leases. Claim files before an agent touches them:{' '}
        <code>npm run brain:lease -- add "src/**" --task &lt;slug&gt; --actor &lt;name&gt;</code>
      </p>
    );
  }
  return (
    <table>
      <thead>
        <tr><th>Target</th><th>Held by</th><th>TTL</th></tr>
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
              <td><span className={`ttl ${ttl.cls}`}>{ttl.label}</span></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
