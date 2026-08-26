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

The store/model preamble (`Project Brain store: …`, `Loading local embedding
model: …`) and every progress line go to **stderr**, so **stdout is pure JSON**.
That means a plain redirect works with zero stripping — both of these produce a
compare-ready report file:

```bash
node scripts/brain-eval.mjs --hard-only > baseline.json   # redirect (stdout is clean JSON)
node scripts/brain-eval.mjs --hard-only --out baseline.json  # explicit flag (stderr shows a summary)
```

`node scripts/brain-eval.mjs --hard-only | head -c1` prints `{`, confirming no
preamble leaks onto stdout.

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

The full set (currently 138 cases: 36 easy + 102 class-tagged hard, see #33)
mixes easy lookups and hard conceptual queries. The **hard subset is where new dense-retrieval
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
# 1. Capture the baseline (stdout is pure JSON — redirect or --out both work).
node scripts/brain-eval.mjs --hard-only > /tmp/baseline.json
# 2. …apply the change / set the flag…
# 3. Capture the variant the same way.
node scripts/brain-eval.mjs --hard-only > /tmp/variant.json
# 4. Compare the two files (order is baseline first, variant second).
npm run brain:eval:compare -- /tmp/baseline.json /tmp/variant.json --hard-only
```

The two-file contract is `brain:eval:compare <baseline.json> <variant.json>
[--hard-only]`: it takes exactly two `*.json` report paths (positional, baseline
first), and `--hard-only` restricts the paired bootstrap to the hard subset.
Each report file must carry the per-case `results` array, which both `> f.json`
and `--out f.json` include (a hand-trimmed summary will be rejected). Run with no
args and it prints the usage line instead of a comparison.

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

## Consumer baseline — footprint measured in the field (#32)

The retrieval eval above answers *relevance* ("did ranking get better?"). It says
nothing about **cost**: how many tokens the brain injects into a real session, and
how often each command is actually run. Those are a separate instrument — the
**usage ledger** (`.project-brain/.usage.jsonl`, gated by `BRAIN_USAGE_LOG=1`, one
JSONL line per `brain:*` invocation) plus the context-footprint audit in
`brain:health --json`. Ranking stays eval-gated; footprint/usage stays ledger-gated.
Two instruments, no overlap.

Dev-repo self-measurement systematically **underestimates** cost: #21 read
`active_state.md ≈ 110 tokens` from this repo, but the real consumer is ~70× that.
So the measurement site is a live consumer, **club-ops**
(`/Users/seebo/Coding/club-ops`): 84,206 index records, 34 ADRs, index synced
2026-07-01. Every wave-1 acceptance run must be repeated there.

### Baseline (measured 2026-07-10, club-ops) — this table is the "before"

| Artifact | Size | Tokens (len/4) |
|---|---|---|
| `active_state.md` (cat on EVERY SessionStart) | 30,220 B | **≈7,555** |
| `SKILL.md` (per skill activation) | 64,531 B | ≈16,132 |
| `search_index.json` | 90 MB | n/a (disk) |
| Session base cost before any work | | **≈24k tokens** |

Record before/after against this table for each planned improvement:

- **#26 SKILL.md split / #21·#22 token wave** — footprint delta in club-ops (the
  ≈16,132-token `SKILL.md` is the pre-split "before").
- **#17 tool-time nudge** — `brain:search` calls/session before vs. after the nudge
  ships; the usage ledger is the denominator.
- **#23 staleness banner** — banner-fire frequency = how often agents consumed stale
  results silently before.
- **Kill list** — after ~30 days, commands with zero invocations across both repos
  (the `neverUsed` list in `brain:health --json`) are deprecation candidates
  (48 commands today).

The durable deliverable is the measurement discipline itself (the #8 lesson): a
committed baseline plus a running ledger, not a point-in-time claim.

### After — M2 token-budget cut (2026-08-27): digest + CI-enforced budgets

The two big rows in the baseline table are now bounded by construction instead of
by vigilance (the table above stays as the "before"):

- **SessionStart digest replaces the raw cat.** `settings.recommended.json` no
  longer cats `active_state.md` into every session start; it runs
  `scripts/brain-state-digest.mjs` — a deterministic, read-only digest (active
  workstreams, open leases with owner/TTL, blockers, the 3 most recent session
  pointers; finished workstreams and expired leases are dropped first, then whole
  lines are truncated with an explicit `[digest truncated — run: project-brain x
  health]` marker). Hard byte cap: **8,000 B ≈ 2,000 tok**
  (`BRAIN_STATE_DIGEST_BUDGET_BYTES` overrides). Against the club-ops baseline
  that turns ≈7,555 tok into ≤2,000 tok worst-case (a 30-workstream/20-lease
  fixture digests to 7,722 B ≈ 1,930 tok); the quiet dev repo emits ~430 B.
  Not to be confused with `brain-session-digest.mjs`, the PreCompact/Stop
  transcript digest.
- **SKILL.md core pinned.** The #26 lean core (9,609 B ≈ 2,402 tok at budget
  time; the ≈16k-tok pre-split file is the "before" above) now sits under a hard
  budget of **12,000 B ≈ 3,000 tok**.
- **Budgets are a CI test, not a vow** (strategy §2b). Both numbers live in one
  place — `BUDGETS` in `scripts/footprint.mjs` — and
  `tests/footprint-budget.test.mjs` turns a breach into a red build: SKILL.md
  size, digest output on the worst-case fixture (pure core **and** end-to-end
  through the real script), and the template's SessionStart hook actually
  invoking the digest instead of a raw cat. `brain:health`'s footprint audit
  warns over the same constants (advisory, as decisions/0024 mandates).

## Hard-case classes — per-class breakdown + provenance (#33)

The old hard subset (n≤84) was too small to trust point estimates: the #8
paired-bootstrap reversals flipped sign on n≤42. #33 grows it to **n≥100** and
tags every hard case with a `class` so `brain:eval:compare --hard-only` reports
*which kind* of hard query moved, not just the blended hard-set number. The three
classes each stress a different retrieval weakness:

| `class` | what it stresses | example query → target |
|---|---|---|
| `vocabulary-mismatch` | dense recall when the query shares no filename/symbol tokens with the target | "how do we stop two agents clobbering the same shared file" → `decisions/0005-active-state-exclusive-lock.md` |
| `why-style` | rationale that lives only in an ADR — answerable from the decision, not the code | "why add a second judging pass when the blended score already ordered them" → `decisions/0015-cross-encoder-rerank.md` |
| `cross-file/structural` | answers that are a projection over the indexed graph (cross-project edges, symbol impact) | "figuring out which services actually talk to each other at runtime" → `decisions/0010-cross-project-edge-detection.md` |

Current distribution (`.project-brain/eval.json`, tagged via the `class` field
`brain:eval` ignores; `caseClass()` in `scripts/eval-lib.mjs` validates it):

| `class` | count |
|---|---|
| `vocabulary-mismatch` | 71 |
| `why-style` | 14 |
| `cross-file/structural` | 17 |
| **hard total** | **102** |

### Collection provenance

- **84 curated cases** — the original hand-authored hard subset (each `note`
  states why the named file uniquely owns the concept), retro-tagged into the
  three classes.
- **18 authored under #33** — real query→file pairs from *this* repo, kept honest
  per the "What makes a fair hard case" rules above: 10 `why-style` questions
  targeting the rationale ADRs `decisions/0014`–`0024` (none previously used as a
  target), 7 `vocabulary-mismatch` cases over newcomer-synonym queries against
  un-targeted scripts (`brain-radar`, `brain-why`, `brain-insight`, `brain-gaps`,
  `footprint`, `brain-audit`, `rerank`), and 1 `cross-file/structural` case
  (`brain-diagram`, the graph projection).
- **The preferred growth mechanism going forward is `brain:learn`** — harvest
  real query→used-file pairs from live sessions in both repos (point `capture`
  at club-ops), then `promote` the de-duped candidates. Usage-learned cases enter
  *unclassified* (their `note` is not prefixed `Hard:`); a human reviews and,
  where a case is genuinely hard, prefixes the note and assigns a `class` — so
  the curated hard subset never grows without review, and `caseClass()` keeps an
  untagged case out of the per-class deltas rather than mislabelling it.

### Per-class deltas in `brain:eval:compare`

Under `--hard-only`, the compare tool adds a `byClass` array (one row per class:
`baseline`/`variant` hit@K + MRR and their `delta`). These are **point estimates**
— the paired *bootstrap* CI stays on the whole hard subset because per-class n
(14–71) is still thin; the per-class rows orient which class a change moved so a
regression in one class isn't masked by a gain in another. The pure aggregation
(`perClassDeltas` in `scripts/eval-lib.mjs`) is unit-tested in
`tests/eval-compare.test.mjs`; run the actual comparison with
`npm run brain:eval:compare -- baseline.json variant.json --hard-only`.

### Re-baseline (supersedes the n≤42 / 0.762 hard-set number)

Because the hard subset changed (n=84 → 102 with class tags), the current stack's
hard-set hit@8 must be re-measured before it means anything. Record it with:

```
npm run brain:eval -- --hard-only
```

Then treat that number as the new "before" for #19, #29, and #18's
`BRAIN_REFLECT_BOOST` experiment.

## Authoring more hard cases

- Pick a concept that lives in exactly one ADR / module doc / code file.
- Phrase the query the way a confused newcomer would — with synonyms, not the
  repo's own jargon.
- Verify the target path exists on disk (`tests/eval-cases.test.mjs` enforces
  this for every case).
- Add a one-line `note` justifying fairness. The harness ignores unknown fields.
- Do **not** add `expectedSymbols` to a hard case.
