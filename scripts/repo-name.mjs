/**
 * repo-name — which project a working directory belongs to: the git
 * repository it sits in (a worktree counts as its main repository), else the
 * folder's own name. An agent that `cd`s into a subfolder stays in its
 * project; a worktree under .claude/worktrees is not a project of its own.
 * Only fs and path: the engine calls it for every session on every pass.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cache = new Map();

export function repoName(cwd, { home = os.homedir() } = {}) {
  if (!cwd) return null;
  const key = `${home}\0${cwd}`;
  if (cache.has(key)) return cache.get(key);
  let name = path.basename(cwd);
  let dir = path.resolve(cwd);
  for (let i = 0; i < 64; i++) {
    if (dir === home) break; // a home folder kept in git (dotfiles) is not everyone's project
    let st = null;
    try { st = fs.statSync(path.join(dir, '.git')); } catch { /* not here */ }
    if (st) {
      name = path.basename(dir);
      if (st.isFile()) {
        // a worktree: ".git" says "gitdir: <repo>/.git/worktrees/<name>" (a submodule points into modules/ and keeps its own name)
        try {
          const m = fs.readFileSync(path.join(dir, '.git'), 'utf8').match(/gitdir:\s*(.+)/);
          const gitdir = m ? path.resolve(dir, m[1].trim()) : '';
          const at = gitdir.indexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
          if (at > 0) name = path.basename(gitdir.slice(0, at));
        } catch { /* keep the folder name */ }
      }
      break;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (cache.size > 4000) cache.clear();
  cache.set(key, name);
  return name;
}
