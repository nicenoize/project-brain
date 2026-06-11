# Retrieval eval methodology

`brain:eval` (`scripts/brain-eval.mjs`) runs the cases in `.project-brain/eval.json`
and reports `hitAtK`, `fileHitAtK`, `symbolHitAtK`, and `mrr` at `--top-k` (default 8),
plus hard-subset metrics (`hardCases`, `hardHitAtK`, `hardMrr`).
It is the baseline-and-regression harness for any retrieval change.

Flags beyond `--file`/`--top-k`:

- `--hard-only` — restrict to the hard subset (cases whose `note` starts with
  `Hard:`; that prefix is the discriminator, NOT a missing `expectedSymbols`).
- `--diagnose` — per-case failure diagnosis: the expected file's rank in the
  dense candidate pool, in the full hybrid-scored list, and its exact dense
  rank over the whole corpus. Separates candidate-generation misses from
  ranking misses; see `docs/eval-failure-analysis.md` for the taxonomy this
  produced.
- `--out <path>` — write the full JSON report to a file (stdout keeps the
  summary). Reports written this way feed the comparison tool below.

## The saturated-set problem

The original 36 cases reached **recall@8 = 1.000, MRR ≈ 0.95** on the default
embedder. That looks great but is a measurement trap: most of those cases are
single-symbol or filename lookups (`"Qdrant adapter" → QdrantStore`,
`"AST chunking" → findSymbolsAst`). The query words *are* the answer's symbol or
filename, so the **symbol multiplier** and the **keyword/filename surface** in
`retrieval.mjs` nail them before dense similarity is ever decisive.

A saturated set cannot move. Contextual retrieval, graph expansion, and
code-aware embedders all showed **no signal** on it — not because they don't
work, but because there was no headroom left to measure. You can't tell a real
improvement from noise when the baseline is already 1.000.

## What makes a fair *hard* case

The hard cases (added under the `## Eval methodology` rationale, each carrying a
`note` field that `brain:eval` ignores) deliberately create headroom:

1. **Vocabulary mismatch.** The `query` uses *different words* than the target
   file's name and exported symbols. Example:
   `"how do we stop two agents clobbering the same shared file"` →
   `.project-brain/decisions/0005-active-state-exclusive-lock.md`. There is no
   lexical overlap with "lease / lock / active_state", so the symbol multiplier
   and filename-keyword surface can't short-circuit the match — dense similarity
   has to earn the hit.
2. **File-level, not symbol-level.** Hard cases set `expectedFiles` only and
   **omit `expectedSymbols`**. A populated `expectedSymbols` makes the harness
   run a broad-candidate symbol scan (`broadCandidates`, see decision 0003),
   which reintroduces literal-symbol matching and defeats the purpose.
3. **Genuinely best target.** The named file must actually be the single best
   answer to the question, not merely *an* acceptable one. A vocabulary-mismatch
   case is only fair if a knowledgeable human would also point at that exact
   file. Each `note` states why the target uniquely owns the concept (usually:
   the ADR/module that introduced the decision the query paraphrases).

## How to use it for retrieval changes

The full set (currently 120 cases: 36 easy + 84 hard) mixes easy lookups and
hard conceptual queries. The **hard subset is where new dense-retrieval
features must show movement.** When you add or tune a retrieval feature
(contextual retrieval, graph expansion, a different embedder, reranking, BM25
params), report **before/after on the hard subset**, not just the aggregate —
the easy cases are already at 1.000 and will mask regressions or improvements
on the cases that actually exercise dense recall.

A feature that improves the aggregate only because it doesn't break the easy
cases has demonstrated nothing. A feature that lifts the hard-subset `fileHitAtK`
or `mrr` has earned its place.

### The required validation procedure

Point estimates lie at this sample size — bge-small looked like a +0.10 win at
n=21, a +0.07 win at n=42, and dissolved into noise (hit@8 Δ +0.024, 95% CI
[−0.060, +0.107]) under a paired bootstrap at n=84. The bootstrap is now a
permanent tool; use it for every retrieval change:

```bash
BRAIN_QUIET=1 npm run brain:eval -- --hard-only --out /tmp/baseline.json
# …apply the change / set the flag…
BRAIN_QUIET=1 npm run brain:eval -- --hard-only --out /tmp/variant.json
npm run brain:eval:compare -- /tmp/baseline.json /tmp/variant.json --hard-only
```

`brain:eval:compare` pairs cases by query, runs a seeded paired bootstrap
(10 000 resamples), and prints Δ + 95% CI + a significance verdict for hit@K
and MRR. Ship a change default-ON only when the hard-subset CI excludes 0 AND
a full-set run shows no easy-case regression. Otherwise it lands as a
documented opt-in flag. At n=84 the CI half-width is roughly ±0.08 on hit@8 —
a fix must recover ~7+ cases to prove out alone; bundle related sub-threshold
fixes into one validated change set rather than shipping them on vibes.

### Absolute baseline (record deltas against this)

Measured 2026-06-11 on a clean MiniLM-384 index, before the failure-analysis
fixes: **hard subset (n=84) hit@8 = 0.595, MRR = 0.468**; easy subset
saturated at 1.000. Per-miss breakdown: `docs/eval-failure-analysis.md` —
notably, 12 of the 84 hard cases were unwinnable (targets outside the
indexable file set) until the coverage fix, which also means earlier A/B
experiments ran with ~16% dead weight in the denominator.

## Authoring more hard cases

- Pick a concept that lives in exactly one ADR / module doc / code file.
- Phrase the query the way a confused newcomer would — with synonyms, not the
  repo's own jargon.
- Verify the target path exists on disk (`tests/eval-cases.test.mjs` enforces
  this for every case).
- Add a one-line `note` justifying fairness. The harness ignores unknown fields.
- Do **not** add `expectedSymbols` to a hard case.
