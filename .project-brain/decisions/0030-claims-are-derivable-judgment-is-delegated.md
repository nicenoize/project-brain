---
title: Claims are re-derivable, judgment is delegated — the boundary that replaces "no LLM in the hot path"
status: canonical
layer: decision
module: brain-core
feature: llm-boundary
date: 2026-08-28
---

# 0030 — Claims are re-derivable, judgment is delegated

## Context

The rule on the books is ADR 0028's "no LLM in hot path", and it has been read
— including by me, in this repo's own prose — as if it meant "no LLM". That
reading was never true. `brain:grill` has always run a language model: the
brain generates the questions deterministically and an agent answers them. Its
own header says so ("No LLM on the hot path — the question generator is pure").

The question came up as: since the brain runs as a Claude skill, should we
break the rule? The answer is that there is nothing to break. The line was
never LLM / no-LLM. It is:

> **A claim must be re-derivable. A judgment may be delegated.**

A *claim* is anything the brain asserts as fact and expects to be believed: a
danger score, an AUC, a blast radius, a lease, a coverage ratio, an exit code.
A *judgment* is answering a question, weighing a trade-off, drafting prose.
Judgment was the agent's job from the first commit.

## Why the line sits exactly there

One week of testing against foreign repositories produced eight defects, and
every one of them was a confident, well-formatted, **wrong** sentence:

- "AUC 1.00 … the calibration gate is met — the health ranking is defensible on
  this repo", from a single fixed file.
- 0 of 190 Go imports resolved, reported as a graph with no edges.
- Nine complete reports about the wrong repository, because root resolution
  climbed past a nested `.git`.
- Three dashboard panels rendering each other's data.

Not one of them was found by reading. Every one was found by **re-deriving the
number and finding it different**. That is only possible because the number is
computed the same way twice. An underpowered AUC produced by a model would have
looked exactly as plausible and been permanently unfalsifiable — there would be
nothing to disagree with.

So the constraint is not aesthetic and it is not marketing. It is the property
that makes our own defects findable.

## Decision

1. **Everything the brain asserts is re-derivable.** Same inputs, same output,
   byte for byte, with no model involved: scores, calibrations, graphs, leases,
   coverage, exit codes, and every number printed beside them. This is already
   enforced by determinism tests and by `brain:release compare`, which refuses
   to call a change better without a paired-bootstrap CI.

2. **Judgment is delegated, and delegation is not a violation.** The brain
   prepares the question, the evidence and the shape of the answer; a model
   answers. `brain:grill` is the reference implementation: pure question
   generator, agent-supplied answers, and — since the stakeholder lenses — a
   refusal to average the verdicts it receives.

3. **The hard line: nothing model-derived may feed a score, a gate, an exit
   code, or a test.** If a number can redden a build or move a ranking, it is a
   claim, and claims are computed.

4. **Inside a host that already has a model, use the host — do not call an
   API.** M5 planned `scripts/ai/copilot.mjs` behind a hosted proxy with a
   credit ledger. Running as a Claude skill, there is already a model in the
   room, paid for by the user's own subscription. Multi-perspective grilling,
   ADR drafting and handoff narrative can be *instructed* rather than
   *purchased*. This keeps the local tier genuinely free, needs no key, and
   touches no measurement.

5. **Where the exception is spent: prose, never claims.** ADR drafts from a
   diff plus grill answers, handoff narratives, reflect distillates. All behind
   an explicit invocation, none in a hook, none feeding a number.

## Consequences

- ADR 0028's "no LLM in hot path" stays true and is now stated in the form that
  explains *why*: the hot path is where claims are made.
- The `scripts/ai/` lint boundary planned in M5 stays, but its purpose is
  narrower and clearer: it keeps model-derived text out of the claim path, not
  out of the product.
- The public sentence improves. "Deterministic core" invites the question of
  what counts as the core. **"Every number this tool prints, you can re-derive"**
  is stronger, checkable, and survives contact with a skeptic.
- A tool that requires adoption before it can say anything is a recurring
  failure mode here, not a one-off — the empty lease board, the directory-name
  whitelist in the orchestrator's scope extractor, the state digest that only
  understood its own tables. Delegating judgment does not fix that; deriving
  from what is already in the repository does.
