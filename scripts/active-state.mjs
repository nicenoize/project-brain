import fs from 'node:fs';
import path from 'node:path';
import { BRAIN_DIR, ensureDir, exists, read, write } from './common.mjs';

export const ACTIVE_STATE = path.join(BRAIN_DIR, 'active_state.md');
const LOCK_PATH = path.join(BRAIN_DIR, '.active_state.lock');
const STALE_LOCK_MS = Number(process.env.BRAIN_STATE_LOCK_STALE_MS || 60_000);
const LOCK_WAIT_MS = Number(process.env.BRAIN_STATE_LOCK_WAIT_MS || 10_000);
const LOCK_POLL_MS = 50;

export function ensureActiveState() {
  if (exists(ACTIVE_STATE)) return;
  write(ACTIVE_STATE, defaultActiveState());
}

export function readActiveState() {
  ensureActiveState();
  return read(ACTIVE_STATE);
}

/**
 * Run fn under an exclusive lock on `.active_state.lock`. Prevents the
 * read→filter→write race when multiple agents update workstreams/leases.
 * Stale locks (older than STALE_LOCK_MS) are taken over.
 */
export function withStateLock(fn) {
  ensureDir(path.dirname(LOCK_PATH));
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd;
  while (true) {
    try {
      fd = fs.openSync(LOCK_PATH, 'wx');
      const payload = JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() });
      fs.writeSync(fd, payload);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (tryStealStaleLock()) continue;
      if (Date.now() > deadline) throw new Error(`active_state lock contention: ${LOCK_PATH} held > ${LOCK_WAIT_MS}ms`);
      sleepSync(LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(LOCK_PATH); } catch {}
  }
}

function tryStealStaleLock() {
  try {
    const stat = fs.statSync(LOCK_PATH);
    if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
      fs.unlinkSync(LOCK_PATH);
      return true;
    }
  } catch {}
  return false;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function addWorkstream({ taskId, owner = '', tool = '', branch = '', scope = '', status = 'active' }) {
  withStateLock(() => {
    const row = [taskId, owner, tool, branch, scope, status];
    const text = updateTable(readActiveState(), 'Workstreams', ['task_id', 'owner', 'tool', 'branch', 'scope / links', 'status'], row, 0);
    write(ACTIVE_STATE, text);
  });
}

export function endWorkstream(taskId, status = 'done') {
  withStateLock(() => {
    const rows = parseTable(section(readActiveState(), 'Workstreams')).rows;
    const nextRows = rows.map(row => row[0] === taskId ? [...row.slice(0, 5), status] : row);
    write(ACTIVE_STATE, replaceTable(readActiveState(), 'Workstreams', ['task_id', 'owner', 'tool', 'branch', 'scope / links', 'status'], nextRows));
  });
}

export function addLease({ target, lockedBy = '', until = '', notes = '' }) {
  withStateLock(() => {
    const row = [target, lockedBy, until, notes];
    const text = updateTable(readActiveState(), 'File Leases', ['path glob or file', 'locked_by', 'until', 'notes'], row, 0);
    write(ACTIVE_STATE, text);
  });
}

export function releaseLeases({ taskId = '', lockedBy = '', target = '' }) {
  withStateLock(() => {
    const rows = parseTable(section(readActiveState(), 'File Leases')).rows;
    const nextRows = rows.filter(row => {
      if (target && row[0] === target) return false;
      if (lockedBy && row[1] === lockedBy) return false;
      if (taskId && row.join(' ').includes(taskId)) return false;
      return true;
    });
    write(ACTIVE_STATE, replaceTable(readActiveState(), 'File Leases', ['path glob or file', 'locked_by', 'until', 'notes'], nextRows));
  });
}

export function activeStateJson() {
  const text = readActiveState();
  return {
    workstreams: rowsToObjects(parseTable(section(text, 'Workstreams')), ['taskId', 'owner', 'tool', 'branch', 'scope', 'status']),
    leases: rowsToObjects(parseTable(section(text, 'File Leases')), ['target', 'lockedBy', 'until', 'notes']),
    blockers: bullets(section(text, 'Blockers')),
    overlaps: bullets(section(text, 'Overlaps'))
  };
}

function updateTable(text, heading, headers, row, keyIndex) {
  const parsed = parseTable(section(text, heading));
  const filtered = parsed.rows.filter(r => r[keyIndex] && r[keyIndex] !== '_None_' && r[keyIndex] !== row[keyIndex]);
  filtered.push(row);
  return replaceTable(text, heading, headers, filtered);
}

function replaceTable(text, heading, headers, rows) {
  const bodyRows = rows.length ? rows : [headers.map((_, i) => i === 0 ? '_None_' : '')];
  const table = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...bodyRows.map(row => `| ${headers.map((_, i) => escapeCell(row[i] || '')).join(' | ')} |`)
  ].join('\n');
  return replaceSection(text, heading, `\n${table}\n`);
}

function parseTable(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.startsWith('|'));
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = splitRow(lines[0]);
  const rows = lines.slice(2).map(splitRow).filter(row => row.some(Boolean) && row[0] !== '_None_');
  return { headers, rows };
}

function rowsToObjects(table, keys) {
  return table.rows.map(row => Object.fromEntries(keys.map((key, i) => [key, row[i] || ''])));
}

function splitRow(line) {
  return line.replace(/^\||\|$/g, '').split('|').map(cell => cell.trim().replace(/\\\|/g, '|'));
}

function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function section(text, heading) {
  const bounds = sectionBounds(text, heading);
  return bounds ? text.slice(bounds.bodyStart, bounds.end) : '';
}

function replaceSection(text, heading, body) {
  const bounds = sectionBounds(text, heading);
  if (bounds) return `${text.slice(0, bounds.bodyStart)}${body}${text.slice(bounds.end)}`;
  return `${text.trim()}\n\n## ${heading}\n${body}`;
}

function sectionBounds(text, heading) {
  const marker = `## ${heading}`;
  const start = text.split('\n').findIndex(line => line.trim() === marker);
  if (start === -1) return null;
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i <= start; i++) offset += lines[i].length + 1;
  let end = text.length;
  let scanOffset = offset;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      end = scanOffset;
      break;
    }
    scanOffset += lines[i].length + 1;
  }
  return { bodyStart: offset, end };
}

function bullets(text) {
  return text.split('\n').map(line => line.trim()).filter(line => line.startsWith('- ')).map(line => line.slice(2));
}

function defaultActiveState() {
  return `# Active State

## Workstreams

| task_id | owner | tool | branch | scope / links | status |
| --- | --- | --- | --- | --- | --- |
| _None_ | | | | | |

## File Leases

| path glob or file | locked_by | until | notes |
| --- | --- | --- | --- |
| _None_ | | | |

## Blockers

- None recorded

## Overlaps

- None recorded

## Last Sync

- Needs Review
`;
}
