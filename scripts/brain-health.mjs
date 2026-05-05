import fs from 'node:fs';
import crypto from 'node:crypto';
const isCanonicalPackage = fs.existsSync('SKILL.md') && fs.existsSync('scripts/brain-index.mjs') && fs.existsSync('templates/PULL_REQUEST_TEMPLATE.md');
const required = isCanonicalPackage
  ? ['SKILL.md', 'scripts/brain-index.mjs', 'scripts/brain-search.mjs', 'package.json']
  : [
      'skills/project-brain/SKILL.md', '.project-brain/context_index.md', '.project-brain/product_plan.md',
      '.project-brain/repo_context.md', '.project-brain/active_state.md', 'package.json'
    ];
let ok = true;
for (const p of required) {
  if (!fs.existsSync(p)) { console.error(`Missing: ${p}`); ok = false; }
}
if (!fs.existsSync('.gitignore') || !fs.readFileSync('.gitignore','utf8').includes('.project-brain/vector-db/')) {
  console.error('Missing .project-brain/vector-db/ in .gitignore'); ok = false;
}
if (fs.existsSync('.project-brain/search_index.json')) {
  try {
    const index = JSON.parse(fs.readFileSync('.project-brain/search_index.json', 'utf8'));
    const expired = (index.records || []).filter(r => String(r.id || '').startsWith('session:') && r.expiresAt && Date.parse(r.expiresAt) < Date.now());
    if (expired.length) console.warn(`Expired Project Brain session records found (${expired.length}). Run: npm run brain:session -- clean`);
    const stale = staleRecords(index.records || []);
    if (stale.deleted.length) console.warn(`Project Brain index references deleted files (${stale.deleted.length}). Run: npm run brain:sync`);
    if (stale.changed.length) console.warn(`Project Brain index has stale hashes (${stale.changed.length}). Run: npm run brain:sync`);
  } catch {}
}
if (!ok) process.exit(1);
console.log('Project Brain health check passed.');

function staleRecords(records) {
  const deleted = new Set();
  const changed = new Set();
  const seen = new Set();
  for (const record of records) {
    if (!record.file || record.file.startsWith('.project-brain/project-summary') || record.type?.endsWith('-summary')) continue;
    if (seen.has(record.file)) continue;
    seen.add(record.file);
    if (!fs.existsSync(record.file)) {
      deleted.add(record.file);
      continue;
    }
    if (record.hash) {
      const current = hash(fs.readFileSync(record.file, 'utf8'));
      if (current !== record.hash) changed.add(record.file);
    }
  }
  return { deleted: [...deleted], changed: [...changed] };
}

function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}
