import { useState } from 'react';
import { copyText } from '../api.js';

/** "What breaks if I change this?" — measured import edges blended with
    inferred co-change edges. Every row carries WHICH kind of evidence backs
    it: a static import is a fact, a history partner is a pattern. Repos
    without TypeScript sources still get the history half — that is the
    normal case, not a failure. */
export default function BlastPanel({ blast }) {
  const [copied, setCopied] = useState(false);
  const nodes = (blast?.nodes || []).filter((n) => n.kind !== 'seed');
  const seeds = blast?.files || [];

  if (blast?.reason === 'no-changes' || !seeds.length) {
    return (
      <p className="empty">
        Nothing staged or modified. Edit a file and this panel names what it
        pulls with it — imports first, history partners second.
      </p>
    );
  }
  if (!nodes.length) {
    // A radius can be empty for two very different reasons, and conflating
    // them wastes the most valuable answer this panel gives: everything that
    // usually travels with these files is ALREADY in the change set.
    const covered = (blast?.edges || []).filter((e) => seeds.includes(e.to));
    if (covered.length) {
      const partners = [...new Set(covered.map((e) => e.to))];
      return (
        <p className="empty covered">
          Nothing forgotten — all {partners.length} file(s) that usually travel
          with this change are already in it ({partners.slice(0, 3).map((p) => p.split('/').pop()).join(', ')}
          {partners.length > 3 ? `, +${partners.length - 3}` : ''}).
        </p>
      );
    }
    return (
      <p className="empty">
        Nothing downstream found for {seeds.join(', ')} — no importers and no
        recurring co-change partners in the window.
      </p>
    );
  }

  const edgeFor = (file) =>
    (blast.edges || []).find((e) => e.to === file) || null;

  const copyList = async () => {
    const text =
      `Changing: ${seeds.join(', ')}\nLikely affected (ranked):\n` +
      nodes.map((n) => {
        const e = edgeFor(n.file);
        return `- ${n.file} (${e?.basis === 'measured' ? 'imports it' : `co-changes ${Math.round((e?.confidence ?? 0) * 100)}%`}, depth ${n.depth})`;
      }).join('\n') +
      '\nCheck each before you finish, or explain why it stays untouched.';
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  };

  return (
    <div>
      <table>
        <thead>
          <tr><th>Likely affected</th><th>Evidence</th><th className="num">depth</th></tr>
        </thead>
        <tbody>
          {nodes.slice(0, 10).map((n) => {
            const e = edgeFor(n.file);
            const measured = e?.basis === 'measured';
            return (
              <tr key={n.file}>
                <td className="path">{n.file}</td>
                <td>
                  <span className={`basis-tag ${measured ? 'measured' : 'inferred'}`}>
                    {measured ? 'measured' : 'inferred'}
                  </span>
                  <span className="factor-evidence">
                    {measured
                      ? 'imports the changed file'
                      : `changes together ${Math.round((e?.confidence ?? 0) * 100)}% of the time`}
                  </span>
                </td>
                <td className="num">{n.depth}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {blast.truncated && (
        <p className="receipt-note">Showing the {nodes.length} highest-ranked of a larger radius.</p>
      )}
      {!blast.graphAvailable && (
        <p className="receipt-note">
          No TypeScript sources indexed here, so these are history-based edges
          only — they still hold in any language, they are patterns rather than facts.
        </p>
      )}

      <div className="gate-actions">
        <button className="btn" onClick={copyList}>
          {copied ? 'copied — paste to your agent' : 'copy affected list'}
        </button>
      </div>
    </div>
  );
}
