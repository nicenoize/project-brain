/**
 * pubsub: cross-project edges for producer/consumer pairs sharing the same
 * topic / queue / stream name across services.
 *
 * Patterns (regex-level — best-effort, confidence: medium):
 *   - Kafka:        producer.send({ topic: 'X' }) / consumer.subscribe(['X'])
 *                   producer.produce('X', ...) (Confluent)
 *   - RabbitMQ:     channel.publish('exch','rkey'), .consume('queue', ...)
 *                   .assertQueue('Q'), .sendToQueue('Q', ...)
 *   - Redis Streams: XADD <stream> ..., XREAD STREAMS <stream>
 *   - SQS:          SendMessage QueueUrl=.../X, ReceiveMessage QueueUrl=.../X
 *   - Cloud Pub/Sub: publisher.publish('projects/x/topics/Y', ...)
 *
 * For each topic key, collect producers + consumers across the fleet and
 * emit one edge per (producer, consumer) pair.
 */
import fs from 'node:fs';
import path from 'node:path';

const NAME = 'pubsub';
const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.go', '.py', '.java', '.kt']);

const PRODUCER_PATTERNS = [
  /\.send\s*\(\s*\{[^}]*topic:\s*['"`]([^'"`]+)['"`]/g,    // kafkajs
  /\.produce\s*\(\s*['"`]([^'"`]+)['"`]/g,                // node-rdkafka
  /\.publish\s*\(\s*['"`]([^'"`]+)['"`]/g,                // rabbit + pubsub
  /\.sendToQueue\s*\(\s*['"`]([^'"`]+)['"`]/g,
  /\bXADD\s+(\S+)/g,
  /SendMessage[^)]*Queue(?:Url|Name)[=:][^'"`]*['"`]?[^'"`/]*\/([^'"`/]+)['"`]?/g
];

const CONSUMER_PATTERNS = [
  /\.subscribe\s*\(\s*\[?\s*\{?\s*topic:\s*['"`]([^'"`]+)['"`]/g,
  /\.subscribe\s*\(\s*\[\s*['"`]([^'"`]+)['"`]/g,
  /\.subscribe\s*\(\s*['"`]([^'"`]+)['"`]/g,
  /\.consume\s*\(\s*['"`]([^'"`]+)['"`]/g,
  /\.assertQueue\s*\(\s*['"`]([^'"`]+)['"`]/g,
  /\bXREAD[^]*?STREAMS\s+(\S+)/g,
  /ReceiveMessage[^)]*Queue(?:Url|Name)[=:][^'"`]*['"`]?[^'"`/]*\/([^'"`/]+)['"`]?/g
];

async function* detect(ctx) {
  const topics = new Map(); // topic -> { producers: Map<project, Set<line>>, consumers: Map<project, Set<line>> }

  for (const project of ctx.projects) {
    const projAbs = ctx.projectDirs.get(project.name);
    if (!projAbs) continue;
    const files = collectFiles(projAbs);
    for (const abs of files) {
      let text = '';
      try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      const rel = path.relative(ctx.ROOT, abs);
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const pattern of PRODUCER_PATTERNS) recordMatches(pattern, line, rel, i + 1, project.name, 'producers');
        for (const pattern of CONSUMER_PATTERNS) recordMatches(pattern, line, rel, i + 1, project.name, 'consumers');
      }
    }
  }

  function recordMatches(pattern, line, rel, lineNo, project, role) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(line))) {
      const topic = m[1];
      if (!topic || topic.length > 200) continue;
      if (!topics.has(topic)) topics.set(topic, { producers: new Map(), consumers: new Map() });
      const t = topics.get(topic);
      const bucket = t[role];
      if (!bucket.has(project)) bucket.set(project, new Set());
      bucket.get(project).add(`${rel}:${lineNo}`);
    }
  }

  for (const [topic, { producers, consumers }] of topics) {
    if (!producers.size || !consumers.size) continue;
    for (const [producer, prodLines] of producers) {
      for (const [consumer, consLines] of consumers) {
        if (producer === consumer) continue;
        yield {
          from: producer,
          to: consumer,
          kind: 'pubsub',
          evidence: [...prodLines, ...consLines].sort().slice(0, 6),
          confidence: 'medium',
          meta: { topic }
        };
      }
    }
  }
}

function collectFiles(absDir, out = [], depth = 5) {
  if (depth < 0) return out;
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'vendor' || entry.name === 'dist' || entry.name === 'build') continue;
    const full = path.join(absDir, entry.name);
    if (entry.isDirectory()) collectFiles(full, out, depth - 1);
    else if (SCAN_EXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

export default { name: NAME, detect };
