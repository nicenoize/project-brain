/**
 * skillspector integration — the trust axis (decisions/0016-ecosystem-skill-axis-map.md).
 *
 * skillspector (github.com/NVIDIA/skillspector) is a security scanner for agent
 * skills (Python/LangGraph/YARA). It is NOT an npm package and we NEVER vendor it
 * or add a Python toolchain — that would violate the brain's Node-only / 2-dep
 * ethos. Instead we shell out to it IF the developer has it (native CLI or Docker),
 * and degrade to a clear no-op skip if absent — exactly like brain-guard.mjs treats
 * gitleaks/semgrep and brain-prune.mjs treats caveman.
 *
 * Pure helpers (detect/parse/severityToScore) are exported for unit tests; the
 * happy path (a real scan) needs the external tool and is not exercised in CI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { ROOT, BRAIN_DIR, ensureDir, exists, read, write, sha256 } from './common.mjs';

export const CACHE_DIR = path.join(BRAIN_DIR, '.skill-audit-cache');
const TTL_HOURS = Number(process.env.BRAIN_SKILL_AUDIT_TTL_HOURS || 720); // 30 days

function hasBin(name) {
  try { execSync(`command -v ${name}`, { stdio: 'ignore' }); return true; } catch { return false; }
}

/**
 * Three-tier detection: native CLI (or BRAIN_SKILLSPECTOR_BIN) → Docker (opt-in,
 * no local Python needed) → null. Returns the invocation descriptor or null.
 */
export function detectSkillspector(env = process.env) {
  if (env.BRAIN_SKILLSPECTOR_BIN) return { mode: 'cli', bin: env.BRAIN_SKILLSPECTOR_BIN };
  if (hasBin('skillspector')) return { mode: 'cli', bin: 'skillspector' };
  if (env.BRAIN_SKILLSPECTOR_DOCKER === '1' && hasBin('docker')) {
    return { mode: 'docker', image: env.BRAIN_SKILLSPECTOR_IMAGE || 'ghcr.io/nvidia/skillspector:latest' };
  }
  return null;
}

export function severityToScore(severity) {
  return { LOW: 15, MEDIUM: 45, HIGH: 75, CRITICAL: 95 }[String(severity).toUpperCase()] ?? null;
}

function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * PURE: extract {score, severity, recommendation, raw} from skillspector output.
 * Defensive — the exact JSON shape isn't pinned, so we try several field names and
 * fall back to scraping a score/severity from text. Always keeps the raw output.
 */
export function parseOutput(stdout = '', stderr = '', status = 0) {
  let score = null;
  let severity = '';
  let recommendation = '';
  try {
    const j = JSON.parse(String(stdout).trim());
    score = numOr(j.risk_score ?? j.score ?? j.risk ?? j.riskScore, null);
    severity = String(j.severity ?? j.level ?? j.risk_level ?? '').toUpperCase();
    recommendation = String(j.recommendation ?? j.advice ?? j.summary ?? '');
  } catch {
    const m = String(stdout).match(/(?:risk[_ ]?score|score)["'\s:]+(\d{1,3})/i);
    if (m) score = Number(m[1]);
    const s = String(stdout).match(/\b(LOW|MEDIUM|HIGH|CRITICAL)\b/);
    if (s) severity = s[1].toUpperCase();
  }
  if (score == null && severity) score = severityToScore(severity);
  if (!severity && score != null) {
    severity = score >= 85 ? 'CRITICAL' : score >= 60 ? 'HIGH' : score >= 30 ? 'MEDIUM' : 'LOW';
  }
  return { score, severity, recommendation, raw: String(stdout || stderr).slice(0, 4000), exit: status };
}

/** Cheap, stable signature of a local skill dir/file for cache keying. */
function targetSignature(target) {
  const root = path.isAbsolute(target) ? target : path.join(ROOT, target);
  if (!exists(root)) return null;
  const st = fs.statSync(root);
  if (st.isFile()) return sha256(read(root));
  const parts = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else parts.push(`${path.relative(root, p)}:${fs.statSync(p).size}`);
    }
  };
  try { walk(root); } catch { return null; }
  return sha256(parts.sort().join('\n'));
}

function readCache(key) {
  const f = path.join(CACHE_DIR, `${key}.json`);
  if (!exists(f)) return null;
  try {
    const entry = JSON.parse(read(f));
    const ageMs = Date.now() - new Date(entry.ts).getTime();
    if (ageMs > TTL_HOURS * 3600 * 1000) return null;
    return entry.result;
  } catch { return null; }
}

function writeCache(key, result) {
  try {
    ensureDir(CACHE_DIR);
    write(path.join(CACHE_DIR, `${key}.json`), JSON.stringify({ ts: new Date().toISOString(), result }, null, 2));
  } catch { /* cache is best-effort */ }
}

/**
 * Scan a local path or a URL. Returns { skipped } | { result, cached? }.
 * Never throws — auditing being unavailable must not break the caller.
 */
export function runSkillspectorScan(target, opts = {}) {
  const tool = detectSkillspector();
  if (!tool) {
    return { skipped: 'skillspector not installed. Install the CLI, set BRAIN_SKILLSPECTOR_BIN, or enable Docker with BRAIN_SKILLSPECTOR_DOCKER=1 (no local Python needed). See docs/vision-constellation.md.' };
  }
  const isUrl = /^https?:\/\//.test(target);
  const sig = isUrl ? target : targetSignature(target);
  if (!isUrl && sig === null) return { skipped: `target not found: ${target}` };
  const cacheKey = sha256(`${tool.mode}:${tool.image || tool.bin}:${sig}`);

  if (!opts.noCache) {
    const cached = readCache(cacheKey);
    if (cached) return { result: cached, cached: true };
  }

  const extra = opts.llm ? ['--llm'] : [];
  let cmd; let argv;
  if (tool.mode === 'docker') {
    cmd = 'docker';
    argv = isUrl
      ? ['run', '--rm', tool.image, 'scan', target, '--json', ...extra]
      : ['run', '--rm', '-v', `${path.resolve(ROOT, target)}:/scan:ro`, tool.image, 'scan', '/scan', '--json', ...extra];
  } else {
    cmd = tool.bin;
    argv = ['scan', target, '--json', ...extra];
  }

  const r = spawnSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.error) return { skipped: `skillspector failed to run (${tool.mode}): ${r.error.message}` };
  const result = parseOutput(r.stdout || '', r.stderr || '', r.status ?? 0);
  if (!opts.noCache) writeCache(cacheKey, result);
  return { result };
}
