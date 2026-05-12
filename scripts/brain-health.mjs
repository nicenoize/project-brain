import fs from 'node:fs';
import { exists, read, JSON_INDEX, staleIndexFromRecords } from './common.mjs';

const argv = process.argv.slice(2);
const strictStale = argv.includes('--strict-stale') || process.env.BRAIN_HEALTH_STRICT_STALE === '1';
const jsonOut = argv.includes('--json');

const isCanonicalPackage =
  fs.existsSync('SKILL.md') && fs.existsSync('scripts/brain-index.mjs') && fs.existsSync('templates/PULL_REQUEST_TEMPLATE.md');
const required = isCanonicalPackage
  ? ['SKILL.md', 'scripts/brain-index.mjs', 'scripts/brain-search.mjs', 'package.json']
  : [
      'skills/project-brain/SKILL.md',
      '.project-brain/context_index.md',
      '.project-brain/product_plan.md',
      '.project-brain/repo_context.md',
      '.project-brain/active_state.md',
      'package.json'
    ];

const missing = required.filter((p) => !fs.existsSync(p));
let layoutOk = missing.length === 0;

if (!fs.existsSync('.gitignore') || !fs.readFileSync('.gitignore', 'utf8').includes('.project-brain/vector-db/')) {
  if (!jsonOut) console.error('Missing .project-brain/vector-db/ in .gitignore');
  layoutOk = false;
}

let expiredSessionCount = 0;
let stale = { deleted: [], changed: [] };
let indexParseError = false;

if (exists(JSON_INDEX)) {
  try {
    const index = JSON.parse(read(JSON_INDEX));
    const expired = (index.records || []).filter(
      (r) => String(r.id || '').startsWith('session:') && r.expiresAt && Date.parse(r.expiresAt) < Date.now()
    );
    expiredSessionCount = expired.length;
    if (expiredSessionCount && !jsonOut) {
      console.warn(`Expired Project Brain session records found (${expiredSessionCount}). Run: npm run brain:session -- clean`);
    }
    stale = staleIndexFromRecords(index.records || []);
    if (stale.deleted.length && !jsonOut) {
      console.warn(`Project Brain index references deleted files (${stale.deleted.length}). Run: npm run brain:sync`);
    }
    if (stale.changed.length && !jsonOut) {
      console.warn(`Project Brain index has stale hashes (${stale.changed.length}). Run: npm run brain:sync`);
    }
  } catch {
    indexParseError = true;
    if (!jsonOut) console.warn('Project Brain: could not parse search_index.json for stale checks.');
  }
}

const staleFail = Boolean(strictStale && (stale.deleted.length || stale.changed.length));
const finalOk = layoutOk && !indexParseError && !staleFail;

if (jsonOut) {
  console.log(
    JSON.stringify(
      {
        ok: finalOk,
        missing,
        stale,
        strictStale,
        expiredSessionCount,
        indexParseError
      },
      null,
      2
    )
  );
} else {
  if (staleFail) {
    console.error('Strict stale check failed: run npm run brain:sync (or npm run brain:maintain).');
  } else if (finalOk) {
    console.log('Project Brain health check passed.');
  }
}

process.exit(finalOk ? 0 : 1);
