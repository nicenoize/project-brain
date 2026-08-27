import { useState } from 'react';
import Treemap from './Treemap.jsx';
import WhyDrawer from './WhyDrawer.jsx';

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
export default function Intel({ hotspots, health, coChange, ownership, leases }) {
  const [whyFile, setWhyFile] = useState('');
  const files = hotspots?.files || [];
  const pairs = coChange?.pairs || [];
  const prefixes = ownership?.prefixes || [];
  const dangerous = health?.files || [];
  const cal = health?.calibration;

  return (
    <>
      {dangerous.length > 0 && (
        <div className="sheet">
          <table className="score-first">
            <thead>
              <tr><th className="num">danger</th><th>File</th><th>Top factor</th></tr>
            </thead>
            <tbody>
              {dangerous.slice(0, 8).map((f) => {
                const top = (f.factors || []).slice().sort((a, b) => b.contribution - a.contribution)[0];
                return (
                  <tr key={f.file}>
                    <td>
                      <span className="num danger-score" data-band={f.score >= 6.5 ? 'high' : f.score >= 3.5 ? 'mid' : 'low'}>
                        {f.score.toFixed(1)}
                      </span>
                      {f.lowConfidence ? <span className="low-conf" title="fewer than 3 commits — treat as a hint, not a score">*</span> : null}
                    </td>
                    <td>
                      <button className="linklike path" onClick={() => setWhyFile(whyFile === f.file ? '' : f.file)}>
                        {f.file}
                      </button>
                    </td>
                    <td className="factor-evidence">
                      {top?.evidence || ''}
                      {(f.plans || []).length > 0 && (
                        <ul className="plan-list">
                          {f.plans.slice(0, 3).map((p) => (
                            <li key={p.move}>
                              <span className="basis-tag inferred">{p.move.replace(/-/g, ' ')}</span>
                              <span>{p.why}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {cal?.auc != null && (
            <p className="claim">
              Receipt: AUC {cal.auc.toFixed(2)} over {cal.files} files of this repo's own
              fix history — {cal.note}.
            </p>
          )}
          {whyFile && <WhyDrawer file={whyFile} onClose={() => setWhyFile('')} />}
          <div className="action-line">
            before touching the top file, score the change:{' '}
            <code>project-brain x intel risk --files {dangerous[0]?.file}</code>
          </div>
          <Provenance data={health} />
        </div>
      )}
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
