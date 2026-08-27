/**
 * Guard: every tracked source file must be TEXT.
 *
 * WHY THIS EXISTS. Twice now a literal NUL byte has been written into a source
 * file as a join separator (`arr.join('\0')` typed as a real 0x00 rather than
 * the escape `'\x1f'`). The code runs perfectly — and the file becomes binary
 * to every text tool built on the POSIX heuristic. `file(1)` reports "data",
 * and `grep` prints NOTHING for a pattern that is right there in the file,
 * without a word of explanation. Both times it was found by accident, after
 * searches came back silently empty and were believed.
 *
 * Instance fixes do not close this: brain-serve.mjs was cleaned, and
 * import-graph.mjs still had three. So the class is tested, not the instance.
 * A separator that cannot occur in a path is fine — write it as an escape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Extensions we author by hand and therefore expect to be text. */
const TEXT_EXT = new Set(['.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.yml', '.yaml', '.sh', '.css', '.html']);

test('no tracked source file contains a NUL byte', () => {
  const ls = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'buffer' });
  assert.equal(ls.status, 0, 'git ls-files failed');
  const files = ls.stdout.toString('utf8').split('\0').filter(Boolean);
  assert.ok(files.length > 100, `expected a populated file list, got ${files.length}`);

  const offenders = [];
  for (const rel of files) {
    if (!TEXT_EXT.has(path.extname(rel))) continue;
    let buf;
    try { buf = fs.readFileSync(path.join(ROOT, rel)); } catch { continue; }
    const at = buf.indexOf(0);
    if (at !== -1) {
      // Report the line so the fix is a one-liner, not a hunt.
      const line = buf.subarray(0, at).toString('utf8').split('\n').length;
      offenders.push(`${rel}:${line}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'These files are binary to grep/file(1) — replace the literal NUL with the ' +
    "escape sequence '\\x1f':\n  " + offenders.join('\n  ')
  );
});
