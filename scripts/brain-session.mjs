/**
 * Session handoff markdown lifecycle: start/end/list/clean.
 *
 * `start --task --actor --tool` writes a sessions/<branch>-<task>-<ts>.md
 * with frontmatter that retrieval uses for task/actor boosts. `end`
 * marks the file done. `clean` drops expired (BRAIN_SESSION_TTL_HOURS)
 * session files from disk and from the index.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { BRAIN_DIR, ROOT, ensureDir, read, sha256, slugify, write } from './common.mjs';
import { openEmbedder } from './embed.mjs';
import { openStore } from './store.mjs';
import {
  buildSessionMarkdown,
  listCandidateSessionFiles,
  newSessionFilePath,
  parseSessionFlags,
  pickSessionFile,
  readSessionMeta,
  sessionTimestampSlug
} from './session-util.mjs';

const command = process.argv[2] || 'list';
const branch = sh('git rev-parse --abbrev-ref HEAD') || 'unknown';
const branchSlug = slugify(branch);
const sessionsDir = path.join(BRAIN_DIR, 'sessions');
ensureDir(sessionsDir);

const subArgs = process.argv.slice(3);
const flags = command === 'start' || command === 'end' ? parseSessionFlags(subArgs) : { task: '', actor: '', tool: '', parent: '' };

if (command === 'start') await startSession(flags);
else if (command === 'end') await endSession(flags);
else if (command === 'list') await listSessions(subArgs.includes('--json'));
else if (command === 'clean') await cleanSessions({ deleteFiles: subArgs.includes('--files') || process.env.BRAIN_SESSION_CLEAN_FILES === '1' });
else {
  console.error('Usage: npm run brain:session -- start|end|list|clean [--task <id>] [--actor <label>] [--tool cursor|claude|gemini|codex|human|other] [--parent <run-id>]');
  console.error('       npm run brain:session -- list [--json]');
  console.error('       npm run brain:session -- clean [--files]');
  process.exit(1);
}

async function startSession(f) {
  const changedFiles = gitChangedFiles();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlHours() * 60 * 60 * 1000).toISOString();
  const stamp = sessionTimestampSlug();
  const file = newSessionFilePath(sessionsDir, branchSlug, f.task, stamp);
  const body = buildSessionMarkdown({
    branch,
    taskId: f.task,
    actor: f.actor,
    tool: f.tool,
    parentRun: f.parent,
    changedFiles
  });
  write(file, body);
  await upsertSessionRecord(file, changedFiles, expiresAt);
  console.log(`Started Project Brain session: ${path.relative(ROOT, file)}`);
  if (!f.task) console.warn('Tip: pass --task <workstream-id> so parallel Cursor / Claude / Gemini agents can each own a session file.');
}

async function endSession(f) {
  const candidates = listCandidateSessionFiles(sessionsDir, branchSlug);
  const file = pickSessionFile(candidates, f.task);
  if (!file) {
    console.error('No session file found for this branch. Run: npm run brain:session -- start ...');
    process.exit(1);
  }
  const summary = sh('git log --oneline -10');
  const changedFiles = gitChangedFiles();
  write(file, `${read(file).trim()}\n\n## End summary ${new Date().toISOString()}\n\n### Recent commits\n${summary || 'None'}\n\n### Remaining changed files\n${changedFiles.map(x => `- ${x}`).join('\n') || '- None'}\n`);
  await upsertSessionRecord(file, changedFiles, new Date(Date.now() + ttlHours() * 60 * 60 * 1000).toISOString());
  console.log(`Ended Project Brain session: ${path.relative(ROOT, file)}`);
}

async function listSessions(asJson) {
  const store = await openStore();
  const records = (await store.getAll()).filter(record => record.id.startsWith('session:'));
  const sorted = records.sort((a, b) => (a.file || '').localeCompare(b.file || ''));
  if (asJson) {
    console.log(JSON.stringify(sorted.map(r => ({
      file: r.file,
      branch: r.branch,
      expiresAt: r.expiresAt,
      taskId: r.taskId || '',
      actor: r.actor || '',
      tool: r.tool || '',
      parentRun: r.parentRun || ''
    })), null, 2));
  } else {
    for (const record of sorted) {
      const bits = [record.branch || 'unknown', record.file, `expires=${record.expiresAt || 'none'}`];
      if (record.taskId) bits.push(`task=${record.taskId}`);
      if (record.actor) bits.push(`actor=${record.actor}`);
      if (record.tool) bits.push(`tool=${record.tool}`);
      console.log(bits.join(' | '));
    }
  }
  await store.close();
}

async function cleanSessions({ deleteFiles = false } = {}) {
  const store = await openStore();
  const now = Date.now();
  const expired = (await store.getAll()).filter(record => record.id.startsWith('session:') && record.expiresAt && Date.parse(record.expiresAt) < now);
  await store.delete(expired.map(record => record.id));
  let removedFiles = 0;
  if (deleteFiles) {
    for (const record of expired) {
      if (!record.file || !record.file.startsWith('.project-brain/sessions/')) continue;
      const full = path.join(ROOT, record.file);
      if (!fs.existsSync(full)) continue;
      fs.unlinkSync(full);
      removedFiles++;
    }
  }
  console.log(`Removed ${expired.length} expired session records${deleteFiles ? ` and ${removedFiles} files` : ''}.`);
  await store.close();
}

async function upsertSessionRecord(file, changedFiles, expiresAt) {
  const embedder = openEmbedder();
  const store = await openStore({ model: embedder.modelName, dims: embedder.dims });
  const relative = path.relative(ROOT, file);
  const text = read(file);
  const meta = readSessionMeta(file, path.basename(file));
  const stat = fs.statSync(file);
  const vector = await embedder.embed(`${relative}\n${text}`);
  await store.upsert([{
    id: `session:${sha256(relative)}`,
    file: relative,
    chunk: -1,
    title: `Session ${branch}${meta.taskId ? ` · ${meta.taskId}` : ''}`,
    type: 'session',
    heading: branch,
    text,
    embeddingText: `${relative}\n${text}`,
    isSummary: true,
    isModuleSummary: false,
    isProjectSummary: false,
    branch,
    expiresAt,
    changedFiles,
    taskId: meta.taskId || '',
    actor: meta.actor || '',
    tool: meta.tool || '',
    parentRun: meta.parentRun || '',
    provenance: 'human',
    layer: 'session',
    docStatus: 'draft',
    synthetic: false,
    noindex: false,
    mtime: stat.mtime.toISOString(),
    vector
  }]);
  await store.close();
}

function gitChangedFiles() {
  return sh('git status --porcelain').split('\n').filter(Boolean).map(line => line.slice(3).trim());
}

function ttlHours() {
  return Number(process.env.BRAIN_SESSION_TTL_HOURS || 72);
}

function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}
