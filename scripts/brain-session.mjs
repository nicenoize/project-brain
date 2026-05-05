import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { BRAIN_DIR, ROOT, ensureDir, read, sha256, slugify, write } from './common.mjs';
import { openEmbedder } from './embed.mjs';
import { openStore } from './store.mjs';

const command = process.argv[2] || 'list';
const branch = sh('git rev-parse --abbrev-ref HEAD') || 'unknown';
const sessionsDir = path.join(BRAIN_DIR, 'sessions');
ensureDir(sessionsDir);

if (command === 'start') await startSession();
else if (command === 'end') await endSession();
else if (command === 'list') await listSessions();
else if (command === 'clean') await cleanSessions();
else {
  console.error('Usage: npm run brain:session -- start|end|list|clean');
  process.exit(1);
}

async function startSession() {
  const changedFiles = gitChangedFiles();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlHours() * 60 * 60 * 1000).toISOString();
  const file = sessionFile(now);
  if (!fs.existsSync(file)) {
    write(file, `# Session ${branch} ${now.toISOString()}\n\n## Branch\n${branch}\n\n## Changed Files\n${changedFiles.map(f => `- ${f}`).join('\n') || '- None'}\n\n## Notes\n- Needs Review\n`);
  }
  await upsertSessionRecord(file, changedFiles, expiresAt);
  console.log(`Started Project Brain session: ${path.relative(ROOT, file)}`);
}

async function endSession() {
  const file = latestSessionFile();
  if (!file) {
    console.error('No session file found for this branch. Run: npm run brain:session -- start');
    process.exit(1);
  }
  const summary = sh('git log --oneline -10');
  const changedFiles = gitChangedFiles();
  write(file, `${read(file).trim()}\n\n## End Summary ${new Date().toISOString()}\n\n### Recent Commits\n${summary || 'None'}\n\n### Remaining Changed Files\n${changedFiles.map(f => `- ${f}`).join('\n') || '- None'}\n`);
  await upsertSessionRecord(file, changedFiles, new Date(Date.now() + ttlHours() * 60 * 60 * 1000).toISOString());
  console.log(`Ended Project Brain session: ${path.relative(ROOT, file)}`);
}

async function listSessions() {
  const store = await openStore();
  const records = (await store.getAll()).filter(record => record.id.startsWith('session:'));
  for (const record of records.sort((a, b) => a.file.localeCompare(b.file))) {
    console.log(`${record.branch || 'unknown'} ${record.file} expires=${record.expiresAt || 'none'}`);
  }
  await store.close();
}

async function cleanSessions() {
  const store = await openStore();
  const now = Date.now();
  const expired = (await store.getAll()).filter(record => record.id.startsWith('session:') && record.expiresAt && Date.parse(record.expiresAt) < now);
  await store.delete(expired.map(record => record.id));
  console.log(`Removed ${expired.length} expired session records.`);
  await store.close();
}

async function upsertSessionRecord(file, changedFiles, expiresAt) {
  const embedder = openEmbedder();
  const store = await openStore({ model: embedder.modelName, dims: embedder.dims });
  const relative = path.relative(ROOT, file);
  const text = read(file);
  const vector = await embedder.embed(`${relative}\n${text}`);
  await store.upsert([{
    id: `session:${sha256(relative)}`,
    file: relative,
    chunk: -1,
    title: `Session ${branch}`,
    type: 'session',
    heading: branch,
    text,
    embeddingText: `${relative}\n${text}`,
    isSummary: true,
    isModuleSummary: false,
    branch,
    expiresAt,
    changedFiles,
    vector
  }]);
  await store.close();
}

function sessionFile(date) {
  return path.join(sessionsDir, `${slugify(branch)}-${date.toISOString().slice(0, 10)}.md`);
}

function latestSessionFile() {
  const prefix = `${slugify(branch)}-`;
  return fs.readdirSync(sessionsDir)
    .filter(name => name.startsWith(prefix) && name.endsWith('.md'))
    .sort()
    .map(name => path.join(sessionsDir, name))
    .pop();
}

function gitChangedFiles() {
  return sh('git status --porcelain').split('\n').filter(Boolean).map(line => line.slice(3));
}

function ttlHours() {
  return Number(process.env.BRAIN_SESSION_TTL_HOURS || 72);
}

function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}
