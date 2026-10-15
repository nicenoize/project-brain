import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEtime,
  parsePs,
  classify,
  findOrphans,
  lastRealMessageMs,
  sessionVerdicts,
  renderText,
  descendantPids
} from '../scripts/brain-ps.mjs';

test('parseEtime reads every ps elapsed-time shape', () => {
  assert.equal(parseEtime('06:45'), 405);
  assert.equal(parseEtime('18:09:34'), 18 * 3600 + 9 * 60 + 34);
  assert.equal(parseEtime('14-18:41:44'), 14 * 86400 + 18 * 3600 + 41 * 60 + 44);
  assert.equal(parseEtime('garbage'), 0);
});

test('classify finds agent machinery and ignores everything else', () => {
  assert.equal(classify('/Users/x/.local/bin/claude'), 'agent-session');
  assert.equal(classify('claude'), 'agent-session'); // Superset terminals launch it bare
  assert.equal(classify('claude --resume abc'), 'agent-session');
  assert.equal(classify('npm exec @upstash/context7-mcp@latest'), 'mcp-server');
  assert.equal(classify('node /Users/x/.npm/_npx/9833/node_modules/.bin/playwright-mcp'), 'mcp-server');
  assert.equal(classify('node scripts/brain-mcp.mjs'), 'mcp-server');
  assert.equal(classify('/Users/x/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell --x'), 'headless-browser');
  assert.equal(classify('next-server (v15.2.0)'), 'dev-server');
  assert.equal(classify('/Applications/Docker.app/Contents/MacOS/com.docker.backend'), 'docker');
  assert.equal(classify('/Applications/Claude.app/Contents/MacOS/Claude'), null);
  assert.equal(classify('/Applications/Arc.app/Contents/MacOS/Arc'), null);
  assert.equal(classify('-zsh'), null);
});

const PS = `
    1     0  1000      38-11:41:00 /sbin/launchd
  100     1  5000      10-00:00:00 /Applications/Ghostty.app/Contents/MacOS/ghostty
  200   100  2000      10-00:00:00 -zsh
  300   200 300000     10-00:00:00 /Users/x/.local/bin/claude
  310   300 40000      10-00:00:00 npm exec @upstash/context7-mcp@latest
  311   310 30000      10-00:00:00 node /x/.bin/context7-mcp
  400     1 40000       2-00:00:00 npm exec @playwright/mcp@latest
  401   400 30000       2-00:00:00 node /x/.bin/playwright-mcp
  402   401 90000       2-00:00:00 /x/ms-playwright/chromium_headless_shell-1/chrome-headless-shell
  500   200 60000          33:13 next-server (v15)
  600     1 70000          12:00 next-server (v15)
`;

test('parsePs keeps pid, parent, memory, age and the full command', () => {
  const rows = parsePs(PS);
  assert.equal(rows.length, 11);
  assert.deepEqual(rows[3], { pid: 300, ppid: 200, rssKb: 300000, ageSec: 10 * 86400, command: '/Users/x/.local/bin/claude' });
  assert.equal(rows[9].command, 'next-server (v15)');
});

test('orphans are helpers re-parented to PID 1, with all their descendants', () => {
  const pids = findOrphans(parsePs(PS)).map((r) => r.pid).sort((a, b) => a - b);
  // 400 (npm exec mcp, parent gone) → 401 → 402 ; 600 (next-server under launchd).
  // NOT 310/311 (live claude parent), NOT 500 (dev server in a live shell),
  // NOT 100 (an app launched by launchd is not a helper).
  assert.deepEqual(pids, [400, 401, 402, 600]);
});

test('activity is the last real message — metadata records do not count', () => {
  const records = [
    { type: 'user', timestamp: '2026-10-09T09:00:00Z' },
    { type: 'assistant', timestamp: '2026-10-09T09:01:00Z' },
    { type: 'system', timestamp: '2026-10-12T10:40:00Z' },
    { type: 'queue-operation', timestamp: '2026-10-12T10:40:00Z' }
  ];
  assert.equal(lastRealMessageMs(records), Date.parse('2026-10-09T09:01:00Z'));
  assert.equal(lastRealMessageMs([]), 0);
});

test('sessions are idle only when the project is quiet AND the process is old', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  const H = 3600;
  const activity = new Map([
    ['/quiet', now - 72 * H * 1000],
    ['/busy', now - 60 * 1000]
  ]);
  const v = sessionVerdicts(
    [
      { pid: 1, cwd: '/quiet', ageSec: 300 * H },
      { pid: 2, cwd: '/busy', ageSec: 300 * H }, // 12 days old, but its project spoke a minute ago
      { pid: 3, cwd: '/quiet', ageSec: 1 * H }, // just started in a quiet project
      { pid: 4, cwd: '/nowhere', ageSec: 300 * H }, // no transcript → never called idle
      { pid: 5, cwd: null, ageSec: 300 * H }
    ],
    activity,
    { now, idleMs: 4 * H * 1000 }
  );
  assert.deepEqual(v.map((x) => x.verdict), ['idle', 'active', 'active', 'unknown', 'unknown']);
});

test('the report suggests killing idle sessions but never active ones', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  const text = renderText(
    {
      system: { totalGb: 24, swapUsedGb: 19.4, swapTotalGb: 20, freePct: 26 },
      sessions: [
        { pid: 11, verdict: 'idle', mb: 400, ageSec: 864000, lastActivityMs: now - 3 * 86400_000, cwd: '/a' },
        { pid: 22, verdict: 'active', mb: 900, ageSec: 864000, lastActivityMs: now, cwd: '/b' }
      ],
      helpers: { 'mcp-server': [], 'headless-browser': [], 'dev-server': [] },
      dockerMb: 8090,
      orphans: [],
      idleHours: 4
    },
    { now }
  );
  assert.match(text, /swap 19\.4 \/ 20\.0 GB/);
  assert.match(text, /kill -TERM 11 /);
  assert.doesNotMatch(text, /kill -TERM[^\n]*\b22\b/);
  assert.match(text, /docker: 7\.9 GB/);
});

test('descendantPids walks the whole tree below a pid, and nothing beside it', () => {
  const rows = parsePs(PS);
  assert.deepEqual(descendantPids(rows, 300).sort((a, b) => a - b), [310, 311]);
  assert.deepEqual(descendantPids(rows, 400).sort((a, b) => a - b), [401, 402]);
  assert.deepEqual(descendantPids(rows, 311), []);
});

import { resourceConfig, RESOURCE_DEFAULTS, parseDockerPs, stackOwner, admission, mcpAudit, hookLine } from '../scripts/brain-ps.mjs';

test('resource config: repo overrides win, junk falls back to defaults', () => {
  assert.deepEqual(resourceConfig({}), { ...RESOURCE_DEFAULTS });
  const c = resourceConfig({ resources: { maxConcurrentAgents: 3, minFreePct: 'x', stackIdleHours: -1 } });
  assert.equal(c.maxConcurrentAgents, 3);
  assert.equal(c.minFreePct, RESOURCE_DEFAULTS.minFreePct);
  assert.equal(c.stackIdleHours, RESOURCE_DEFAULTS.stackIdleHours);
});

test('docker stacks group by compose project; loose containers stand alone', () => {
  const st = parseDockerPs('p1|/w/a|c1\np1||c2\n||solo\n');
  assert.deepEqual(st.map((x) => [x.project, x.compose, x.workdir, x.containers.length]), [['p1', true, '/w/a', 2], ['solo', false, null, 1]]);
});

test('a stack belongs to the project whose real path or scratchpad holds its workdir', () => {
  const projects = [
    { slug: '-Users-a-Coding-club-ops', cwd: '/Users/a/Coding/club-ops' },
    { slug: '-Users-a-Coding-club', cwd: '/Users/a/Coding/club' },
    { slug: '-Users-a-gone', cwd: null }
  ];
  assert.equal(stackOwner('/Users/a/Coding/club-ops/supabase', projects), '-Users-a-Coding-club-ops');
  assert.equal(stackOwner('/Users/a/Coding/club/api', projects), '-Users-a-Coding-club');
  assert.equal(stackOwner('/private/tmp/claude-501/-Users-a-Coding-club-ops/e43/scratch', projects), '-Users-a-Coding-club-ops');
  assert.equal(stackOwner('/Users/a/Coding/club-ops2', projects), null, 'a name that merely starts alike is not ownership');
  assert.equal(stackOwner(null, projects), null);
});

test('admission: pressure, free share and concurrency hold new agents — swap does not', () => {
  const sessions = (n) => Array.from({ length: n }, (_, i) => ({ pid: i + 10, verdict: i === 0 ? 'idle' : 'active' }));
  const calm = { pressure: 'normal', freePct: 30, swapUsedGb: 18.5, swapTotalGb: 20 };
  assert.equal(admission({ system: calm, sessions: sessions(2) }).ok, true, 'swap 92 % full alone is not pressure on macOS');
  const warn = admission({ system: { ...calm, pressure: 'warn' }, sessions: sessions(2) });
  assert.equal(warn.ok, false);
  assert.match(warn.reasons[0], /pressure is warn/);
  assert.match(warn.suggest[0], /kill -TERM 10/);
  assert.match(admission({ system: { ...calm, freePct: 5 }, sessions: [] }).reasons[0], /only 5% memory free/);
  assert.match(admission({ system: calm, sessions: sessions(6) }).reasons[0], /6 agent sessions running/);
  assert.equal(hookLine({ system: calm, sessions: sessions(6) }), '', 'the hook counts no session it would start');
  assert.match(hookLine({ system: { ...calm, pressure: 'critical' }, sessions: [] }), /^brain: memory pressure is critical/);
});

test('MCP audit flags floating npx servers and browser servers in every session', () => {
  const f = mcpAudit([
    { name: 'playwright', scope: 'user', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    { name: 'context7', scope: 'project', command: 'npx', args: ['-y', '@upstash/context7-mcp@1.2.3'] },
    { name: 'pinned', scope: 'user', command: '/usr/local/bin/context7-mcp', args: [] },
    { name: 'chrome-devtools', scope: 'project', command: 'npx', args: ['chrome-devtools-mcp@latest'] }
  ]);
  assert.deepEqual(f.map((x) => `${x.server}:${x.kind}`), ['playwright:unpinned', 'playwright:heavy-global', 'chrome-devtools:unpinned']);
});

import { resourcesView } from '../scripts/serve/resources.mjs';

test('the Control Room view keeps what the panel needs and offers commands, never actions', () => {
  const v = resourcesView({
    system: { totalGb: 24, freePct: 24, pressure: 'warn' },
    sessions: [{ pid: 7, verdict: 'idle', mb: 401.6, ageSec: 9, lastActivityMs: 1, cwd: '/x' }, { pid: 8, verdict: 'active', mb: 10, ageSec: 1, lastActivityMs: 2, cwd: '/y' }],
    helpers: { 'mcp-server': [{ rssKb: 2048 }], 'dev-server': [] },
    dockerMb: 8290.4,
    stacks: [{ project: 'p', containers: ['a', 'b'], verdict: 'idle', stopCmd: 'docker stop $(…)' }],
    runners: [],
    orphans: [{ pid: 1 }],
    mcp: [],
    admission: { ok: false, reasons: ['memory pressure is warn'], suggest: [] },
    idleHours: 4
  });
  assert.equal(v.idleCmd, 'kill -TERM 7');
  assert.equal(v.sessions[0].mb, 402);
  assert.deepEqual(v.helpers['mcp-server'], { count: 1, mb: 2 });
  assert.deepEqual(v.stacks[0], { project: 'p', containers: 2, verdict: 'idle', stopCmd: 'docker stop $(…)' });
  assert.equal(v.orphans, 1);
});

test('memoryPressure: the kernel verdict or null, never anything else', async () => {
  const { memoryPressure, PRESSURE_LEVELS } = await import('../scripts/procs.mjs');
  const v = memoryPressure();
  assert.ok(v === null || Object.values(PRESSURE_LEVELS).includes(v), `got ${v}`);
  if (process.platform !== 'darwin') assert.equal(v, null);
});
