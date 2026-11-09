/**
 * git-files — two questions hooks ask on every prompt, answered from the
 * files in .git instead of spawning git (~15–25 ms per spawn, four of them per
 * prompt in brain-route):
 *
 *   headBranch(start)     what `git rev-parse --abbrev-ref HEAD` prints
 *   refExists(start, n)   whether `git rev-parse --verify --quiet <n>` succeeds
 *                         for a plain name like main or develop
 *
 * Both return null whenever the files cannot answer with certainty (no .git,
 * an unborn branch, GIT_DIR set, the reftable format, an odd HEAD); callers
 * then ask git as before, so the answer is always git's. Only fs and path.
 */
import fs from 'node:fs';
import path from 'node:path';

/** { gitDir, commonDir } for the repository containing `start`, or null. */
export function gitDirs(start = process.cwd(), env = process.env) {
  if (env.GIT_DIR || env.GIT_WORK_TREE || env.GIT_COMMON_DIR) return null; // git would follow those
  let dir = path.resolve(start);
  for (let i = 0; i < 64; i++) {
    const dotgit = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(dotgit); } catch { /* not here */ }
    if (st) {
      let gitDir = dotgit;
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotgit, 'utf8'));
        if (!m) return null;
        gitDir = path.resolve(dir, m[1].trim());
      }
      let commonDir = gitDir;
      try { commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch { /* not a linked worktree */ }
      if (fs.existsSync(path.join(commonDir, 'reftable'))) return null; // refs are not files there
      return { gitDir, commonDir };
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** Is a full ref name (refs/…) present as a loose file or in packed-refs? PURE but for reads. */
function hasRef(commonDir, full) {
  try { if (/^[0-9a-f]{40,64}$/.test(fs.readFileSync(path.join(commonDir, full), 'utf8').trim())) return true; } catch { /* not loose */ }
  try {
    const packed = fs.readFileSync(path.join(commonDir, 'packed-refs'), 'utf8');
    return packed.split('\n').some((l) => l.endsWith(` ${full}`) && /^[0-9a-f]{40,64} /.test(l));
  } catch { return false; }
}

export function headBranch(start = process.cwd(), env = process.env) {
  try {
    const d = gitDirs(start, env);
    if (!d) return null;
    const head = fs.readFileSync(path.join(d.gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40,64}$/.test(head)) return 'HEAD'; // detached
    const m = /^ref:\s*(refs\/heads\/.+)$/.exec(head);
    if (!m) return null;
    // an unborn branch (no commit yet) makes git fail: let git say so
    if (!hasRef(d.commonDir, m[1])) return null;
    return m[1].slice('refs/heads/'.length);
  } catch { return null; }
}

/** What `git rev-parse HEAD` prints, or null when the files cannot say for certain. */
export function headSha(start = process.cwd(), env = process.env) {
  try {
    const d = gitDirs(start, env);
    if (!d) return null;
    const head = fs.readFileSync(path.join(d.gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40,64}$/.test(head)) return head;
    const m = /^ref:\s*(refs\/.+)$/.exec(head);
    if (!m) return null;
    try {
      const loose = fs.readFileSync(path.join(d.commonDir, m[1]), 'utf8').trim();
      return /^[0-9a-f]{40,64}$/.test(loose) ? loose : null;
    } catch { /* packed */ }
    const packed = fs.readFileSync(path.join(d.commonDir, 'packed-refs'), 'utf8');
    const line = packed.split('\n').find((l) => l.endsWith(` ${m[1]}`) && /^[0-9a-f]{40,64} /.test(l));
    return line ? line.split(' ')[0] : null;
  } catch { return null; }
}

export function refExists(start, name, env = process.env) {
  if (!/^[A-Za-z][\w.-]*$/.test(name)) return null; // only plain names; anything else goes to git
  try {
    const d = gitDirs(start, env);
    if (!d) return null;
    // git's own lookup order for a short name
    for (const full of [`refs/${name}`, `refs/tags/${name}`, `refs/heads/${name}`, `refs/remotes/${name}`, `refs/remotes/${name}/HEAD`]) {
      let loose = null;
      try { loose = fs.readFileSync(path.join(d.commonDir, full), 'utf8').trim(); } catch { /* not loose */ }
      if (loose !== null && !/^[0-9a-f]{40,64}$/.test(loose)) return null; // a symbolic or odd ref: git resolves it
      if (hasRef(d.commonDir, full)) return true;
    }
    // a symbolic ref (refs/remotes/x/HEAD → …) or anything we did not find: git decides
    return fs.existsSync(path.join(d.commonDir, 'refs', 'remotes', name)) ? null : false;
  } catch { return null; }
}
