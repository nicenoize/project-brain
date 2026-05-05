import { execSync } from 'node:child_process';

export async function retrieve(query, store, embedder, opts = {}) {
  const topK = Number(opts.topK || process.env.BRAIN_TOP_K || 8);
  const candidates = Number(opts.candidates || Math.max(topK * 8, 32));
  const filter = opts.filter || {};
  const queryVector = await embedder.embed(query);
  const dense = await store.search(queryVector, candidates, filter);
  const all = (await store.getAll()).filter(record => recordMatches(record, filter));
  const denseScores = new Map(dense.map(record => [record.id, record.score]));
  const keyword = tfidfScore(query, all);
  const maxKeyword = Math.max(1, ...keyword.values());
  const context = retrievalContext(opts);
  const alpha = Number(opts.alpha || process.env.BRAIN_HYBRID_ALPHA || 0.7);

  return all
    .map(record => {
      const denseScore = denseScores.get(record.id) || 0;
      const keywordScore = (keyword.get(record.id) || 0) / maxKeyword;
      const metadataScore = metadataBoost(record, context);
      return {
        ...record,
        denseScore,
        keywordScore,
        metadataScore,
        score: hybridScore(denseScore, keywordScore, metadataScore, alpha)
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export function tfidfScore(query, records) {
  const queryTokens = tokenize(query);
  const df = new Map();
  const docs = records.map(record => new Set(tokenize(recordText(record))));
  for (const doc of docs) for (const token of doc) df.set(token, (df.get(token) || 0) + 1);

  const scores = new Map();
  for (let i = 0; i < records.length; i++) {
    let score = 0;
    const textTokens = tokenize(recordText(records[i]));
    for (const token of queryTokens) {
      const tf = textTokens.filter(t => t === token).length;
      if (!tf) continue;
      score += tf * (Math.log((records.length + 1) / ((df.get(token) || 0) + 1)) + 1);
    }
    scores.set(records[i].id, score);
  }
  return scores;
}

export function hybridScore(dense, keyword, metadata, alpha) {
  return alpha * dense + (1 - alpha) * keyword + metadata;
}

export function tokenize(text) {
  return String(text).toLowerCase().split(/[^a-z0-9_/-]+/).filter(token => token.length > 1);
}

export function retrievalContext(opts = {}) {
  const changed = new Set(splitList(process.env.BRAIN_CONTEXT_FILES || opts.contextFiles || '').concat(gitChangedFiles()));
  return {
    branch: opts.branch || process.env.BRAIN_BRANCH || gitBranch(),
    changed
  };
}

function metadataBoost(record, context) {
  let boost = 0;
  if (context.changed.has(record.file)) boost += Number(process.env.BRAIN_CHANGED_FILE_BOOST || 0.12);
  if (record.branch && context.branch && record.branch === context.branch) boost += Number(process.env.BRAIN_BRANCH_BOOST || 0.08);
  if (record.isModuleSummary) boost += Number(process.env.BRAIN_MODULE_SUMMARY_BOOST || 0.03);
  return boost;
}

function recordMatches(record, filter) {
  if (filter.summaryOnly && !record.isSummary) return false;
  if (filter.modulesOnly && !record.isModuleSummary) return false;
  if (filter.type && record.type !== filter.type) return false;
  if (filter.file && record.file !== filter.file) return false;
  return true;
}

function recordText(record) {
  return [
    record.file,
    record.heading,
    record.title,
    record.type,
    record.module,
    record.feature,
    record.decision,
    ...(record.symbols || []),
    ...(record.imports || []),
    record.text
  ].filter(Boolean).join(' ');
}

function splitList(value) {
  return String(value).split(/[,\n]/).map(item => item.trim()).filter(Boolean);
}

function gitBranch() {
  try { return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

function gitChangedFiles() {
  try {
    return execSync('git status --porcelain', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .filter(Boolean)
      .map(line => line.slice(3).trim());
  } catch {
    return [];
  }
}
