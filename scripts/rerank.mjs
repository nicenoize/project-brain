/**
 * Cross-encoder reranking over the hybrid-scored candidate head (C3 in
 * docs/eval-failure-analysis.md). A cross-encoder reads the query and the
 * chunk TOGETHER, so it judges relevance directly instead of comparing
 * pre-computed vectors — built for exactly the class-2 failure mode where the
 * right answer is in the pool at rank 9–20 but hybrid scoring misorders it.
 *
 * Default OFF (`BRAIN_RERANK=1` / opts.rerank). Costs one lazy model load
 * (~23 MB first-run download for the default Xenova/ms-marco-MiniLM-L-6-v2)
 * plus CPU inference per query — fine for eval/ask, noticeable for tight
 * interactive loops; cap the work with BRAIN_RERANK_TOP (default 20).
 */

export const DEFAULT_RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';

let loaded = null;

async function load(modelName) {
  if (!loaded || loaded.modelName !== modelName) {
    if (!process.env.BRAIN_QUIET) console.log(`Loading rerank model: ${modelName}`);
    const { AutoTokenizer, AutoModelForSequenceClassification } = await import('@xenova/transformers');
    const tokenizer = await AutoTokenizer.from_pretrained(modelName);
    const model = await AutoModelForSequenceClassification.from_pretrained(modelName, { quantized: true });
    loaded = { modelName, tokenizer, model };
  }
  return loaded;
}

/** Compact pair text for the cross-encoder; the tokenizer truncates the rest. */
export function rerankText(record) {
  return [record.file, record.heading, record.text]
    .filter(Boolean)
    .join('\n')
    .slice(0, 2000);
}

/**
 * Pure ordering step (unit-testable without the model): reorder the first
 * `top` records by cross-encoder score descending — stable, so equal scores
 * keep their hybrid order — and leave the tail untouched. `ceScores[i]`
 * corresponds to `records[i]` for i < top.
 */
export function applyRerankOrder(records, ceScores, top) {
  const n = Math.max(0, Math.min(top, records.length, ceScores.length));
  const head = records.slice(0, n).map((record, index) => ({ record, index, ce: ceScores[index] }));
  head.sort((a, b) => (b.ce - a.ce) || (a.index - b.index));
  return [
    ...head.map(({ record, ce }) => ({ ...record, rerankScore: ce })),
    ...records.slice(n)
  ];
}

/**
 * Rerank the head of a hybrid-scored record list. Fails open: any model/load
 * error logs once and returns the original order, so search availability
 * never depends on the reranker.
 */
export async function rerank(query, records, opts = {}) {
  const top = Number(opts.top || process.env.BRAIN_RERANK_TOP || 20);
  const modelName = opts.model || process.env.BRAIN_RERANK_MODEL || DEFAULT_RERANK_MODEL;
  const n = Math.max(0, Math.min(top, records.length));
  if (n < 2 || !String(query || '').trim()) return records;
  try {
    const { tokenizer, model } = await load(modelName);
    const head = records.slice(0, n);
    const inputs = tokenizer(
      head.map(() => String(query)),
      { text_pair: head.map(rerankText), padding: true, truncation: true }
    );
    const { logits } = await model(inputs);
    const width = logits.dims[logits.dims.length - 1] || 1;
    const ceScores = head.map((_, index) => Number(logits.data[index * width]));
    return applyRerankOrder(records, ceScores, n);
  } catch (error) {
    console.error(`Rerank disabled for this query (${error?.message || error}); using hybrid order.`);
    return records;
  }
}
