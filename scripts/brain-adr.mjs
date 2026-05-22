/**
 * ADR scaffolder: creates .project-brain/decisions/NNNN-<slug>.md from
 * a title, pre-filled with frontmatter (`module:`, `feature:`, status)
 * so decision-cluster aggregation (chunk:-6) can group it later.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, BRAIN_DIR, ensureDir, exists, read, slugify } from './common.mjs';

const argv = process.argv.slice(2);
const title = argv.join(' ').trim();
if (!title) {
  console.error('Usage: npm run brain:adr -- "Short decision title"');
  console.error('Creates .project-brain/decisions/ADR-NNN-slug.md from the decisions template.');
  process.exit(1);
}

const templateCandidates = [
  path.join('skills', 'project-brain', 'templates', 'brain', 'decisions', '_template.md'),
  path.join('templates', 'brain', 'decisions', '_template.md')
];
const templatePath = templateCandidates.find((p) => fs.existsSync(path.join(ROOT, p)));
if (!templatePath) {
  console.error('Project Brain: could not find templates/brain/decisions/_template.md');
  process.exit(1);
}

const decisionsDir = path.join(BRAIN_DIR, 'decisions');
ensureDir(decisionsDir);

let next = 1;
if (fs.existsSync(decisionsDir)) {
  for (const name of fs.readdirSync(decisionsDir)) {
    const m = /^ADR-(\d+)/i.exec(name);
    if (m) next = Math.max(next, Number(m[1]) + 1);
  }
}

const slug = slugify(title);
const fileName = `ADR-${String(next).padStart(3, '0')}-${slug}.md`;
const dest = path.join(decisionsDir, fileName);
if (exists(dest)) {
  console.error(`Refusing to overwrite existing file: ${path.relative(ROOT, dest)}`);
  process.exit(1);
}

let body = read(path.join(ROOT, templatePath));
body = body.replace(/^# Decision: NAME/m, `# Decision: ${title}`);
body = body.replace(/^date: Needs Review/m, `date: ${new Date().toISOString().slice(0, 10)}`);

fs.writeFileSync(dest, body, 'utf8');
console.log(`Wrote ${path.relative(ROOT, dest)}`);
console.log('Next: fill Context / Decision / Consequences, link from modules or features, keep context_index high-level.');
