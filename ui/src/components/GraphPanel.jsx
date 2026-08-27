/** "What's tangled?" — what the import graph knows about the repo's own shape.
    Cycles are facts (a real import loop), orphans are candidates only: a file
    nothing imports may still be a CLI entry, a test, or loaded dynamically.
    Saying which is which is the difference between a finding and an accusation. */
export default function GraphPanel({ graph }) {
  if (!graph) return <p className="loading">scanning imports…</p>;
  if (graph.degraded) {
    return <p className="empty">{graph.reason || 'no scannable sources — the import graph is empty here.'}</p>;
  }

  const cycles = graph.cycles || [];
  const orphans = graph.orphans?.candidates || [];
  const fanIn = graph.fanIn || [];
  const cov = graph.coverage || {};

  return (
    <div>
      <div className="graph-cols">
        <section>
          <span className="k">import cycles</span>
          {cycles.length === 0 ? (
            <p className="quiet-ok">none — the import graph is acyclic</p>
          ) : (
            <ul className="reason-list">
              {cycles.slice(0, 6).map((c, i) => (
                <li key={i}>
                  <span className="basis-tag stop">cycle</span>
                  <span className="path">{c.files.map((f) => f.split('/').pop()).join(' → ')}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <span className="k">most depended on</span>
          <ul className="reason-list">
            {fanIn.slice(0, 6).map((f) => (
              <li key={f.file}>
                <span className="num" style={{ minWidth: '2.4em', display: 'inline-block' }}>{f.count}</span>
                <span className="path">{f.file}</span>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <span className="k">unimported — candidates only</span>
          {orphans.length === 0 ? (
            <p className="quiet-ok">every file is reached from an entry point</p>
          ) : (
            <>
              <ul className="reason-list">
                {orphans.slice(0, 6).map((o) => {
                  const file = typeof o === 'string' ? o : o.file;
                  return <li key={file}><span className="path">{file}</span></li>;
                })}
              </ul>
              <p className="factor-evidence">
                A file nothing imports may still be a CLI entry, a test, or loaded
                dynamically — verify before deleting anything.
              </p>
            </>
          )}
        </section>
      </div>

      <div className="provenance">
        {cov.filesScanned} files scanned · {cov.resolvedEdges} edges resolved ·
        {' '}{cov.unresolvedSpecs} specifiers external or stdlib · static import scan, not a parser
      </div>
    </div>
  );
}
