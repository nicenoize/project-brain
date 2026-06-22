# Vision: the Constellation (federated brains) and the trust axis

> Status: direction + first primitive. The federation transport is not built; the
> trust primitive it depends on (`brain:skill-audit`) is. See
> `decisions/0016-ecosystem-skill-axis-map.md`.

## The direction

Today a Project Brain is per-fleet: one brain user, sibling repos under a fleet root
(see [`solo-multi-repo-setup.md`](solo-multi-repo-setup.md)). The **Constellation** is
the next horizon — many brains, owned by different people, **federating over Git**:
pulling each other's durable knowledge (decisions, module summaries, cross-project
edges) and **sharing skills** (the `brain:*` commands, plus third-party agent skills)
across a peer network instead of one machine.

## Why trust is structural, not optional

A single-user fleet can trust everything it indexes — you wrote it. A federation
cannot. The moment a brain pulls a skill or a knowledge fragment from a peer, it is
**executing or acting on code and claims it did not author**. Agent skills are
executable (scripts, hooks, MCP wiring); research shows a meaningful fraction of
public skills carry vulnerabilities or outright malicious patterns. So federation is
gated on a **verify-before-trust** step: nothing crosses the boundary into your brain
without being scanned and scored first.

This is the **trust axis** of the "brain smarter" framing (recall / structure / trust
/ act). It is the one axis that *must* exist before federation can — you can defer
recall and structure improvements, but you cannot safely federate untrusted artifacts.

## The first concrete primitive: `brain:skill-audit`

`brain:skill-audit <path|url>` is the trust axis made real today. It shells out to
[NVIDIA/skillspector](https://github.com/NVIDIA/skillspector) (an agent-skill security
scanner) to produce a 0-100 risk score + severity + recommendation, and gates adoption
on it (`--max-risk`, default 40).

- **Today** it vets skills you adopt from the open ecosystem (caveman, drawio-skill,
  ponytail, improve, …) before you install them. Eat the dogfood: scan a skill before
  trusting it.
- **Tomorrow** the same scan is the admission check at the federation edge — every
  skill or brain fragment entering your constellation gets a risk score before it is
  trusted. The risk score becomes the "trust score at the boundary."

### Deliberately optional, never vendored

skillspector is Python/LangGraph/YARA. The brain stays Node-only with a tiny
dependency surface, so we **never vendor it or add a Python toolchain**. `brain:skill-audit`
shells out to the scanner only if the developer has it (native CLI, `BRAIN_SKILLSPECTOR_BIN`,
or Docker via `BRAIN_SKILLSPECTOR_DOCKER=1` — no local Python). Absent → the audit is a
clear no-op skip, exactly how `brain:guard` treats gitleaks/semgrep. This mirrors the
brain's house rule: optional heavy tools degrade gracefully; the core install never grows.

## What is NOT built yet

The federation transport itself — discovery of peer brains, pull/merge of remote
knowledge, conflict handling, identity/signing — is future work. This doc records the
direction and the one primitive that has to come first. When the transport lands, it
will call `brain:skill-audit` (and a brain-fragment analogue) at the boundary.
