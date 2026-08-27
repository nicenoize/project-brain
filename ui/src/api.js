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

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const err = new Error(data?.error || `${path} → ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  meta: () => get('/api/meta'),
  state: () => get('/api/state'),
  events: (limit = 50) => get(`/api/events?limit=${limit}`),
  hotspots: (limit = 40) => get(`/api/intel/hotspots?limit=${limit}`),
  health: (limit = 10) => get(`/api/intel/health?limit=${limit}`),
  coChange: (limit = 15) => get(`/api/intel/co-change?limit=${limit}`),
  ownership: (limit = 15) => get(`/api/intel/ownership?limit=${limit}`),
  records: (type) => get(`/api/records?type=${type}`),
  runners: () => get('/api/runners'),
  startRunner: (task, acknowledged) => post('/api/runners/start', { task, acknowledged }),
  stopRunner: (id) => post('/api/runners/stop', { id }),
  runnerLog: (id, lines = 120) =>
    get(`/api/runners/log?id=${encodeURIComponent(id)}&lines=${lines}`),
  changed: () => get('/api/changed'),
  risk: (files) => get(files?.length ? `/api/risk?files=${encodeURIComponent(files.join(','))}` : '/api/risk'),
  next: () => get('/api/next'),
  blast: (files) => get(files?.length ? `/api/blast?files=${encodeURIComponent(files.join(','))}` : '/api/blast'),
  brief: (files) => get(files?.length ? `/api/brief?files=${encodeURIComponent(files.join(','))}` : '/api/brief')
};

/** Copy text to the clipboard; resolves true on success. */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch { return false; }
}

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
