/** "What landed today, and who is working where?" — read out of git, so it is
    never empty and asks nobody to adopt anything. Leases record intent; this
    records fact. A quiet day says which day was not quiet rather than going
    blank, and two people in one area is reported plainly: that is the warning
    the lease board would have given in advance. */
export default function ActivityPanel({ activity }) {
  if (!activity) return <p className="loading">reading the log…</p>;
  if (activity.degraded) {
    return <p className="empty">{activity.reason || 'no git history readable here.'}</p>;
  }

  const today = activity.today || {};
  const people = activity.people || [];
  const collisions = activity.collisions || [];
  const last = activity.lastActiveDay;
  const win = activity.window || {};

  return (
    <div>
      {today.commits > 0 ? (
        <>
          <p className="receipt-note">
            <strong className="num">{today.commits}</strong> commit{today.commits === 1 ? '' : 's'} landed
            today across <strong className="num">{today.files}</strong> file{today.files === 1 ? '' : 's'}
            {today.merges > 0 && <> · {today.merges} merge{today.merges === 1 ? '' : 's'} (no files of their own)</>}
          </p>
          <ul className="reason-list">
            {today.authors.map((a) => (
              <li key={a.author}>
                <span className="basis-tag measured">{a.commits}</span>
                <span className="path">{a.author}</span>
                <span className="factor-evidence">
                  {a.areas.length ? a.areas.join(' · ') : 'no directory touched — top-level files only'}
                </span>
              </li>
            ))}
          </ul>
          <ul className="factor-list">
            {(today.subjects || []).map((s) => (
              <li key={s.hash}>
                <span className="factor-name">{s.hash}</span>
                <span className="factor-evidence">{s.subject}</span>
              </li>
            ))}
          </ul>
        </>
      ) : last ? (
        <p className="empty">
          Nothing landed today. The last day with work was <strong>{last.date}</strong>
          {' '}({last.daysAgo === 1 ? 'yesterday' : `${last.daysAgo} days ago`}) —
          {' '}{last.commits} commit{last.commits === 1 ? '' : 's'} by {last.authors.join(', ')}.
        </p>
      ) : (
        <p className="empty">
          No commits in the last {win.commits === 0 ? `${win.days} days` : 'window'} —
          this is a quiet repo, not a broken panel.
        </p>
      )}

      <div className="sec-secrets">
        <span className="k">who is working where — last {win.days} days</span>
        {people.length === 0 ? (
          <p className="quiet-ok">Nobody has committed in this window.</p>
        ) : (
          <ul className="reason-list">
            {people.map((p) => (
              <li key={p.author}>
                <span className="basis-tag idle">{p.hoursAgo < 24 ? `${Math.round(p.hoursAgo)}h` : `${Math.round(p.hoursAgo / 24)}d`}</span>
                <span className="path">{p.author}</span>
                <span className="factor-evidence">
                  {p.commits} commit{p.commits === 1 ? '' : 's'} —
                  {' '}{p.areas.map((a) => `${a.area} (${a.commits})`).join(', ') || 'top-level files only'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {collisions.length > 0 && (
        <div className="sec-secrets">
          <span className="k spaced">two or more people in the same area</span>
          <ul className="reason-list">
            {collisions.map((c) => (
              <li key={c.area}>
                <span className="basis-tag inferred">{c.authors.length}</span>
                <span className="path">{c.area}</span>
                <span className="factor-evidence">
                  {c.authors.map((a) => `${a.author} (${a.commits})`).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
          <p className="factor-evidence">
            Shared ground is not a conflict — it is where one would happen. This is the past,
            read from commits; a lease says it before the edit instead of after.
          </p>
        </div>
      )}

      <div className="provenance">
        {activity.provenance?.source} · {activity.provenance?.scanned} commit(s) scanned
        {activity.provenance?.truncated && ' · window truncated'}
      </div>
    </div>
  );
}
