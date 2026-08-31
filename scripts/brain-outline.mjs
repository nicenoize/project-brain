#!/usr/bin/env node
/**
 * brain:outline — read ONE function instead of a whole file.
 *
 * WHY. An agent that needs `calibrateFileHealth` reads all 1,300 lines of
 * git-intel.mjs to get 90 of them. That is the single largest avoidable cost in
 * a coding session, and it repeats on every file it touches.
 *
 * The measurement already existed: code-structure.mjs walks every function span
 * to report the longest one, and simply never handed the list over. Nothing
 * here is a new scanner, and there is no second index to keep in sync — the
 * point of building this rather than adopting a symbol-server MCP.
 *
 * HONEST LIMIT, inherited and repeated: line-anchored declarations only. An
 * arrow function assigned inside an object literal is invisible to it. The
 * count is a FLOOR, and `--symbol` says so when it finds nothing rather than
 * implying the symbol does not exist.
 *
 *   brain:outline <file>                 the outline, with line ranges
 *   brain:outline <file> --symbol <name> just that function's source
 *   brain:outline <file> --json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, takeFlag, takeOption } from './common.mjs';
import { measure } from './code-structure.mjs';

/** PURE. Outline rows from a measured file plus its source. */
export function outlineOf(source, file) {
  const m = measure(String(source || ''), { file });
  const lines = String(source || '').split('\n');
  // measure() hands over the spans it already walked, so the outline cannot
  // disagree with the metrics beside it.
  const spans = m.spans || [];
  return {
    file,
    family: m.family,
    lines: m.lines,
    functionCount: m.functionCount,
    symbols: spans.map((s) => ({
      name: s.name,
      startLine: s.startLine,
      endLine: Math.min(lines.length, s.startLine + s.lines - 1),
      lines: s.lines
    }))
  };
}

function main() {
  const args = process.argv.slice(2);
  if (takeFlag(args, '--help') || takeFlag(args, '-h') || !args.length) {
    process.stdout.write([
      'brain:outline — read ONE function instead of a whole file.',
      '',
      '  npm run brain:outline -- <file>                 outline with line ranges',
      '  npm run brain:outline -- <file> --symbol <name> just that function',
      '  npm run brain:outline -- <file> --json',
      '',
      'Line-anchored declarations only — the count is a FLOOR, not a symbol table.'
    ].join('\n') + '\n');
    return;
  }
  const json = takeFlag(args, '--json');
  const symbol = takeOption(args, '--symbol').trim();
  const rel = args.find((a) => !a.startsWith('-')) || '';
  const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  let source;
  try {
    source = fs.readFileSync(abs, 'utf8');
  } catch (error) {
    process.stderr.write(`[brain:outline] cannot read ${rel}: ${error.message || error}\n`);
    process.exit(1);
  }

  const out = outlineOf(source, rel);
  const srcLines = source.split('\n');

  if (symbol) {
    const hit = out.symbols.find((s) => s.name === symbol)
      || out.symbols.find((s) => s.name.toLowerCase() === symbol.toLowerCase());
    if (!hit) {
      // Never imply absence: this scanner sees line-anchored declarations only.
      process.stderr.write(
        `[brain:outline] no line-anchored declaration named "${symbol}" in ${rel}. ` +
        `It may still exist — an arrow assigned inside an object literal is invisible here. ` +
        `Known: ${out.symbols.map((s) => s.name).slice(0, 12).join(', ') || '(none)'}\n`
      );
      process.exit(1);
    }
    const body = srcLines.slice(hit.startLine - 1, hit.endLine).join('\n');
    if (json) { process.stdout.write(JSON.stringify({ ...hit, file: rel, source: body }, null, 2) + '\n'); return; }
    process.stdout.write(
      `${rel}:${hit.startLine}-${hit.endLine} (${hit.lines} of ${out.lines} lines)\n\n${body}\n`
    );
    return;
  }

  if (json) { process.stdout.write(JSON.stringify(out, null, 2) + '\n'); return; }
  const w = Math.max(4, ...out.symbols.map((s) => s.name.length));
  process.stdout.write(`${rel} — ${out.lines} lines, ${out.functionCount} function(s)\n`);
  for (const s of out.symbols) {
    process.stdout.write(`  ${s.name.padEnd(w)}  ${String(s.lines).padStart(4)} lines  ${s.startLine}-${s.endLine}\n`);
  }
  process.stdout.write('\nRead one with --symbol <name>. Line-anchored declarations only (a floor).\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
