#!/usr/bin/env node
/**
 * leanlamp — the product CLI: nine verbs, the same actions the companion
 * clicks. Everything else lives under `x` (any scripts/brain-*.mjs). The
 * project-brain CLI (bin/cli.mjs) stays as it is until the rename is decided.
 *
 *   leanlamp init [--check|--undo] hook for steer/hold + compaction mark for this repo (--check: working? --undo: put it all back)
 *   leanlamp open [--rebuild]     the companion app (built for this Mac on first use)
 *   leanlamp status               sessions, context, machine, holds — one screen
 *   leanlamp recall <terms>       what the agent dropped: transcript excerpts
 *   leanlamp steer <s> "<note>"   a note the agent reads at its next tool call
 *   leanlamp hold <glob> [--for]  edits under <glob> wait for your answer (--all, release)
 *   leanlamp compact [--at 300k] [--shared]  where this repo's sessions compact, from their next start
                                (personal settings.local.json by default; --shared: the team's settings.json)
 *   leanlamp receipt [--days 14]  what it cost, what the agents got, what the companion did
 *   leanlamp sessions [park|parked|resume]  free the RAM of idle sessions, keep their context
 *   leanlamp x <script> [...]     every other brain command
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const COMPANION = path.join(SCRIPTS, 'brain-companion.mjs');

export const VERBS = Object.freeze([
  ['init', 'hook for steer and hold, compaction mark for this repo (--check, --undo)'],
  ['open', 'the companion: notch island, menu bar, window'],
  ['status', 'sessions, context, machine, holds on one screen'],
  ['recall', 'what the agent dropped: transcript excerpts for <terms>'],
  ['steer', 'a note a running agent reads at its next tool call'],
  ['hold', 'edits under a glob wait for your answer (release, approve, deny)'],
  ['compact', 'where sessions in this repo compact, from their next start'],
  ['receipt', 'what it cost, what the agents got, what the companion did'],
  ['sessions', 'open sessions and their RAM; park the idle ones, keep what they were about']
]);

/** One screen per verb. `leanlamp <verb> --help` prints it and does nothing else. */
export const HELP = Object.freeze({
  init: `leanlamp init [--dry-run]     the companion hook in your Claude settings (every config dir a
                              running session uses) + a 300k compaction mark for this repo
                              (skipped when a mark is already set anywhere)
leanlamp init --check         is it all in place and working? read-only, exit 1 on a ✗
leanlamp init --undo [--dry-run]  put back every settings change leanlamp made`,
  open: `leanlamp open [--rebuild]     the companion app; builds it on first use (about 45 s,
                              Command Line Tools) into ~/.project-brain/app`,
  status: `leanlamp status [--json]      sessions, context against the compaction mark, machine, holds`,
  recall: `leanlamp recall <terms>        transcript excerpts the agent no longer has in context`,
  steer: `leanlamp steer <session> <note…>  a note the agent reads at its next tool call
                              <session>: an id prefix or a word from the title or project`,
  hold: `leanlamp hold <glob> [--for 30m]  edits under <glob> (relative to here; /x = repo root)
                              wait up to 45 s for your answer, then Claude Code asks
leanlamp hold --all           every edit, every repo
leanlamp hold release [<id>|--all]   lift holds
leanlamp hold approve <id>    let a held edit through      leanlamp hold deny <id> [reason]`,
  compact: `leanlamp compact               where this repo's sessions compact, per config dir
leanlamp compact --at 300k [--shared] [--dry-run]
                              set it in .claude/settings.local.json (yours) or, with --shared,
                              .claude/settings.json (the team's); from the next session start`,
  receipt: `leanlamp receipt [--days 14] [--json]  what the last days cost, what the agents got from
                              hooks and acted on, what the companion did`,
  sessions: `leanlamp sessions [--json]     every open Claude Code session: RAM (with its MCP servers),
                              when it last spoke, what it was about
leanlamp sessions park <s>|--idle [--hours 2] [--yes]
                              write a card (first ask, latest asks, where it stood, files),
                              then end the session; busy sessions and this one are never parked
leanlamp sessions parked      the cards, newest first, each with its resume command
leanlamp sessions clean [--yes]  stop what closed sessions left running from their scratchpad
                              (a dev server, python -m http.server); nothing else is touched
leanlamp sessions resume <s> [--open]  print the resume command (--open: in a new Terminal window)
                              <s>: pid, id prefix, or a word from the name or project`,
  x: `leanlamp x                    list every other brain command
leanlamp x <name> [args…]     run one (its own --help works)`
});

export function usage() {
  const w = Math.max(...VERBS.map(([v]) => v.length)) + 2;
  return [
    'leanlamp — less context, same agent',
    '',
    ...VERBS.map(([v, d]) => `  ${v.padEnd(w)}${d}`),
    '',
    `  ${'x'.padEnd(w)}every other brain command: leanlamp x <name> (${listScripts().length} of them)`,
    '',
    'leanlamp <verb> --help for details. Nothing leaves this machine.'
  ].join('\n');
}

export function listScripts() {
  try { return fs.readdirSync(SCRIPTS).filter((f) => /^brain-.+\.mjs$/.test(f)).map((f) => f.slice(6, -4)).sort(); } catch { return []; }
}

function node(script, args, opts = {}) {
  // LEANLAMP_CLI: the engine names leanlamp's commands in its hints and errors, not the npm scripts
  const r = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit', ...opts, env: { ...process.env, LEANLAMP_CLI: '1', ...(opts.env || {}) } });
  return r.status ?? 1;
}

function gitRoot(dir = process.cwd()) {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

/** "300k", "1M", "250000" → tokens. PURE. */
export function parseTokens(s) {
  const m = String(s || '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([km])?$/);
  if (!m) throw new Error(`not a token count: ${s} (try 300k)`);
  return Math.round(Number(m[1]) * (m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1));
}

/** Set CLAUDE_CODE_AUTO_COMPACT_WINDOW in a settings object, additively. PURE. */
export function withCompactionMark(settings, tokens) {
  const s = JSON.parse(JSON.stringify(settings || {}));
  s.env ||= {};
  const before = s.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? null;
  s.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(tokens);
  return { settings: s, before };
}

/**
 * The mark Claude Code will use for a repo (local > project > user > env), per
 * Claude config dir in use: sessions started with another CLAUDE_CONFIG_DIR
 * read another user settings file.
 */
async function effectiveMarks(repo) {
  const { windowsFor } = await import('../scripts/brain-companion.mjs');
  return windowsFor(repo);
}

async function compact(args) {
  const atIdx = args.indexOf('--at');
  const dry = args.includes('--dry-run');
  const shared = args.includes('--shared');
  const { describeWindows } = await import('../scripts/brain-companion.mjs');
  const repo = gitRoot();
  if (!repo) {
    console.error('leanlamp: not in a git repository — run it inside the repo whose sessions should compact at the mark');
    return 2;
  }
  const name = path.basename(repo);
  const before = await effectiveMarks(repo);
  if (atIdx === -1) {
    const unset = before.every((m) => !m.window);
    console.log(`${name} compacts at ${describeWindows(before)}${unset ? '. Set a mark: leanlamp compact --at 300k' : ''}`);
    return 0;
  }
  // A home folder kept in git (dotfiles) makes ~/.claude/settings.json "this repo's" file: that is the user settings of every session.
  if (path.resolve(repo) === path.resolve(os.homedir())) {
    console.error('leanlamp: this repository is your home folder, so its .claude is your user settings for every session — run it inside a project, or set CLAUDE_CODE_AUTO_COMPACT_WINDOW there yourself');
    return 2;
  }
  const tokens = parseTokens(args[atIdx + 1]);
  if (tokens < 50_000) { console.error('leanlamp: below 50k the agent compacts all the time — pick 200k–400k'); return 2; }
  // Personal by default (settings.local.json is yours and not committed); --shared writes the team's settings.json.
  const file = path.join(repo, '.claude', shared ? 'settings.json' : 'settings.local.json');
  let current = {};
  try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') { console.error(`leanlamp: ${file} is not valid JSON — not touched`); return 1; } }
  const r = withCompactionMark(current, tokens);
  const where = file.replace(os.homedir(), '~');
  if (dry) { console.log(`would set CLAUDE_CODE_AUTO_COMPACT_WINDOW=${tokens} in ${where}${r.before ? ` (now ${r.before})` : ''}`); return 0; }
  const { writeConfigFile, recordChange, busDir } = await import('../scripts/companion-bus.mjs');
  const existed = fs.existsSync(file);
  if (existed) backupTo(file, 'compact');
  writeConfigFile(file, JSON.stringify(r.settings, null, 2) + '\n');
  recordChange(busDir(), { kind: 'mark', file, key: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', before: r.before, after: String(tokens), created: !existed || undefined });
  const after = await effectiveMarks(repo);
  const losing = after.filter((m) => !m.window || m.window.limit !== tokens);
  if (losing.length) {
    console.log(`wrote ${Math.round(tokens / 1000)}k to ${where}, but ${describeWindows(losing)} wins — change it there, or use ${shared ? 'without --shared' : '--shared'}`);
    return 1;
  }
  console.log(`${name} now compacts at ${Math.round(tokens / 1000)}k — sessions started from now on (${where}; backup in ${pretty(backupDir())}; undo: leanlamp init --undo)`);
  return 0;
}

const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return '0'; } })();

/** Where `leanlamp open` builds the app when this install has none: BRAIN_HOME/app (default ~/.project-brain/app). */
export function appHome(env = process.env) {
  return path.join(env.BRAIN_HOME ? path.resolve(env.BRAIN_HOME) : path.join(os.homedir(), '.project-brain'), 'app');
}

/**
 * Does the built app still belong to this install? A stamp next to it records
 * the package version and the engine it was built for; an upgrade or a move
 * means a rebuild. PURE.
 */
export function needsBuild(stamp, want) {
  return !stamp || stamp.version !== want.version || stamp.engine !== want.engine;
}

function hasSwift() {
  try { execFileSync('xcrun', ['--find', 'swift'], { stdio: ['ignore', 'pipe', 'ignore'] }); return true; } catch { return false; }
}

/**
 * The app bundle to open: a developer's companion/build if there is one,
 * else one built for this install under ~/.project-brain/app (built here on
 * first use, about a minute; no download, nothing to notarise).
 */
/** Newest modification time under a folder (the app's sources), 0 if unreadable. */
function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { newest = Math.max(newest, fs.statSync(p).mtimeMs); } catch { /* raced */ } }
    }
  };
  walk(dir);
  return newest;
}

function runBundle(env) {
  const script = path.join(ROOT, 'companion', 'scripts', 'bundle.sh');
  if (!fs.existsSync(script)) { console.error('leanlamp: the companion sources are not in this install'); return false; }
  if (!hasSwift()) {
    console.error('leanlamp: the companion builds from source with Apple\'s Command Line Tools (no download, nothing to notarise).\n  xcode-select --install   then: leanlamp open');
    return false;
  }
  const r = spawnSync('zsh', [script], { stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.error) { console.error(`leanlamp: could not run the build (${r.error.code || r.error.message}) — it needs zsh, which macOS ships`); return false; }
  return r.status === 0;
}

/**
 * The app bundle to open. A checkout with companion/build/Leanlamp.app (a
 * developer's) opens that one, and --rebuild rebuilds it there; an install
 * builds its own under ~/.project-brain/app on first use (about a minute; no
 * download, nothing to notarise) and again after an upgrade or a move.
 */
function ensureApp({ rebuild = false } = {}) {
  const dev = path.join(ROOT, 'companion', 'build', 'Leanlamp.app');
  if (fs.existsSync(dev)) {
    if (rebuild) {
      console.log('rebuilding companion/build/Leanlamp.app');
      if (!runBundle({})) { console.error('leanlamp: the build failed (output above)'); return null; }
    } else {
      let built = 0;
      try { built = fs.statSync(path.join(dev, 'Contents', 'MacOS', 'leanlamp')).mtimeMs; } catch { /* half a bundle */ }
      if (newestMtime(path.join(ROOT, 'companion', 'Sources')) > built) console.log('note: companion/build is older than its sources — leanlamp open --rebuild');
    }
    return dev;
  }
  const out = appHome();
  const bundle = path.join(out, 'Leanlamp.app');
  const stampFile = path.join(out, 'build.json');
  const want = { version: VERSION, engine: COMPANION };
  let stamp = null;
  try { stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8')); } catch { /* never built */ }
  if (!rebuild && fs.existsSync(bundle) && !needsBuild(stamp, want)) return bundle;
  console.log(`building the companion for this Mac — once, about a minute (${pretty(out)})`);
  if (!runBundle({ LEANLAMP_BUILD_DIR: out }) || !fs.existsSync(bundle)) { console.error('leanlamp: the build failed (output above)'); return null; }
  fs.writeFileSync(stampFile, JSON.stringify({ ...want, builtAt: new Date().toISOString() }, null, 2) + '\n');
  return bundle;
}

function open(args = []) {
  if (refuseNpx('open')) return 2;
  const bundle = ensureApp({ rebuild: args.includes('--rebuild') });
  if (!bundle) return 1;
  if (args.includes('--build-only')) { console.log(bundle.replace(os.homedir(), '~')); return 0; }
  return spawnSync('open', [bundle], { stdio: 'inherit' }).status ?? 1;
}

const pretty = (p) => p.replace(os.homedir(), '~');

function backupDir() {
  return path.join(process.env.BRAIN_HOME ? path.resolve(process.env.BRAIN_HOME) : path.join(os.homedir(), '.project-brain'), 'backups');
}

let backups = 0;
/** A copy of `file` before leanlamp changes it; the name says which file it was (two config dirs both have a settings.json). */
function backupTo(file, why) {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const which = pretty(path.resolve(file)).replace(/^~/, 'home').replace(/[\\/]+/g, '_').replace(/[^\w.-]/g, '');
  fs.copyFileSync(file, path.join(dir, `${why}-${which}-${Date.now()}-${process.pid}-${backups++}`));
}

/**
 * What `init --undo` does to each file the ledger names. PURE: `read(file)`
 * gives the parsed settings, undefined (missing) or null (not JSON);
 * `removeHook` is the engine's. Per file, oldest change first in `list`:
 *  - the hook comes out, unless leanlamp's last act there was to take it out;
 *  - a compaction mark is walked back newest first, each change to the value
 *    it replaced, while the value is still the one leanlamp wrote; a value
 *    someone set since stops the walk and stays (theirs);
 *  - a file leanlamp created and left empty is removed;
 *  - an unreadable file is left alone and its changes stay in the ledger.
 */
export function planUndo(changes, read, removeHook) {
  const byFile = new Map();
  for (const c of changes) {
    if (c.kind !== 'hook' && c.kind !== 'mark') continue;
    if (!byFile.has(c.file)) byFile.set(c.file, []);
    byFile.get(c.file).push(c);
  }
  const plans = [];
  for (const [file, list] of byFile) {
    const plan = { file, done: [], kept: false, keep: [], next: null, write: false, remove: false };
    plans.push(plan);
    const cur = read(file);
    if (cur === undefined) { plan.done.push(['gone already', 'gone already']); continue; }
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) {
      plan.done.push(['not valid JSON — left as is; fix it and run leanlamp init --undo again', 'not valid JSON — would be left as is']);
      plan.kept = true; plan.keep = list; continue;
    }
    let next = JSON.parse(JSON.stringify(cur));
    let changed = false;
    const hooks = list.filter((c) => c.kind === 'hook');
    if (hooks.length && hooks.at(-1).action !== 'removed') {
      const r = removeHook(next);
      if (r.removed) {
        next = r.settings; changed = true;
        const n = `${r.removed} entr${r.removed === 1 ? 'y' : 'ies'}`;
        plan.done.push([`removed the companion hook (${n})`, `would remove the companion hook (${n})`]);
      } else plan.done.push(['no companion hook in it any more', 'no companion hook in it any more']);
    }
    const marks = list.filter((c) => c.kind === 'mark');
    if (marks.length) {
      const key = marks[0].key;
      const has = next.env && Object.prototype.hasOwnProperty.call(next.env, key);
      const start = has ? next.env[key] : null;
      let val = start;
      let theirs = false;
      for (const c of [...marks].reverse()) {
        const before = c.before === undefined ? null : c.before;
        if (val !== null && String(val) === String(c.after)) { val = before; continue; }
        if (String(val) === String(before)) continue; // put back already (an undo that stopped half-way)
        theirs = true; break; // set by someone since: from here on it is theirs
      }
      if (String(val) !== String(start)) {
        if (val === null) { delete next.env[key]; if (!Object.keys(next.env).length) delete next.env; }
        else { next.env ||= {}; next.env[key] = val; }
        changed = true;
        plan.done.push(val === null ? ['removed the compaction mark', 'would remove the compaction mark'] : [`compaction mark back to ${val}`, `compaction mark would go back to ${val}`]);
      } else if (theirs && start === null) {
        plan.done.push(['the compaction mark is gone already', 'the compaction mark is gone already']);
      } else if (theirs) {
        plan.done.push([`the compaction mark was changed since (now ${start}) — left as is`, `the compaction mark was changed since (now ${start}) — would be left as is`]);
        plan.kept = true;
      } else plan.done.push([start === null ? 'the compaction mark is gone already' : 'the compaction mark is as it was', start === null ? 'the compaction mark is gone already' : 'the compaction mark is as it was']);
    }
    if (changed) {
      plan.next = next;
      if (list[0].created === true && !Object.keys(next).length) {
        plan.remove = true;
        plan.done.push(['deleted the file leanlamp had created', 'would delete the file leanlamp had created']);
      } else plan.write = true;
    }
  }
  return plans;
}

/**
 * Put back what leanlamp changed (the change ledger). Each file is handled on
 * its own and reported as it goes; what could not be done stays in the
 * ledger for the next run. Exit 1 when something stayed.
 */
async function undo(args) {
  const dry = args.includes('--dry-run');
  const { busDir, readChanges, recordChange, writeConfigFile } = await import('../scripts/companion-bus.mjs');
  const { removeHook } = await import('../scripts/brain-companion.mjs');
  const dir = busDir();
  const changes = readChanges(dir);
  if (!changes.length) { console.log('leanlamp has changed no settings since the last undo — nothing to put back'); return 0; }
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return e.code === 'ENOENT' ? undefined : null; } };
  console.log(`leanlamp init --undo${dry ? ' (dry run)' : ''}`);
  const keep = [];
  let kept = 0;
  for (const plan of planUndo(changes, read, removeHook)) {
    let lines = plan.done.map(([did, would]) => (dry ? would : did));
    if (!dry && (plan.write || plan.remove)) {
      try {
        backupTo(plan.file, 'undo');
        let regular = true;
        try { regular = fs.lstatSync(plan.file).isFile(); } catch { /* gone */ }
        if (plan.remove && regular) fs.unlinkSync(plan.file);
        else writeConfigFile(plan.file, JSON.stringify(plan.next, null, 2) + '\n'); // a link stays a link
      } catch (e) {
        lines = [`could not write it (${e.code || e.message}) — left as is; run leanlamp init --undo again`];
        plan.kept = true; plan.keep = changes.filter((c) => c.file === plan.file);
      }
    }
    if (plan.kept) kept += 1;
    keep.push(...plan.keep);
    console.log(`  ${pretty(plan.file)}: ${lines.join(', ')}`);
  }
  if (!dry) {
    recordChange(dir, { kind: 'undo' });
    for (const c of keep) recordChange(dir, { ...c, carried: true }); // still to do: the next undo finds them
    console.log(`\nbackups in ${pretty(backupDir())} · running sessions keep the hook until they restart`);
  }
  console.log(`the app: "Open at login" is switched off in its menu; the app itself is ${pretty(appHome())} (delete it to remove it)`);
  return kept ? 1 : 0;
}

/**
 * Run from npx's cache (~/.npm/_npx/<hash>/…)? Then the hook and the app
 * would point into a folder npm clears or replaces at will, and every tool
 * call would run a hook that is gone. PURE.
 */
export function fromNpxCache(root = ROOT) {
  return /[\\/]_npx[\\/]/.test(root);
}

function refuseNpx(verb) {
  if (!fromNpxCache()) return false;
  const pkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name; } catch { return 'leanlamp'; } })();
  console.error(`leanlamp: this runs from npx's cache, which npm clears — the hook would point at a file that disappears.\nInstall it once, then run it again:\n  npm i -g ${pkg}\n  leanlamp ${verb}`);
  return true;
}

async function init(args) {
  // --check: is everything init sets up in place and working? Read-only; exit 1 on a ✗.
  if (args.includes('--check')) return node(COMPANION, ['check', ...args.filter((a) => a !== '--check')]);
  if (args.includes('--undo')) return undo(args);
  const dry = args.includes('--dry-run');
  if (!dry && refuseNpx('init')) return 2;
  console.log('leanlamp init' + (dry ? ' (dry run)' : ''));
  console.log('');
  console.log('1 · the companion hook (steer, hold, approve) in your Claude settings');
  let code = node(COMPANION, ['install-hooks', ...(dry ? ['--dry-run'] : [])]);
  console.log('');
  console.log('2 · the compaction mark for this repo');
  const repo = gitRoot();
  if (!repo) console.log('  not in a git repository — skipped (run leanlamp init or leanlamp compact --at 300k inside the repo)');
  else {
    const marks = await effectiveMarks(repo);
    const { describeWindows } = await import('../scripts/brain-companion.mjs');
    // any mark already chosen (in this repo or a config dir's user settings) is respected, not overridden
    if (marks.some((m) => m.window)) console.log(`  already set: ${describeWindows(marks)}`);
    else code = (await compact(['--at', '300k', ...(dry ? ['--dry-run'] : [])])) || code;
  }
  console.log('');
  console.log('3 · next: leanlamp open (the companion) · leanlamp init --check (is it all working?) · leanlamp receipt (after a day of work)');
  return code;
}

const mbText = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(`${question} [y/N] `, r));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function sessions(args) {
  const S = await import('../scripts/sessions.mjs');
  const [sub = 'list', ...more] = args[0] && !args[0].startsWith('-') ? args : ['list', ...args];
  const flag = (f) => more.includes(f) || args.includes(f);
  const opt = (f, d) => { const i = more.indexOf(f); return i === -1 ? d : more[i + 1]; };
  const now = Date.now();
  if (sub === 'parked') {
    const cards = S.listParked();
    if (flag('--json')) { console.log(JSON.stringify(cards, null, 2)); return 0; }
    if (!cards.length) { console.log('nothing parked — leanlamp sessions park --idle parks the quiet ones'); return 0; }
    console.log(cards.map((c) => S.renderCard(c, { now })).join('\n\n'));
    return 0;
  }
  if (sub === 'resume') {
    const q = more.find((a) => !a.startsWith('-'));
    const hits = S.pick(S.listParked(), q);
    if (hits.length !== 1) { console.error(hits.length ? `leanlamp: "${q}" matches ${hits.length} parked sessions — use more of the id` : `leanlamp: no parked session matches "${q || ''}" (leanlamp sessions parked)`); return 2; }
    const cmd = S.resumeCommand(hits[0]);
    if (flag('--open') && process.platform === 'darwin') {
      const r = spawnSync('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(cmd)}`, '-e', 'tell application "Terminal" to activate'], { stdio: 'ignore' });
      if (r.status !== 0) { console.error(`leanlamp: could not open Terminal — run it yourself:\n${cmd}`); return 1; }
      S.unpark(hits[0].sessionId);
      console.log(`resumed in a new Terminal window: ${hits[0].name || hits[0].project}`);
      return 0;
    }
    console.log(cmd);
    return 0;
  }
  const list = S.listSessions();
  const ancestors = S.ancestorPids();
  const idleMs = Number(opt('--hours', S.PARK_DEFAULTS.idleHours)) * 3600_000;
  const rows = list.map((s) => ({ ...s, verdict: S.parkVerdict(s, { now, idleMs, ancestors }) }));
  if (sub === 'list') {
    if (flag('--json')) { console.log(JSON.stringify(rows, null, 2)); return 0; }
    const total = rows.reduce((a, s) => a + s.mb.total, 0);
    const idle = rows.filter((s) => s.verdict.park);
    const free = idle.reduce((a, s) => a + s.mb.total, 0);
    console.log(`${rows.length} open sessions · ${mbText(total)} with their MCP servers and tools`);
    for (const s of [...rows].reverse()) {
      const mark = s.verdict.park ? 'idle' : s.verdict.why === 'this session' ? 'this' : s.verdict.why === 'working' ? 'busy' : s.verdict.why === 'recent' ? 'open' : '?';
      const last = s.lastMessageMs ? S.ago(now - s.lastMessageMs) : 'no transcript';
      console.log(`  ${String(s.pid).padStart(6)}  ${mark.padEnd(4)}  ${mbText(s.mb.total).padStart(7)}  ${last.padEnd(13)}  ${(s.name || path.basename(s.cwd)).slice(0, 28).padEnd(28)}  ${s.cwd.replace(os.homedir(), '~')}`);
    }
    if (idle.length) console.log(`\n${idle.length} quiet for over ${idleMs / 3600_000} h · ${mbText(free)} — leanlamp sessions park --idle (each keeps a card; leanlamp sessions parked)`);
    const left = S.leftovers({ sessions: list });
    if (left.length) console.log(`${left.length} process${left.length === 1 ? '' : 'es'} left behind by closed sessions · ${mbText(left.reduce((a, x) => a + x.mb, 0))} — leanlamp sessions clean`);
    return 0;
  }
  if (sub === 'clean') {
    const left = S.leftovers({ sessions: list });
    if (!left.length) { console.log('nothing left behind: every process from a scratchpad belongs to an open session'); return 0; }
    for (const x of left) console.log(`  ${String(x.pid).padStart(6)}  ${mbText(x.mb).padStart(7)}  up ${S.ago(x.ageSec * 1000).replace(' ago', '')}  ${x.command.slice(0, 80)}`);
    if (flag('--dry-run')) { console.log(`would stop ${left.length}`); return 0; }
    if (!flag('--yes') && !(await confirm(`stop ${left.length} process${left.length === 1 ? '' : 'es'} left behind by closed sessions?`))) { console.log('nothing stopped (--yes to skip the question)'); return 1; }
    const gone = await S.stopLeftovers(left);
    console.log(`stopped ${gone.length} process${gone.length === 1 ? '' : 'es'}`);
    return 0;
  }
  if (sub === 'park') {
    const q = more.find((a, i) => !a.startsWith('-') && more[i - 1] !== '--hours');
    let targets;
    if (flag('--idle')) targets = rows.filter((s) => s.verdict.park);
    else {
      targets = S.pick(rows, q);
      if (!q || !targets.length) { console.error(`leanlamp: park which session? ${q ? `nothing matches "${q}"` : 'give a pid, id prefix or name, or --idle'}`); return 2; }
      if (targets.length > 1) { console.error(`leanlamp: "${q}" matches ${targets.length} sessions — use the pid`); return 2; }
      const v = targets[0].verdict;
      if (!v.park && v.why !== 'recent') { console.error(`leanlamp: not parking ${targets[0].pid}: ${v.why === 'this session' ? 'it is this session' : v.why === 'working' ? 'it is working right now' : 'its transcript was not found, so nothing could be kept'}`); return 2; }
    }
    if (!targets.length) { console.log(`no session has been quiet for over ${idleMs / 3600_000} h`); return 0; }
    const sum = mbText(targets.reduce((a, s) => a + s.mb.total, 0));
    console.log(targets.map((s) => `  ${s.pid}  ${mbText(s.mb.total).padStart(7)}  ${s.name || path.basename(s.cwd)}`).join('\n'));
    if (flag('--dry-run')) { console.log(`would park ${targets.length} session(s), ${sum}`); return 0; }
    if (!flag('--yes') && !(await confirm(`park ${targets.length} session(s) and free about ${sum}?`))) { console.log('nothing parked (--yes to skip the question)'); return 1; }
    let freed = 0;
    for (const s of targets) {
      const r = await S.park(s);
      if (r.ended) freed += s.mb.total;
      console.log(`${r.ended ? 'parked' : 'card written, still running'}: ${s.name || path.basename(s.cwd)}${r.leftovers.length > 1 ? ` (${r.leftovers.length} helpers still up)` : ''}`);
    }
    console.log(`freed about ${mbText(freed)} · leanlamp sessions parked shows the cards and how to resume`);
    return 0;
  }
  console.error(`leanlamp: sessions ${sub}? ${HELP.sessions}`);
  return 2;
}

export async function main(argv = process.argv.slice(2)) {
  const [verb, ...rest] = argv;
  if (!verb || verb === '--help' || verb === '-h' || verb === 'help') {
    if (verb === 'help' && rest[0] && HELP[rest[0]]) { console.log(HELP[rest[0]]); return 0; }
    console.log(usage()); return 0;
  }
  // help never acts: `leanlamp init --help` must not touch any settings (x passes it on to the command)
  const asksHelp = (a) => a === '--help' || a === '-h';
  // a steer note is literal words ("please run --help"): there only a leading --help is the flag
  if (verb !== 'x' && (verb === 'steer' ? asksHelp(rest[0]) : rest.some(asksHelp))) {
    if (HELP[verb]) { console.log(HELP[verb]); return 0; }
  }
  switch (verb) {
    case 'init': return await init(rest);
    case 'open': return open(rest);
    case 'status': return node(COMPANION, rest);
    case 'recall':
      if (!rest.filter((a) => !a.startsWith('-')).length) { console.error(`leanlamp: recall what? ${HELP.recall}`); return 2; }
      return node(path.join(SCRIPTS, 'brain-recall.mjs'), rest);
    case 'steer': {
      // flags first, then the session, then the note as literal words
      const flags = [], words = [];
      let session = null;
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (!session && (a === '--state' || a === '--roots')) { flags.push(a, rest[++i]); continue; }
        if (!session && a === '--json') { flags.push(a); continue; }
        if (!session) { session = a; continue; }
        words.push(a);
      }
      return node(COMPANION, [...flags, 'steer', session ?? '', '--', ...words]);
    }
    case 'hold': {
      const [first, ...more] = rest;
      if (['release', 'approve', 'deny'].includes(first)) return node(COMPANION, [first, ...more]);
      return node(COMPANION, ['hold', ...rest]);
    }
    case 'release': case 'approve': case 'deny': return node(COMPANION, [verb, ...rest]);
    case 'compact': try { return await compact(rest); } catch (e) { console.error(`leanlamp: ${e.message}`); return 2; }
    case 'receipt': return node(COMPANION, ['receipt', ...rest]);
    case 'sessions': return await sessions(rest);
    case 'x': {
      const [name, ...args] = rest;
      if (!name) { console.log(listScripts().join('\n')); return 0; }
      const file = path.join(SCRIPTS, `brain-${name.replace(/^brain[-:]/, '')}.mjs`);
      if (!fs.existsSync(file)) { console.error(`leanlamp: no such command: ${name} (leanlamp x lists them)`); return 2; }
      return node(file, args);
    }
    default:
      console.error(`leanlamp: unknown verb "${verb}"\n\n${usage()}`);
      return 2;
  }
}

const isMain = (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) main().then((code) => process.exit(code), (e) => { console.error(`leanlamp: ${e && e.message ? e.message : e}`); process.exit(1); });
