import { useState } from 'react';
import { copyText } from '../api.js';

/** "Is this change dangerous?" — deterministic risk over the working-tree
    change set, with the calibration receipt (validated claim) and two
    copy-to-agent bridges: the grill prompt and the packed context. */
export default function RiskPanel({ changed, risk, brief }) {
  const [copied, setCopied] = useState('');
  const files = [...(changed?.staged || []), ...(changed?.unstaged || [])];

  const copy = async (key, text) => {
    if (await copyText(text)) {
      setCopied(key);
      setTimeout(() => setCopied(''), 1400);
    }
  };

  if (!files.length) {
    return (
      <p className="empty">
        Working tree is clean. Stage or edit files and this panel scores the
        change before any agent touches it.
      </p>
    );
  }

  const cal = risk?.calibration;
  const factors = (risk?.factors || []).filter((f) => f.contribution > 0);
  const grillPrompt =
    `Adversarially grill this plan before implementation. Files in play: ${files.join(', ')}. ` +
    `Deterministic risk ${risk?.score ?? '?'}/10 — factors: ` +
    factors.map((f) => `${f.name} (${f.evidence})`).join('; ') +
    '. Challenge blast radius, missing co-change partners, tests, and rollback before any code.';

  return (
    <div>
      <div className="risk-head">
        <span className="risk-score num" data-band={risk?.score >= 6.5 ? 'high' : risk?.score >= 3.5 ? 'mid' : 'low'}>
          {risk?.score != null ? risk.score.toFixed(1) : '—'}
          <small>/10</small>
        </span>
        <div className="risk-files">
          <span className="path">{files.slice(0, 4).join(', ')}{files.length > 4 ? ` +${files.length - 4} more` : ''}</span>
          {cal?.auc != null && (
            <p className="claim">
              Receipt: top risk quartile carried {Math.round((cal.quartiles?.[3]?.defectRate ?? 0) * 100)}%
              defect rate vs {Math.round((cal.quartiles?.[0]?.defectRate ?? 0) * 100)}% in the lowest —
              AUC {cal.auc.toFixed(2)} over {cal.commits} commits of this repo's own history.
            </p>
          )}
        </div>
      </div>

      {factors.length > 0 && (
        <ul className="factor-list">
          {factors.map((f) => (
            <li key={f.name}>
              <span className="factor-name">{f.name}</span>
              <span className="factor-evidence">{f.evidence}</span>
            </li>
          ))}
        </ul>
      )}

      {(brief?.advisories || []).length > 0 && (
        <ul className="factor-list advisories">
          {brief.advisories.slice(0, 4).map((a, i) => (
            <li key={i}>
              <span className="factor-name">{a.kind || 'advisory'}</span>
              <span className="factor-evidence">{a.message}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="gate-actions">
        <button className="btn" onClick={() => copy('grill', grillPrompt)}>
          {copied === 'grill' ? 'copied — paste to your agent' : 'copy grill prompt'}
        </button>
        {brief?.packPreview && (
          <button className="btn quiet" onClick={() => copy('pack', brief.packPreview)}>
            {copied === 'pack' ? 'copied' : 'copy agent context'}
          </button>
        )}
      </div>
    </div>
  );
}
