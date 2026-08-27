/** "What here is actually exploitable?" — advisories ordered by whether our
    own code imports the package, not by severity alone. The loudest severity
    is often not the most urgent problem, and saying which is which is the
    point. A scanner that did not run is reported as not-run, never as clean:
    silence is not a clean bill of health. */
export default function SecurityPanel({ security }) {
  if (!security) return <p className="loading">reading advisories…</p>;

  const vulns = security.vulnerabilities || {};
  const reachable = vulns.reachable || [];
  const transitive = vulns.transitiveOnly || [];
  const secrets = security.secrets || {};
  const tools = security.provenance?.tools || [];

  const sev = (s) => (s === 'critical' || s === 'high' ? 'stop' : s === 'moderate' ? 'attn' : 'idle');

  return (
    <div>
      {vulns.degraded && !reachable.length && !transitive.length ? (
        <p className="empty">{vulns.reason || 'no dependency audit available here.'}</p>
      ) : (
        <>
          {reachable.length > 0 ? (
            <>
              <span className="k">reachable — our code imports these</span>
              <ul className="reason-list">
                {reachable.map((v) => (
                  <li key={v.package}>
                    <span className={`basis-tag ${sev(v.severity)}`}>{v.severity}</span>
                    <span className="path">{v.package}</span>
                    <span className="factor-evidence">
                      {v.why || `imported by ${v.importerCount} file(s)`}
                      {(v.importers || []).length > 0 && ` — ${v.importers.slice(0, 3).join(', ')}`}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="quiet-ok">
              No vulnerable package is imported by any scanned file.
            </p>
          )}

          {transitive.length > 0 && (
            <>
              <span className="k" style={{ marginTop: 12, display: 'block' }}>
                not imported — triage after the reachable ones
              </span>
              <ul className="reason-list">
                {transitive.slice(0, 6).map((v) => (
                  <li key={v.package}>
                    <span className="basis-tag idle">{v.severity}</span>
                    <span className="path">{v.package}</span>
                  </li>
                ))}
              </ul>
              <p className="factor-evidence">
                Not imported is a triage order, not a safety verdict: reachability
                is package-level and blind to dynamic requires and bundler aliases.
              </p>
            </>
          )}
        </>
      )}

      <div className="sec-secrets">
        <span className="k">secrets</span>
        {secrets.degraded ? (
          <p className="factor-evidence not-scanned">{secrets.reason || secrets.statement}</p>
        ) : (secrets.findings || []).length === 0 ? (
          <p className="quiet-ok">gitleaks ran and found nothing.</p>
        ) : (
          <ul className="reason-list">
            {secrets.findings.slice(0, 6).map((f, i) => (
              <li key={i}>
                <span className="basis-tag stop">{f.rule}</span>
                <span className="path">{f.file}:{f.line}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="provenance">
        {tools.map((t) => `${t.name} ${t.ran ? 'ran' : 'ABSENT'}`).join(' · ')}
      </div>
    </div>
  );
}
