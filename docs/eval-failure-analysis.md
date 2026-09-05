# Hard-case failure analysis (n=84, 2026-06-11)

First per-case diagnosis of the hard conceptual eval subset, produced with
`BRAIN_QUIET=1 npm run brain:eval -- --hard-only --diagnose --out <file>` on a
freshly force-rebuilt MiniLM index at `main` + the diagnosis tooling branch.
Method background: `docs/eval-methodology.md`.

## Absolute baseline (previously unrecorded)

| metric | value |
|---|---|
| hard cases | 84 |
| **hit@8** | **0.595** |
| **MRR** | **0.468** |
| misses | 34 |

Every prior retrieval experiment (bge-small, contextual chunks, graph
expansion) compared deltas against this floor without knowing it — and, as the
taxonomy below shows, **12 of the 84 cases were unwinnable by any embedder**,
which diluted all of those comparisons.

## Failure taxonomy

| class | count | share of misses | mechanism |
|---|---|---|---|
| 0 — target not indexed | 12 | 35% | expected file is outside `listIndexableFiles()` patterns — no record exists |
| 1 — candidate-generation | 13 | 38% | target is in the corpus but outside the 64-record dense candidate pool (corpus dense ranks 65–1656) |
| 2 — ranking (hybrid demotion) | 9 | 26% | target IS in the dense pool — often near the top — and the hybrid scoring pushes it below top-8 |
| 3 — weak target text | 0 | — | none observed once class 0 is separated out |
| 4 — unfair case | 0 | — | none reclassified; class-0 cases are fair *questions*, the index just can't see their targets |

### Class 0 — the index never sees the target (12 cases)

`listIndexableFiles()` (scripts/common.mjs) indexes `.project-brain/`, `docs/`,
`scripts/`, `README.md`, and app-shaped dirs — but **not** `bin/`,
`templates/`, root-level markdown besides README (`CONTRIBUTING.md`, even
`SKILL.md`), or workflow YAML. All 12 targets:
`bin/setup.sh`, `bin/install-hooks.sh`, `bin/update.sh`, `CONTRIBUTING.md`,
`templates/PULL_REQUEST_TEMPLATE.md`, `templates/brain/MODULE_MAP.md`,
`templates/agents/COMPACT_INSTRUCTIONS.md`, `templates/hooks/pre-commit`,
`templates/hooks/post-merge`, `templates/github-workflows/project-brain.yml`,
`templates/cursor/rules/project-brain-compact.mdc`,
`templates/claude-code/settings.recommended.json`.

These are legitimate newcomer questions ("the script that copies the git hook
templates into the repository's hooks directory") about files a brain should
know. **Fix: widen the indexable patterns** (bin scripts, templates, root
markdown, workflow YAML), not delete the cases.

Statistical side-effect worth internalizing: with 12/84 cases unwinnable, the
maximum reachable hard hit@8 was **0.857**, and any A/B delta got diluted by
~16% — part of why bge-small/contextual/graph-expand all read as "no signal".

### Class 1 — outside the dense candidate pool (13 cases)

Corpus-wide dense ranks of the targets: 65, 81, 111, 137, 155, 166, 187
(7 cases ≤ 256 — a wider pool alone reaches them) and 273, 299, 540, 699, 965,
1656 (6 cases — dense genuinely can't see them; they need a lexical route into
the pool or content-level help). Confirms the ADR 0003 suspicion: with a
dense-only pool of `topK×8 = 64`, BM25/symbol re-ranking can never recover
these. Fixes: `BRAIN_CANDIDATES` widening (shallow half) and a **lexical
candidate union** — BM25-top-N merged into the pool *with real cosine dense
scores* (deep half; today's `BRAIN_BROAD_CANDIDATES` leaves non-dense
candidates at denseScore 0, so α=0.7 buries them).

### Class 2 — hybrid demotion (9 cases)

The most surprising class: corpus dense ranks are 1, 3, 4, 7, 9, 11, 14, 19, 23
but final hybrid ranks are 13–47. **The hybrid layer actively demotes targets
that pure dense retrieval had already found.** Worked example
(`scripts/brain-link-check.mjs`, dense rank **1** → final rank **16**, query
"catching when a path mentioned inside the curated notes no longer exists in
the tree"):

| record | final score | dense | kw | sym | meta |
|---|---|---|---|---|---|
| brain-worktree.mjs (rank 1) | 0.81 | 0.454 | 0.883 | **0.45** | 0.07 |
| brain-explain.mjs (rank 2) | 0.76 | 0.462 | 0.811 | **0.45** | 0.04 |
| brain-link-check.mjs (rank 16) | — | ~0.46 | ~0 | 0 | — |

Two mechanisms, both artifacts of vocabulary mismatch:

1. **Symbol substring noise.** `symbolScore()`'s 0.45 tier fires when any query
   token is a substring of any symbol — natural-language tokens like "tree"
   match `worktree`/`spawnWorktree`, handing distractors a ×1.27 multiplier on
   conceptual queries where no symbol intent exists.
2. **Pool-relative BM25 + compressed dense range.** Dense scores in the pool
   span only ~0.43–0.47, while keyword scores (normalized to the pool max) span
   0–1. On a vocabulary-mismatch query the target scores ~0 keyword *by
   construction*, so the 0.3·kw term + symbol multiplier outweigh the entire
   dense signal.

Fixes mapped to this class: gate the symbol-substring tier to symbol-intent
queries (explicit `--symbol` / identifier-shaped tokens), and/or a
cross-encoder reranker over the pool. Tuning `BRAIN_TEST_PATH_PENALTY` is NOT
on the list — see below.

### Disconfirmed: test-file pollution

SKILL.md's ranking-limits note suggests tests/e2e outrank implementation on NL
queries. In this run the top-8 distractors across all 34 misses contained
**zero** test-like paths (`distractorKinds.test = 0` everywhere). Distractors
are overwhelmingly sibling `scripts/*.mjs` CLIs and `.project-brain/` docs.
Don't spend tuning effort on `BRAIN_TEST_PATH_PENALTY` for this eval.

## Phase C scope decision (from the counts)

1. **C5 — widen `listIndexableFiles` patterns** (class 0, up to +12 cases =
   +0.14 hit@8 ceiling): highest yield, near-zero risk.
2. **C1 — lexical candidate union behind `BRAIN_LEXICAL_UNION=1`** (class 1
   deep + shallow): merge BM25-top-N into the pool with real cosine dense
   scores.
3. **C6 — symbol-substring gating** (class 2): the 0.45 substring tier only
   when the query shows symbol intent (explicit symbol opt or
   camelCase/snake_case token).
4. **C2 — `BRAIN_CANDIDATES` widening**: pure experiment; covered largely by C1.
5. **C3 — cross-encoder reranker**: hold in reserve; revisit if C1+C6 leave
   class 2 misses on the table.
6. ~~C4 — test-path penalty tuning~~: dropped, disconfirmed by data.

Expectation management: CI half-width at n=84 is ~±0.08 on hit@8, so a fix
must recover ≳7 cases to prove out alone. C5 (12 cases) can clear that bar by
itself; C1/C6 likely need to be evaluated as a combined change set
(`npm run brain:eval:compare -- baseline.json variant.json --hard-only`).

## Results of the Phase C fixes (same day, paired bootstrap, seed 42)

| comparison (hard subset, n=84) | hit@8 | Δ hit (95% CI) | MRR | Δ MRR (95% CI) | verdict |
|---|---|---|---|---|---|
| baseline | 0.595 | — | 0.468 | — | — |
| + C5 index coverage | 0.655 | +0.060 [−0.012, +0.143] | 0.497 | +0.029 [−0.037, +0.096] | ns alone |
| + C5 + C1 lexical union | **0.690** | **+0.095 [+0.024, +0.179]** | **0.533** | **+0.066 [+0.003, +0.131]** | **SIGNIFICANT** |
| C5 → C2 pool=256 (info) | 0.690 | +0.036 [−0.048, +0.119] | 0.499 | +0.002 [−0.062, +0.068] | ns; no MRR benefit |
| C5 → C6 substring guard | 0.643 | −0.012 [−0.036, 0] | 0.448 | **−0.049 [−0.090, −0.014]** | **HARMFUL — rejected** |
| C5 → C3 rerank alone | 0.655 | 0 [−0.048, +0.048] | 0.508 | +0.011 [−0.048, +0.071] | ns — needs union first |
| **+ C5 + C1 + C3 (full stack)** | **0.762** | **+0.167 [+0.071, +0.262]** | **0.591** | **+0.123 [+0.036, +0.213]** | **SIGNIFICANT** |

- **Shipped:** C5 (default-on index patterns) + C1 (`BRAIN_LEXICAL_UNION=1`)
  + C3 (`BRAIN_RERANK=1`, cross-encoder over the scored head). C1/C3 are
  default OFF for perf/latency reasons and designed to be enabled **as a
  pair** — union gets targets into the pool (ranks 9–18), the reranker lifts
  them into top-8; alone, rerank measured Δ 0. See
  [[0014-lexical-candidate-union]] and [[0015-cross-encoder-rerank]].
- **C6 rejected by measurement:** the fuzzy substring tier hands noise to
  distractors *and* rank-boosts targets whose symbols share a root with the
  query; removing it loses more than it gains. The flag remains available and
  documented as measured-negative.
- **Easy-set accounting (verified with a pre-C5 control rebuild):** easy was
  36/36 before C5 and 33/36 after — all three regressions are corpus-growth
  effects of the new coverage, not scoring changes (the C1+C3 flag pair
  recovers two of them: 35/36; full-set hit@8 0.733 → 0.825 with the pair on). Two are strict-AND near-misses (expected file still
  ranks #1–2, but the case also demands the expected *symbol* in top-8 and new
  chunks displaced it by a slot or two); one is `SKILL.md` — which genuinely
  documents the asked-about fleet env var — outranking the listed
  code/module targets. The cases were left untouched. Full-set hit@8 went
  0.717 → 0.733. Gate note: the strict "no easy-set regression" rule is kept
  for **scoring** changes; for **coverage** changes it is relaxed to "no net
  regression + each regression individually reviewed", because indexing more
  legitimate content necessarily increases per-chunk competition. Follow-up
  candidates for the three: a canonical module-doc boost relative to manual
  chunks, or symbol-chunk protection in `limitChunksPerFile`.

## Appendix — all 34 misses

`corpus#` = exact dense rank over the whole corpus (0 = no record exists);
`final#` = rank in the full hybrid-scored list (0 = absent from pool).

| class | corpus# | final# | expected file | query gist |
|---|---|---|---|---|
| 0 | 0 | 0 | bin/setup.sh | one-time bootstrap that wires the package |
| 0 | 0 | 0 | bin/install-hooks.sh | script that copies git hook templates into hooks dir |
| 0 | 0 | 0 | bin/update.sh | refreshes linked skill checkout to newest shared code |
| 0 | 0 | 0 | CONTRIBUTING.md | house rules for branches, commit prefixes, tests |
| 0 | 0 | 0 | templates/PULL_REQUEST_TEMPLATE.md | fill-in skeleton describing a change |
| 0 | 0 | 0 | templates/brain/MODULE_MAP.md | hand-kept table of major surfaces |
| 0 | 0 | 0 | templates/agents/COMPACT_INSTRUCTIONS.md | agent-agnostic context-trimming recipe |
| 0 | 0 | 0 | templates/hooks/pre-commit | pre-commit gate + background sync kick |
| 0 | 0 | 0 | templates/hooks/post-merge | refresh brain after pulling merges |
| 0 | 0 | 0 | templates/github-workflows/project-brain.yml | CI job running strict guard checks |
| 0 | 0 | 0 | templates/cursor/rules/project-brain-compact.mdc | editor rule saving resume slice |
| 0 | 0 | 0 | templates/claude-code/settings.recommended.json | config printing active state at session start |
| 1 | 65 | 0 | scripts/brain-adr.mjs | scaffolding a numbered decision record |
| 1 | 81 | 0 | scripts/brain-impact.mjs | what else breaks if I rename this identifier |
| 1 | 111 | 0 | scripts/infer.mjs | sorting new files into kinds from path |
| 1 | 137 | 0 | scripts/brain-health.mjs | flagging entries pointing at deleted files |
| 1 | 155 | 0 | scripts/edges/cache.mjs | reusing yesterday's findings for untouched repos |
| 1 | 166 | 0 | scripts/edges/env-var.mjs | shared backbone via same configuration key |
| 1 | 187 | 0 | scripts/install-cursor-hooks.mjs | merging editor automation into existing config |
| 1 | 273 | 0 | scripts/brain-projects.mjs | listing sibling repos with link counts |
| 1 | 299 | 0 | scripts/setup-package.mjs | bootstrap writing run commands + ignore entries |
| 1 | 540 | 0 | scripts/common.mjs | shared helpers: atomic writes, hashing |
| 1 | 699 | 0 | scripts/retrieval.mjs | what counts as an architecture/policy question |
| 1 | 965 | 0 | scripts/brain-graph.mjs | emitting the file/module/symbol connection picture |
| 1 | 1656 | 0 | scripts/edges/types.mjs | shared contract every edge plugin satisfies |
| 2 | 1 | 16 | scripts/brain-link-check.mjs | catching paths in notes that no longer exist |
| 2 | 3 | 13 | .project-brain/decisions/0007-incremental-summary-rebuild.md | avoiding redundant digest recomputation |
| 2 | 4 | 24 | scripts/edges/openapi-schema.mjs | registering service address from REST contract |
| 2 | 7 | 19 | scripts/chunk.mjs | reading leading comment to summarize a file |
| 2 | 9 | 25 | .project-brain/decisions/0013-lazy-sync-performance.md | skip re-embedding unchanged chunks |
| 2 | 11 | 21 | scripts/contextual.mjs | prepending a where-am-I blurb before embedding |
| 2 | 14 | 47 | .project-brain/modules/coordination.md | picking up where a teammate's chat left off |
| 2 | 19 | 40 | scripts/edges/grpc-client.mjs | linking stub-call site to remote contract |
| 2 | 23 | 18 | .project-brain/modules/indexing.md | end-to-end walk from file list to vector store |

---

# Follow-up: the class-1/class-2 fix, and what is left (2026-09-05)

The taxonomy above named two mechanisms, and the codebase already carried a
lever for each — both shipped default-OFF because each cost more than it was
worth at the time. Both were re-measured on club-ops (10 cases) and on our own
138, and the cost of the expensive one turned out to be a defect rather than a
property.

## What was measured

Same corpus, back to back, `--top-k 12`:

| configuration | recall | hard | MRR | 138 cases |
|---|---|---|---|---|
| lexical union OFF, ≤2 chunks/file (old default) | 0.775 | 0.706 | 0.663 | 31.3 s |
| lexical union ON, 1 chunk/file (new default) | **0.841** | **0.784** | 0.695 | 38.9 s |

Independently on club-ops: recall 0.60 → 0.70, MRR 0.217 → 0.329.

Read the way ADR 0031 requires — paired, by sign, on the metric that matters:

- **hits gained 10, lost 1** (sign test p = 0.006)
- reciprocal rank better 19, worse 14; ΔMRR +0.033 at **t = 1.68 — not
  significant**

So the honest claim is **"the file is found more often"**, not "results are
ranked better". Rank order inside the top-K reshuffles in both directions.

## Why the union, and not a bigger candidate pool

The cheap alternative was tested first, because it would have been free:

| | recall | MRR | 138 cases |
|---|---|---|---|
| candidates 256 | 0.812 | 0.643 | 72.8 s |
| candidates 512 | 0.819 | 0.657 | 148.8 s |
| candidates 1024 | 0.826 | 0.658 | 298.0 s |
| **lexical union** | **0.841** | **0.695** | **38.9 s** |

A bigger pool buys recall by adding distractors, so MRR *falls*. The union adds
records selected for being on-topic. It wins on both axes at an eighth of the
cost.

## The cross-encoder reranker is measurably harmful

`BRAIN_RERANK=1` was the obvious candidate for class 2 and makes things worse:
club-ops recall 0.60 → 0.50, MRR 0.235 → 0.178, and it cancels the per-file cap
gain (0.70 → 0.50). It stays off, now for a recorded reason rather than because
nobody tried it.

## The cost was a defect, not a property

The union shipped OFF because it cost **1.03 s per query** on a 14k-record
index. Split: 741 ms reading the corpus, 523 ms tokenizing it for BM25 — both
entirely query-independent, both recomputed on every single query.

`buildBm25Index`/`bm25Score` separate the corpus half of BM25 from the query
half, and `corpusFor` memoizes it per store, keyed on `store.corpusVersion()`
(row count; a backend that cannot report one is never cached — an unknown
corpus is a changed one). Warm query on club-ops: **1261 ms → 209 ms**, i.e.
+20 ms over the dense-only path instead of +1034 ms.

A one-shot CLI search still pays the build once: `brain:search` cold went
1.44 s → 2.63 s. Long-lived readers — the MCP server, `serve`, `brain:eval` —
pay it once per process. That trade is the reason the flag exists:
`BRAIN_LEXICAL_UNION=0`.

## Per-file cap 2 → 1

club-ops' "sending a notification to a user" spent two of twelve slots on two
chunks of the same `mark-read.tsx` while the file that answered it sat at rank
15. Across 138 cases the change improved 4 and degraded 0 — it can only ever
free a slot for a file not yet in the list.

## What is left, stated precisely

Class 0 (target not indexed) is gone as an explanation for the remaining
club-ops misses — every one of the expected files *is* in the index, and every
code file has a summary record. The residue is **vocabulary**, and it is
structural rather than a ranking accident:

> "how do we talk to the database from the server" expects
> `lib/supabase/server.ts`. That file, and its summary record, contain
> `supabase`, `server`, `client`, `cookies`, `createSupabaseServerClient` — and
> the word **database** nowhere. The summary record is a symbol-and-import
> manifest, not a description of what the file is for.

The records that *do* carry the human vocabulary are the hand-written
`.project-brain/modules/*.md` notes — which is why nine of twelve results for
that query are brain prose. The prose is bridging the gap and then answering in
its own name, because nothing links it back to the files it describes.

That is the next investigation, and it is a chunking/authoring question, not a
model or ranking one: **give each file's summary record the vocabulary a human
would use for it.** It has an obvious cheap form (fold the owning module note's
terms into the file summary) and an obvious expensive one, and per ADR 0031 the
cases that must improve are named in advance:

- *how do we talk to the database from the server* → `lib/supabase/server.ts`
- *where do we decide whether a user may see this venue* → `lib/auth/membership.ts`
- *how does someone get checked in at the door* → the check-in route

If a change lifts recall without moving those three, it did something else.
