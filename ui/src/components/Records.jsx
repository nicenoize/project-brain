// Decisions read in place (hypercard raise: the reading tool is the making
// tool). v1 is read-only — in-place editing lands with the daemon write API;
// until then each record names its file so one keypress opens it in $EDITOR.

export default function Records({ records }) {
  if (!records.length) {
    return (
      <p className="empty">
        No decisions recorded yet. The first one:{' '}
        <code>npm run brain:adr -- "title"</code>
      </p>
    );
  }
  return (
    <div>
      {records.slice(0, 12).map((r) => (
        <details key={r.file} className="record">
          <summary>
            <span>{r.title || r.file}</span>
            <span className="id">{String(r.file || '').split('/').pop()}</span>
          </summary>
          <div className="body">{r.excerpt || `open ${r.file} in your editor — in-place editing arrives with the write API`}</div>
        </details>
      ))}
    </div>
  );
}
