// API client for the local daemon (scripts/brain-serve.mjs).
// The per-session token arrives once in the opened URL's hash and is kept in
// sessionStorage so in-app navigation and reloads survive without re-leaking
// it into history.

const stored = sessionStorage.getItem('brain-token');
const fromHash = new URLSearchParams(location.hash.slice(1)).get('token');
if (fromHash) sessionStorage.setItem('brain-token', fromHash);
export const TOKEN = fromHash || stored || '';
if (fromHash) history.replaceState(null, '', location.pathname + location.search);

async function get(path) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) {
    const err = new Error(`${path} → ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export const api = {
  meta: () => get('/api/meta'),
  state: () => get('/api/state'),
  events: (limit = 50) => get(`/api/events?limit=${limit}`),
  hotspots: (limit = 40) => get(`/api/intel/hotspots?limit=${limit}`),
  coChange: (limit = 15) => get(`/api/intel/co-change?limit=${limit}`),
  ownership: (limit = 15) => get(`/api/intel/ownership?limit=${limit}`),
  records: (type) => get(`/api/records?type=${type}`)
};

/** Subscribe to daemon SSE; onChange fires debounced on state-changed.
    `?shot=1` disables the stream so headless screenshot runs can settle. */
export function subscribe(onChange) {
  if (new URLSearchParams(location.search).get('shot')) return () => {};
  const src = new EventSource(`/api/stream?token=${encodeURIComponent(TOKEN)}`);
  let t = null;
  src.onmessage = () => {
    clearTimeout(t);
    t = setTimeout(onChange, 250);
  };
  return () => { clearTimeout(t); src.close(); };
}
