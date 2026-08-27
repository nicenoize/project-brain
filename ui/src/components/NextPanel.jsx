import { useState } from 'react';
import { copyText } from '../api.js';

/** "What should happen next?" — the brain:route ranking, answer-shaped.
    Every action is copyable; auto-safe actions are visually distinct from
    ones that need a human call. */
export default function NextPanel({ next }) {
  const [copied, setCopied] = useState('');
  const actions = next?.actions || [];
  if (!actions.length) {
    return <p className="empty">Nothing queued — the brain sees no pending work signals.</p>;
  }
  const copy = async (cmd) => {
    if (await copyText(cmd)) {
      setCopied(cmd);
      setTimeout(() => setCopied(''), 1400);
    }
  };
  return (
    <ol className="next-list">
      {actions.map((a) => (
        <li key={a.command}>
          <div className="next-head">
            <code className="path">{a.command}</code>
            <span className={`chip idle ${a.boundary === 'auto' ? '' : 'human'}`}>
              {a.boundary === 'auto' ? 'safe to run' : 'your call'}
            </span>
            <button className="btn quiet" onClick={() => copy(a.command)}>
              {copied === a.command ? 'copied' : 'copy'}
            </button>
          </div>
          <p className="next-reason">{a.reason}</p>
        </li>
      ))}
    </ol>
  );
}
