/**
 * "Was this module run directly, or imported?" — the CLI guard every script
 * needs so that importing it for tests never runs its CLI.
 *
 * The guard used to compare `process.argv[1]` with the module's own path as
 * strings. A consumer vendors the skill through a symlink
 * (skills/project-brain → the checkout), and Node resolves the main module
 * to its REAL path while argv[1] keeps the symlinked one — so the two never
 * matched, and every script invoked through the symlink silently did
 * nothing and exited 0. That is how six Claude Code hooks in a real repo
 * never ran once while looking perfectly configured. Comparing real paths
 * fixes it, with or without --preserve-symlinks.
 *
 * Dependency-free on purpose: the ambient hooks import it on every edit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function real(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/** True when the module at `metaUrl` is the process entry point. */
export function isMainModule(metaUrl, argv1 = process.argv[1]) {
  if (!argv1 || !metaUrl) return false;
  return real(path.resolve(argv1)) === real(fileURLToPath(metaUrl));
}
