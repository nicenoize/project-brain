// The Stop/PreCompact digest reads a session's whole transcript at every turn
// end. It must find exactly what a full JSON parse of every line finds, while
// decoding and parsing only lines that can hold a tag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractTags } from '../scripts/brain-session-digest.mjs';

const TAG_RE = /^##\s+(Decided|Memory|Followup):\s*(.+)$/gim;
/** The previous implementation, kept as the reference: parse every line. */
function reference(file) {
  const hits = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const content = e?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const text = typeof block === 'string' ? block : block?.text;
      if (typeof text !== 'string') continue;
      let m; TAG_RE.lastIndex = 0;
      while ((m = TAG_RE.exec(text))) hits.push(`- **${m[1]}:** ${m[2].trim()}`);
    }
  }
  return [...new Set(hits)];
}

const say = (text) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

test('the streamed, pre-filtered digest finds exactly what parsing every line finds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-'));
  const file = path.join(dir, 't.jsonl');
  const filler = 'x'.repeat(5 * 1024 * 1024); // one line longer than a read chunk
  const lines = [
    say('work\n## Decided: keep ROUND_HALF_EVEN\nmore'),
    say('## memory: lowercase tag, ümlaut and → arrow'),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'a quoted "## Decided: not mine" in a user string' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', input: { note: '## Followup: inside tool input' } }] } }),
    say(`${filler}\n## Followup: after a 5 MB run`),
    say('## Decided: keep ROUND_HALF_EVEN'), // a repeat: deduped
    'not json ## Decided: broken line',
    say('decided: without hashes is not a tag')
  ];
  fs.writeFileSync(file, lines.join('\n')); // no trailing newline on purpose
  const got = extractTags(file);
  assert.deepEqual(got, reference(file));
  assert.deepEqual(got, [
    '- **Decided:** keep ROUND_HALF_EVEN',
    '- **memory:** lowercase tag, ümlaut and → arrow',
    '- **Followup:** after a 5 MB run'
  ]);
});

test('a transcript without tags gives nothing, a missing one too', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, [say('plain work'), say('## Notes: not one of the three')].join('\n') + '\n');
  assert.deepEqual(extractTags(file), []);
  assert.deepEqual(extractTags(path.join(dir, 'gone.jsonl')), []);
});

test('turn by turn, the cached read finds the same as reading it all; a replaced file is read again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-inc-'));
  const file = path.join(dir, 't.jsonl');
  const half = say('## Followup: written across two turns');
  fs.writeFileSync(file, [say('## Decided: first turn'), say('noise')].join('\n') + '\n' + half.slice(0, 20));
  assert.deepEqual(extractTags(file, { cache: true }), ['- **Decided:** first turn']);
  fs.appendFileSync(file, half.slice(20) + '\n' + say('## Memory: second turn') + '\n');
  const second = extractTags(file, { cache: true });
  assert.deepEqual(second, reference(file));
  assert.deepEqual(second, ['- **Decided:** first turn', '- **Followup:** written across two turns', '- **Memory:** second turn']);
  assert.deepEqual(extractTags(file, { cache: true }), second, 'nothing new: same answer');
  fs.writeFileSync(file, say('## Decided: a fresh file') + '\n'); // shorter than what was read
  assert.deepEqual(extractTags(file, { cache: true }), ['- **Decided:** a fresh file']);
});
