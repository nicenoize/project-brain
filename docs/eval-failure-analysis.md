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
