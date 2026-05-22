/**
 * One-shot brain maintenance: sync the index when stale, then health-check.
 *
 * Flags: --hook (run minimally on git hook), --ci (strict, fail on warn),
 * --strict (fail on health warnings), --clean-session-files (drop expired
 * session markdown). The recommended automation entry point — wraps
 * brain:sync + brain:health + optional brain:eval in one command.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, BRAIN_DIR, JSON_INDEX, exists, read, staleIndexFromRecords, isFastMode } from './common.mjs';

const argv = process.argv.slice(2);
const hook = argv.includes('--hook');
const ci = argv.includes('--ci') || process.env.BRAIN_MAINTAIN_CI === '1';
const strict = argv.includes('--strict') || ci;
const noSync = argv.includes('--no-sync');
const forceSync = argv.includes('--force-sync');
const cleanSessions = argv.includes('--clean-sessions') || process.env.BRAIN_MAINTAIN_CLEAN_SESSIONS !== '0';
const cleanSessionFiles = argv.includes('--clean-session-files') || process.env.BRAIN_SESSION_CLEAN_FILES === '1';
const caveman = argv.includes('--caveman') || process.env.BRAIN_MAINTAIN_CAVEMAN === '1';
const wenyan = argv.includes('--wenyan') || process.env.BRAIN_MAINTAIN_WENYAN === '1';

const EVAL_PATH = path.join(BRAIN_DIR, 'eval.json');

function npmRun(script, extraArgs = []) {
  const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(cmd, ['run', script, '--', ...extraArgs], { cwd: ROOT, stdio: 'inherit', env: process.env });
  return r.status ?? 1;
}

function say(english, classical) {
  if (caveman) console.log(`[brain:maintain] ${english}`);
  if (wenyan && classical) console.log(`[brain:maintain] ${classical}`);
}

function readIndexState() {
  if (!exists(JSON_INDEX)) {
    return { hasIndex: false, deleted: [], changed: [], needsSync: true };
  }
  try {
    const index = JSON.parse(read(JSON_INDEX));
    const stale = staleIndexFromRecords(index.records || []);
    const needsSync = Boolean(stale.deleted.length || stale.changed.length);
    return { hasIndex: true, ...stale, needsSync };
  } catch {
    return { hasIndex: true, deleted: [], changed: [], needsSync: true, parseError: true };
  }
}

function main() {
  if (isFastMode() && !argv.includes('--force') && !ci) {
    say('FAST=1 skip maintain (use --force or --ci to override)', '速止');
    return 0;
  }

  let state = readIndexState();
  if (state.parseError) say('index parse failed; re-sync', '毳');

  if (exists(path.join(BRAIN_DIR, 'active_state.md'))) {
    const active = read(path.join(BRAIN_DIR, 'active_state.md'));
    if (/^<<<<<<<|^=======|^>>>>>>>/m.test(active)) {
      say('active_state.md still has merge markers — resolve tables before parallel work', '爭');
    }
  }

  if (!noSync && (state.needsSync || !state.hasIndex || forceSync)) {
    if (!state.hasIndex) say('cold index → sync', '寒譜');
    else if (state.deleted.length || state.changed.length) {
      const sample = [...state.deleted, ...state.changed].slice(0, 3).join(', ');
      say(`ghost paths ${state.deleted.length}, hash drift ${state.changed.length} (e.g. ${sample})`, '故');
    } else if (forceSync) say('force reindex', '強');
    const code = npmRun('brain:sync', forceSync ? ['--force'] : []);
    if (code !== 0) {
      if (!hook) return code;
      say(`sync failed (hook soft-exit ${code})`, '蹉');
      return 0;
    }
  } else if (!noSync) {
    say('index fresh → skip sync', '鮮');
  }

  state = readIndexState();
  if (state.needsSync && strict && !noSync && !forceSync) {
    say('stale persists → force sync once', '再強');
    const code2 = npmRun('brain:sync', ['--force']);
    if (code2 !== 0 && !hook) return code2;
    state = readIndexState();
  }

  if (state.needsSync && strict) {
    console.error('brain:maintain: index still stale after sync. Try: npm run brain:sync -- --force');
    return hook ? 0 : 1;
  }

  const healthArgs = strict ? ['--strict-stale', '--check-brain-refs'] : [];
  const healthCode = npmRun('brain:health', healthArgs);
  if (healthCode !== 0) return hook ? 0 : healthCode;
  say('health OK', '康');

  if (cleanSessions) {
    const cleanArgs = ['clean'];
    if (cleanSessionFiles) cleanArgs.push('--files');
    const cleanCode = npmRun('brain:session', cleanArgs);
    if (cleanCode !== 0 && !hook) return cleanCode;
    say('expired sessions cleaned', '汰');
  }

  const hasEvalFile = exists(EVAL_PATH);
  if (strict && hasEvalFile) {
    const prev = process.env.BRAIN_EVAL_STRICT;
    process.env.BRAIN_EVAL_STRICT = '1';
    const e = npmRun('brain:eval');
    if (prev === undefined) delete process.env.BRAIN_EVAL_STRICT;
    else process.env.BRAIN_EVAL_STRICT = prev;
    if (e !== 0) {
      say('eval FAIL', '敗');
      return hook ? 0 : e;
    }
    say('eval OK', '成');
  } else if (ci && strict && !hasEvalFile) {
    console.log('brain:maintain: CI skipping brain:eval (add .project-brain/eval.json for strict retrieval smoke tests).');
    say('CI skip eval', '省試');
  }

  return 0;
}

process.exit(main());
