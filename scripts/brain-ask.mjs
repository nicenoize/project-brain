/**
 * Top-level query router for agents.
 *
 * Classifies the question (architectural vs code-symbol vs free-form),
 * picks the right brain:search / brain:pack mode, and prints the answer
 * (or the packed context) in one shot so an agent doesn't have to chain
 * commands manually.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, BRAIN_DIR, read, isFastMode } from './common.mjs';
import { looksArchitecturalQuery } from './retrieval.mjs';

const argv = process.argv.slice(2);

const flags = new Set();
let maxTokens = '';
let scope = '';
let topK = '';
let brainTask = '';
let brainActor = '';
const positional = [];

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--explain' || a === '--json' || a === '--pack' || a === '--no-pack' || a === '--force-vector') {
    flags.add(a);
  } else if (a === '--max-tokens') {
    maxTokens = argv[++i] || '';
  } else if (a === '--scope') {
    scope = argv[++i] || '';
  } else if (a === '--top-k') {
    topK = argv[++i] || '';
  } else if (a === '--task') {
    brainTask = argv[++i] || '';
  } else if (a === '--actor') {
    brainActor = argv[++i] || '';
  } else {
    positional.push(a);
  }
}

const query = positional.join(' ').trim();
if (!query) {
  console.error('Usage: npm run brain:ask -- "<query>" [--max-tokens N] [--top-k N] [--scope module] [--task <id>] [--actor <label>] [--pack] [--no-pack] [--force-vector] [--explain] [--json]');
  process.exit(1);
}

const decision = classify(query, { forceVector: flags.has('--force-vector') });

if (flags.has('--explain')) {
  console.log(JSON.stringify({ query, decision, fastMode: isFastMode() }, null, 2));
  process.exit(0);
}

console.log(`brain:ask route=${decision.route}${decision.detail ? ' (' + decision.detail + ')' : ''}${isFastMode() ? ' [fast]' : ''}`);

const childEnv = withBrainCoord(isFastMode() ? { ...process.env, BRAIN_STORE: 'json' } : process.env);
const searchScript = new URL('./brain-search.mjs', import.meta.url).pathname;
const packScript = new URL('./brain-pack.mjs', import.meta.url).pathname;

if (decision.route === 'file') {
  const filePath = path.resolve(ROOT, decision.target);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    console.error(`File not found: ${decision.target}`);
    process.exit(1);
  }
  const body = read(filePath);
  if (flags.has('--json')) console.log(JSON.stringify({ route: 'file', file: decision.target, content: body }, null, 2));
  else console.log(body);
  process.exit(0);
}

if (decision.route === 'symbol') {
  const a = [searchScript, '--type', 'code', '--symbol', decision.target];
  if (flags.has('--json')) a.push('--json');
  if (brainTask) a.push('--task', brainTask);
  if (brainActor) a.push('--actor', brainActor);
  if (topK) { /* search uses BRAIN_TOP_K env */ }
  a.push(decision.target);
  const result = spawnSync(process.execPath, a, {
    stdio: 'inherit',
    env: withTopK(childEnv)
  });
  process.exit(result.status || 0);
}

if (decision.route === 'doc') {
  const a = [searchScript, '--summary-only'];
  if (flags.has('--json')) a.push('--json');
  if (brainTask) a.push('--task', brainTask);
  if (brainActor) a.push('--actor', brainActor);
  a.push(query);
  const result = spawnSync(process.execPath, a, {
    stdio: 'inherit',
    env: withTopK(childEnv)
  });
  process.exit(result.status || 0);
}

if (decision.route === 'module') {
  const a = [searchScript, '--modules-only'];
  if (flags.has('--json')) a.push('--json');
  if (brainTask) a.push('--task', brainTask);
  if (brainActor) a.push('--actor', brainActor);
  a.push(query);
  const result = spawnSync(process.execPath, a, {
    stdio: 'inherit',
    env: withTopK(childEnv)
  });
  process.exit(result.status || 0);
}

// vector route — pick pack vs search
const tokens = query.split(/\s+/).filter(Boolean).length;
const wantsPack = flags.has('--pack') || (!flags.has('--no-pack') && tokens > 14);

if (wantsPack) {
  const a = [packScript, query];
  if (maxTokens) a.push('--max-tokens', maxTokens);
  if (flags.has('--json')) a.push('--format', 'json');
  if (brainTask) a.push('--task', brainTask);
  if (brainActor) a.push('--actor', brainActor);
  const result = spawnSync(process.execPath, a, { stdio: 'inherit', env: withTopK(childEnv) });
  process.exit(result.status || 0);
}

const searchArgs = [searchScript];
if (isFastMode()) searchArgs.push('--summary-only');
if (flags.has('--json')) searchArgs.push('--json');
if (brainTask) searchArgs.push('--task', brainTask);
if (brainActor) searchArgs.push('--actor', brainActor);
searchArgs.push(query);
const result = spawnSync(process.execPath, searchArgs, {
  stdio: 'inherit',
  env: withTopK(childEnv)
});
process.exit(result.status || 0);

function withBrainCoord(env) {
  const out = { ...env };
  if (brainTask) out.BRAIN_TASK = brainTask;
  if (brainActor) out.BRAIN_ACTOR = brainActor;
  return out;
}

function withTopK(env) {
  return topK ? { ...env, BRAIN_TOP_K: topK } : env;
}

function classify(q, opts = {}) {
  const cleaned = q.trim();
  if (opts.forceVector) return { route: 'vector', detail: 'forced' };

  // 1. Single token that resolves to an existing file → file route
  const tokens = cleaned.split(/\s+/);
  if (tokens.length === 1) {
    const candidate = tokens[0];
    if (resolvesToFile(candidate)) {
      return { route: 'file', target: candidate, detail: candidate };
    }
    // 1b. Path-shaped string (slash + extension) even if file missing → still route to file (caller will see the not-found error)
    if (looksLikePath(candidate)) {
      return { route: 'file', target: candidate, detail: candidate };
    }
  }

  // 2. Single identifier-like token (CamelCase, snake_case)
  if (tokens.length === 1 && isSymbolLike(tokens[0])) {
    return { route: 'symbol', target: tokens[0], detail: tokens[0] };
  }

  // 3. Question or doc-style query (aligned with retrieval architectural heuristics)
  if (looksArchitecturalQuery(cleaned)) {
    return { route: 'doc', detail: 'summary-only' };
  }

  // 4. Module-style query
  const modules = listModules();
  for (const m of modules) {
    if (cleaned.toLowerCase().includes(m.toLowerCase())) {
      return { route: 'module', target: m, detail: m };
    }
  }

  // 5. Default to vector hybrid
  return { route: 'vector', detail: tokens.length > 12 ? 'pack' : 'search' };
}

function resolvesToFile(candidate) {
  if (!candidate) return false;
  try {
    const resolved = path.resolve(ROOT, candidate);
    if (!resolved.startsWith(ROOT)) return false;
    return fs.existsSync(resolved) && fs.statSync(resolved).isFile();
  } catch { return false; }
}

function looksLikePath(s) {
  if (!s) return false;
  if (/[\\\/]/.test(s) && /\.[a-z0-9]{1,6}$/i.test(s)) return true;
  return false;
}

function isSymbolLike(t) {
  if (!t) return false;
  if (!/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(t)) return false;
  // Must contain CamelCase capitals or underscores; bare lowercase words go to vector route.
  return /[A-Z]/.test(t) || /_/.test(t);
}

function listModules() {
  const out = [];
  const dir = path.join(BRAIN_DIR, 'modules');
  if (!fs.existsSync(dir)) return out;
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith('.md')) out.push(file.replace(/\.md$/, ''));
  }
  return out;
}
