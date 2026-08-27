// Slice-and-dice treemap of hotspot scores. Leased cells carry the red
// outline; clicking a leased cell scrolls to its lease row — the map and the
// table are the same space (doujin raise). Deliberately simple geometry:
// alternating-axis slicing keeps it dependency-free and deterministic.

function layout(items, x, y, w, h, vertical) {
  if (!items.length) return [];
  const total = items.reduce((s, f) => s + f.score, 0) || 1;
  const out = [];
  let offset = 0;
  for (const f of items) {
    const frac = f.score / total;
    if (vertical) {
      const cw = w * frac;
      out.push({ ...f, x: x + offset, y, w: cw, h });
      offset += cw;
    } else {
      const ch = h * frac;
      out.push({ ...f, x, y: y + offset, w, h: ch });
      offset += ch;
    }
  }
  return out;
}

function leaseFor(file, leases) {
  for (const l of leases || []) {
    for (const t of String(l.target || '').split(/[,\s]+/).filter(Boolean)) {
      const base = t.replace(/\/?\*\*?.*$/, '').replace(/\/$/, '');
      if (file === t || (base && (file === base || file.startsWith(base + '/')))) return l;
    }
  }
  return null;
}

/** Recency 0..1 from lastCommit relative to the window (newest = 1). */
function recencyOf(f, files) {
  const times = files.map((x) => Date.parse(x.lastCommit)).filter(Number.isFinite);
  if (!times.length) return 0;
  const min = Math.min(...times), max = Math.max(...times);
  const t = Date.parse(f.lastCommit);
  if (!Number.isFinite(t) || max === min) return 0.5;
  return (t - min) / (max - min);
}

export default function Treemap({ files, leases }) {
  const top = files.slice(0, 12);
  // two-row slice: the biggest 5 as columns, the next 7 below; slivers under
  // 2.5% width are dropped — they read as rendering noise, not information.
  const head = layout(top.slice(0, 5), 0, 0, 100, 62, true);
  const tail = layout(top.slice(5), 0, 62, 100, 38, true);
  const cells = [...head, ...tail].filter((c) => c.w > 2.5);

  return (
    <div className="treemap" role="img" aria-label={`Hotspot map of ${top.length} files`}>
      {cells.map((c) => {
        const lease = leaseFor(c.file, leases);
        const label = c.file.split('/').pop();
        const heat = recencyOf(c, top);
        return (
          <div
            key={c.file}
            className={`cell${lease ? ' leased' : ''}`}
            style={{
              left: `${c.x}%`, top: `${c.y}%`, width: `${c.w}%`, height: `${c.h}%`,
              /* heat = recency as a tonal ink ramp on the rail ground — the
                 panel label promises churn × recency, so the cells encode both
                 (area = churn, tone = recency). Lamp hues stay state-only. */
              background: `color-mix(in srgb, var(--ink) ${Math.round(4 + heat * 16)}%, var(--rail))`
            }}
            title={`${c.file} — churn score ${c.score.toFixed(1)}${lease ? ` · leased by ${lease.lockedBy || 'unowned'}` : ''}`}
            onClick={() => {
              if (!lease) return;
              const row = document.getElementById(`lease-${encodeURIComponent(lease.target)}`);
              if (row) {
                row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                row.classList.add('flash');
                setTimeout(() => row.classList.remove('flash'), 900);
              }
            }}
          >
            {c.w > 6 && c.h > 9
              ? <span style={{ color: 'var(--ink)' }}>{label}</span>
              : null}
          </div>
        );
      })}
    </div>
  );
}
