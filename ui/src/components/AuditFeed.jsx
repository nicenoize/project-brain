// Append-only audit feed from events.jsonl — nothing disappears here.

export default function AuditFeed({ events }) {
  if (!events.length) {
    return (
      <p className="empty">
        No events yet. Leases, workstreams and briefs append here as they
        happen — the trail is the audit.
      </p>
    );
  }
  return (
    <ul className="feed">
      {events.slice().reverse().slice(0, 30).map((e, i) => (
        <li key={`${e.ts || i}-${i}`}>
          <time dateTime={e.ts}>{e.ts ? new Date(e.ts).toLocaleTimeString() : '—'}</time>
          <span className="verb">{e.verb || e.type || 'event'}</span>
          <span style={{ color: 'var(--ink-2)', fontSize: 12, overflowWrap: 'anywhere' }}>
            {e.actor ? `${e.actor} · ` : ''}{e.target || e.task || ''}
          </span>
        </li>
      ))}
    </ul>
  );
}
