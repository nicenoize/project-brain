import { useEffect, useState } from 'react';
import { api, copyText } from '../api.js';

/** "Why is this file like this?" — opened from any file in the board.
    Answers from authored records first (module, governing ADRs, findings),
    then the commits themselves. Says plainly when the brain has nothing. */
export default function WhyDrawer({ file, onClose }) {
  const [state, setState] = useState({ loading: true });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    api.why(file)
      .then((why) => { if (alive) setState({ why }); })
      .catch((error) => { if (alive) setState({ error: error.message }); });
    return () => { alive = false; };
  }, [file]);

  const why = state.why;
  const copyAnswer = async () => {
    const text =
      `Why is ${file} like this?\n` +
      (why?.module ? `Module: ${why.module}\n` : '') +
      (why?.decisions || []).map((d) => `Decision — ${d.title}: ${d.excerpt}`).join('\n') +
      '\nRecent history:\n' +
      (why?.history || []).map((h) => `- ${h.dateIso?.slice(0, 10)} ${h.subject}`).join('\n');
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  };

  return (
    <div className="why-drawer">
      <div className="why-head">
        <span className="path">{file}</span>
        <button className="btn quiet" onClick={onClose}>close</button>
      </div>

      {state.loading && <p className="loading">reading the brain…</p>}
      {state.error && <p className="error-note">{state.error}</p>}

      {why && (
        <>
          {why.reason && <p className="empty">{why.reason}</p>}

          {why.module && (
            <p className="why-line">
              <span className="factor-name">module</span>
              <span>{why.module}{why.moduleRecord ? '' : ' (inferred from path — no record)'}</span>
            </p>
          )}

          {(why.decisions || []).map((d) => (
            <div key={d.file} className="why-decision">
              <p className="why-title">{d.title}</p>
              <p className="factor-evidence">{d.excerpt}</p>
            </div>
          ))}

          {(why.history || []).length > 0 && (
            <ul className="feed why-history">
              {why.history.map((h) => (
                <li key={h.hash}>
                  <time dateTime={h.dateIso}>{h.dateIso?.slice(0, 10)}</time>
                  <span className="verb">{h.subject}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="gate-actions">
            <button className="btn quiet" onClick={copyAnswer}>
              {copied ? 'copied' : 'copy answer for your agent'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
