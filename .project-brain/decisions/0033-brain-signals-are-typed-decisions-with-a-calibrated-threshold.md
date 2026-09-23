---
title: Brain signals are typed decisions with a calibrated threshold
status: canonical
layer: decision
module: brain-core
feature: hooks
date: 2026-09-23
---

# 0033 — Brain signals are typed decisions with a calibrated threshold

## Context

The ambient answer hook fires before every edit. It injected a danger line
for any file with git history, whatever the score. The low-confidence flag
only added a suffix and never held the line back. Co-change partners had no
minimum either. So the most frequently paid surface the brain has (ADR 0024)
spoke on nearly every first edit. Nothing recorded what it said, so nobody
could tell whether the warnings were right.

The principle comes from classifier-style decision systems (TypeSafe's
"System One" models). We took only the idea, not a model or a dependency: a
signal is a typed decision with a value and a threshold. Above the threshold
it acts; below it, it holds back. Silence is a valid output.

## Decision

1. **A signal is a decision** (`scripts/decision.mjs`):
   `{ signal, target, value, action: emit|log, threshold, reason, session }`.
   Deterministic, no LLM.
2. **Danger emits only at score ≥ 6, and never on thin history.** The number
   is measured. On club-ops (657 files, `health-calibrate --commits 2000
   --horizon-days 7`, AUC 0.74), the share of files needing a fix in the
   following week was 4% / 10% / 15% / 35% by score quartile (cuts at 1.6,
   4.6, 5.9), against a 16% base rate. Below 6 a warning is no better than
   naming a random file. `BRAIN_ANSWER_DANGER_MIN` overrides it; 0 restores
   the old always-warn behaviour.
3. **Co-change is logged, not gated yet.** No calibration exists for its
   confidence, and picking a cut-off without one is exactly the guess this ADR
   exists to stop.
4. **Every decision is recorded**, emitted or held back, in
   `.project-brain/.decisions.jsonl`. The file is local, gitignored and capped
   at 1 MB. A decision the byte budget dropped is recorded as held back,
   because no one saw it. Off with `BRAIN_DECISION_LOG=0`.
5. **The explicit CLI (`brain:answer`) is not gated.** Someone who asks gets
   everything. Only the ambient hook, which nobody asked, has to earn its
   bytes.
6. **The route hook's cap moves into `BUDGETS`** (`routeHookBytes` = 1500,
   down from an unenforced local 4000), with a CI test that the worst case,
   where every rule fires at once, fits untruncated.

## Consequences

- Fewer injections on low-risk files. The ones that remain are the ones with a
  measured 2× lift over the base rate.
- The log makes the next step possible: join each decision with what happened
  to its target afterwards (a fix or revert commit within N commits, the same
  proxy label `calibrateFileHealth` uses). That gives precision for emitted
  vs held-back decisions per signal, a threshold for co-change, and a basis
  for switching off any signal that turns out to have none.
- The threshold is a club-ops number applied everywhere. A repo with a
  different defect rhythm should re-run `health-calibrate` and set
  `BRAIN_ANSWER_DANGER_MIN` accordingly, until per-repo calibration from the
  log replaces the constant.
