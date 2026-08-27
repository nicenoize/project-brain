import { useState } from 'react';
import { api } from '../api.js';

/** "Why is it built this way?" — the authored brain records, navigable, with
    the one derived signal that matters: has the code moved on since the doc
    was written? We do not generate documentation from code; we show what
    humans and agents wrote, and we say plainly where it is missing or stale. */
export default function MapPanel({ map, records }) {
  const [open, setOpen] = useState(null);   // {file, doc} | {file, loading}
  const modules = map?.modules || [];
  const counts = map?.counts || {};
  const orphans = map?.orphans?.codeDirs || [];

  const openDoc = async (file) => {
    if (open?.file === file) return setOpen(null);
    setOpen({ file, loading: true });
    try {
      const doc = await api.doc(file);
      setOpen({ file, doc });
    } catch (err) {
      setOpen({ file, error: err.message });
    }
  };

  if (!modules.length) {
    return (
      <div>
        <p className="empty">
          No module records yet — the map is written, not mined.{' '}
          <code>npm run brain:init</code> scaffolds them.
        </p>
        {(records?.records || []).length > 0 && (
          <p className="claim">{records.records.length} decision record(s) exist without a module map.</p>
        )}
      </div>
    );
  }

  return (
    <div>
      <table>
        <thead>
          <tr><th>Module</th><th>Records</th><th>Doc vs code</th></tr>
        </thead>
        <tbody>
          {modules.map((m) => (
            <tr key={m.file} className={open?.file === m.file ? 'row-target flash' : undefined}>
              <td>
                <button className="linklike" onClick={() => openDoc(m.file)}>
                  {m.title || m.name}
                </button>
                {m.summary && <div className="factor-evidence">{m.summary.slice(0, 110)}…</div>}
              </td>
              <td className="num">
                {m.decisionCount}<span className="unit"> adr</span>
                {m.findingCount ? <>{' · '}{m.findingCount}<span className="unit"> find</span></> : null}
              </td>
              <td>
                {m.stale ? (
                  <span className="drift" title={`doc ${m.lastDocChange?.slice(0, 10)} · code ${m.lastCodeChange?.slice(0, 10)}`}>
                    {m.staleReason === 'code-newer-than-doc' ? 'code moved on' : `${Math.round(m.ageDays)}d old`}
                  </span>
                ) : (
                  <span className="chip run">current</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {open && (
        <div className="doc-view">
          {open.loading && <p className="loading">reading {open.file}…</p>}
          {open.error && <p className="error-note">{open.error}</p>}
          {open.doc && (
            <>
              <p className="doc-path num">{open.doc.file}</p>
              <pre className="doc-body">{open.doc.body}</pre>
            </>
          )}
        </div>
      )}

      {orphans.length > 0 && (
        <div className="action-line">
          no record covers <span className="path">{orphans.join(', ')}</span> — write one:{' '}
          <code>npm run brain:adr -- "how {orphans[0]} works"</code>
        </div>
      )}
      <div className="provenance">
        {counts.decisions} decisions · {counts.modules} modules · authored, not generated
      </div>
    </div>
  );
}
