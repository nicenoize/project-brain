import fs from 'node:fs';
const required = [
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
if (!ok) process.exit(1);
console.log('Project Brain health check passed.');
