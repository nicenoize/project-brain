import fs from 'node:fs';
import path from 'node:path';
import { parseDoc, slugify } from './common.mjs';

/** Parse and remove `--task`, `--actor`, `--tool`, `--parent` from argv. */
export function parseSessionFlags(argv) {
  const flags = { task: '', actor: '', tool: '', parent: '' };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    const next = argv[i + 1];
    const val = next && !next.startsWith('--') ? next : '';
    if (a === '--task') { flags.task = val; argv.splice(i, val ? 2 : 1); continue; }
    if (a === '--actor') { flags.actor = val; argv.splice(i, val ? 2 : 1); continue; }
    if (a === '--tool') { flags.tool = val; argv.splice(i, val ? 2 : 1); continue; }
    if (a === '--parent') { flags.parent = val; argv.splice(i, val ? 2 : 1); continue; }
    i++;
  }
  return flags;
}

export function sessionTimestampSlug() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** New layout: branchSlug__taskSlug__stamp.md ; legacy files: branchSlug-YYYY-MM-DD.md */
export function newSessionFilePath(sessionsDir, branchSlug, taskId, stamp) {
  const t = taskId ? slugify(taskId) : 'default';
  return path.join(sessionsDir, `${branchSlug}__${t}__${stamp}.md`);
}

export function readSessionMeta(filePath, relativeFile) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const doc = parseDoc(relativeFile, raw);
  return {
    taskId: norm(doc.data.task_id || doc.data.taskId),
    actor: norm(doc.data.actor),
    tool: norm(doc.data.tool),
    parentRun: norm(doc.data.parent_run || doc.data.parentRun),
    branch: norm(doc.data.branch)
  };
}

function norm(v) {
  return String(v ?? '').trim();
}

export function listCandidateSessionFiles(sessionsDir, branchSlug) {
  if (!fs.existsSync(sessionsDir)) return [];
  const names = fs.readdirSync(sessionsDir).filter(n => n.endsWith('.md'));
  const paths = [];
  for (const name of names) {
    const full = path.join(sessionsDir, name);
    if (name.startsWith(`${branchSlug}__`) || name.startsWith(`${branchSlug}-`)) paths.push(full);
  }
  return paths.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

export function pickSessionFile(candidates, taskId) {
  if (!candidates.length) return null;
  if (taskId) {
    const taskSlug = slugify(taskId);
    for (const p of candidates) {
      const base = path.basename(p);
      if (base.includes(`__${taskSlug}__`)) return p;
    }
    for (const p of candidates) {
      try {
        const meta = readSessionMeta(p, path.basename(p));
        if (meta.taskId && meta.taskId === taskId) return p;
      } catch { /* ignore */ }
    }
  }
  return candidates[0];
}

export function buildSessionMarkdown({ branch, taskId, actor, tool, parentRun, changedFiles }) {
  const q = v => JSON.stringify(String(v ?? ''));
  const lines = [
    '---',
    'type: session',
    `task_id: ${q(taskId)}`,
    `branch: ${q(branch)}`,
    `actor: ${q(actor)}`,
    `tool: ${q(tool)}`,
    `parent_run: ${q(parentRun)}`,
    '---',
    '',
    '# Session handoff',
    '',
    '## Workstream',
    `- **task_id**: ${taskId || '(none — pass --task <id> when multiple agents or humans share one branch)'}`,
    `- **branch**: ${branch}`,
    `- **actor**: ${actor || '(github handle, agent name, or Cursor sub-agent label)'}`,
    `- **tool**: ${tool || '(cursor|claude|gemini|codex|human|other)'}`,
    `- **parent_run**: ${parentRun || '(orchestrator / parent agent id if applicable)'}`,
    '',
    '## Changed files (at start)',
    ...(changedFiles.length ? changedFiles.map(f => `- ${f}`) : ['- None']),
    '',
    '## Worked on',
    '- Needs Review',
    '',
    '## Notes for the next actor',
    '- Needs Review',
    '',
    '## Next steps',
    '- Needs Review',
    '',
    '## Blockers',
    '- None recorded',
    ''
  ];
  return lines.join('\n');
}
