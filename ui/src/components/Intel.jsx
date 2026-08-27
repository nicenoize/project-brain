import Treemap from './Treemap.jsx';

function Provenance({ data }) {
  const w = data?.window;
  if (!w) return null;
  return (
    <div className="provenance">
      basis: {data.basis || 'measured'} · source: {data.source || 'git-log'} ·
      window: {w.commits} commits{w.since ? ` since ${String(w.since).slice(0, 10)}` : ''}
    </div>
  );
}

/** Git-intel bay: hotspot treemap + tables. Fills the board on day one
    (empty-state rule) and shares its space with the lease board — a leased
    treemap cell scrolls to the lease row (map = list raise). */
export default function Intel({ hotspots, coChange, ownership, leases }) {
  const files = hotspots?.files || [];
  const pairs = coChange?.pairs || [];
  const prefixes = ownership?.prefixes || [];

  return (
    <>
      <div className="sheet">
        <h2 style={{ font: '700 12px var(--font-ui)', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--ink-2)', marginBottom: 8 }}>
          Hotspots — churn × recency
        </h2>
        {files.length ? (
          <>
            <Treemap files={files} leases={leases} />
            <Provenance data={hotspots} />
          </>
        ) : (
          <p className="empty">No git history yet — the map fills with the first commits.</p>
        )}
      </div>

      {pairs.length > 0 && (
        <div className="sheet">
          <table>
            <thead>
              <tr><th>Usually change together</th><th className="num">conf.</th><th className="num">×</th></tr>
            </thead>
            <tbody>
              {pairs.slice(0, 8).map((p) => (
                <tr key={`${p.a}|${p.b}`}>
                  <td className="path">{p.a} → {p.b}</td>
                  <td className="num">{Math.round(p.confidence * 100)}%</td>
                  <td className="num">{p.together}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="action-line">
            touching one without its partner is the top risk factor — check with{' '}
            <code>project-brain x intel risk --files …</code>
          </div>
          <Provenance data={coChange} />
        </div>
      )}

      {prefixes.length > 0 && (
        <div className="sheet">
          <table>
            <thead>
              <tr><th>Area</th><th>Top owner</th><th className="num">bus factor</th></tr>
            </thead>
            <tbody>
              {prefixes.slice(0, 6).map((p) => (
                <tr key={p.path}>
                  <td className="path">{p.path}</td>
                  <td>{p.topAuthors?.[0]?.author || '—'} <span className="num">({Math.round((p.topAuthors?.[0]?.share || 0) * 100)}%)</span></td>
                  <td className="num">{p.busFactor}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Provenance data={ownership} />
        </div>
      )}
    </>
  );
}
