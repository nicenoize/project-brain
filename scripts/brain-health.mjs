import fs from 'node:fs';
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
  } catch {}
}
if (!ok) process.exit(1);
console.log('Project Brain health check passed.');
