# Default Conventions

## Source Of Truth Layers

Project Brain has two layers:

- **Global Project Brain repo** (`project-brain`): reusable skill code, scripts, templates, GitFlow rules, guardrails, code conventions, and team-memory policy.
- **Application repo** (`.project-brain/`): project-specific product plan, architecture context, feature/module docs, decisions, active state, and handoffs.

Application repos should not fork global conventions unless they need a documented exception in `.project-brain/repo_context.md`.

## Sidecar discipline (records vs sidecars)

Durable records under `.project-brain/decisions/`, `.project-brain/findings/`, and the other structural-truth folders are **authored, human-meaningful facts**. Derived or experiential annotations that *comment on* a record — outcome reflections, learning scores, verdict overlays, staleness marks — are **not** structural truth and must never be written back into the record's own file.

The rule:

- **Record** = the durable fact. Written and edited only by the human author or the one recorder that owns that folder (e.g. `brain:adr` for `decisions/`, `brain:audit`/`findings.mjs` for `findings/`). A record's content is the source of truth; a rebuild of the index must be able to reproduce everything downstream from it.
- **Sidecar** = a derived/experiential annotation stored in a **separate file beside the record** (e.g. `0007-foo.md` → `0007-foo.reflect.json`, or a folder-level `.brain_learning.json`), merged with the record only at read time. Sidecars are regenerable and never authoritative — losing one costs nothing structural.

Why: this is the record-level form of the existing "generated indexes are never authoritative" layer rule. If a feedback/learning/reflect process mutated the record itself, a re-index or a diff would blur what a human decided against what a tool inferred, and two agents annotating in parallel would clobber each other's edits. Keeping annotations in sidecars keeps structural truth diff-clean and merge-safe.

Practical guidance for new scripts:

- Only a folder's **own recorder** may create or rewrite files under that folder. Every other script that wants to attach information writes a sibling sidecar file and leaves the record byte-for-byte untouched.
- Read-time merge belongs in the consumer (search/pack/reflect readers), not at write time.
- The optional `brain:lint-conventions --sidecars` scan flags scripts that write under `decisions/`/`findings/` from outside the allowlisted recorders — wire it into CI once the reflect epic lands.

## Git

Branch pattern:

```txt
type/123-kebab-case-description
release/2026-05-05
hotfix/123-kebab-case-description
```

Types:

- feature
- fix
- refactor
- chore
- docs
- test
- release
- hotfix

GitFlow:

- `main` is protected production/release.
- `develop` is protected integration.
- Feature/fix/refactor/chore/docs/test branches start from `develop` and target `develop`.
- Release branches target `main`.
- Hotfix branches start from `main` and must be merged back into `develop`.
- Non-trivial work requires a GitHub issue.
- PRs close issues with `Closes #123` or `Fixes #123`.

Commit format:

```txt
type(scope): short description
```

Allowed commit types:

- feat
- fix
- refactor
- chore
- docs
- test

## Web App / Next.js Defaults

- TypeScript-first.
- Keep server-only logic out of client components.
- Keep environment parsing centralized.
- Avoid `any`; use explicit domain types at module boundaries.
- Prefer cohesive modules over deep generic folder nesting.
- Avoid TODO/FIXME in committed code unless tracked in the brain or issue tracker.

## Team Memory

- Project Brain Markdown is the shared source of truth.
- Cavemem is optional local/session memory for each developer.
- Durable facts discovered via Cavemem must be promoted into `.project-brain/*.md`.
- Do not store secrets, `.env*`, private customer data, generated indexes, build output, or dependencies in Cavemem.

## Retrieval maintenance

- After pulls or branch switches, installed hooks run `brain:update-skill` and `brain:maintain --hook` so the local index can catch deleted files and hash drift.
- For CI-quality gates, commit `.project-brain/eval.json` (see `templates/brain/eval.json`) and let the Project Brain workflow run `brain:maintain --ci` before `brain:guard`.
- Ranking and embedding behavior still follow `scripts/retrieval.mjs` and embedder config; extend `eval.json` when you find repeatable retrieval misses.
- Before **Cursor context compaction** or when switching terminal agents, run **`npm run brain:compact`** (or install Cursor hooks so it runs automatically); set `BRAIN_TOOL` to `cursor`, `claude`, `gemini`, or `codex` per session.

## Multi-tool and multi-agent coordination

- Use a stable **task id** per parallel workstream (issue slug, feature name, or orchestrator run id).
- Start session handoffs with `brain:session -- start --task … --actor … --tool …` so Cursor, Claude, Gemini, and humans can each have a distinct session file on the same branch.
- For **parallel work on different branches** (e.g. multiple Cursor windows, Claude Code, Codex, or Gemini sessions), use `npm run brain:worktree -- spawn --count N [--tool …] …` so each worker gets its own checkout and branch; run `brain:session` **inside** that worktree with the suggested per-worker `--task`, `<tool>-worker-N` actor, and matching `--tool` (see **`BRAIN_WORKTREE_TOOL`** for a default).
- Prefer **one merge point** for `active_state.md`; use the leases / workstreams tables and `.project-brain/sessions/` for concurrent edits.
- When packing context for a specific stream, set `BRAIN_TASK` / `BRAIN_ACTOR` or pass `--task` / `--actor` to `brain:pack` / `brain:ask` / `brain:search`.

## Token budget & code minimalism

Two independent levers — one on **how agents talk**, one on **how much code they write**. They compose; neither replaces the other.

**Communication compression — Caveman** (affects wording only):

- Use Caveman `$caveman ultra` for internal agent progress, handoffs, investigation notes, and review notes when available.
- Keep user-facing summaries concise but clear enough to preserve order, risk, and decisions.
- Disable compression for destructive confirmations, security warnings, or places where terse wording becomes ambiguous.

**Code minimalism — ponytail** (affects generated code): apply the "lazy senior developer" ladder before writing anything new — does it need to exist (YAGNI) → does stdlib handle it → is there a native platform feature → is it already an installed dependency → can it be one line → only then write the minimum. `ponytail@ponytail` is declared alongside caveman in `settings.community-plugins.json` and merges only on explicit opt-in: `PROJECT_BRAIN_COMMUNITY_PLUGINS=1 npm run brain:update-skill` (or `--community-plugins`) — a plain sync never enables third-party code silently (decisions/0028; audit marketplaces with `brain:skill-audit` first). Manual install (`/plugin marketplace add DietrichGebert/ponytail` then `/plugin install ponytail@ponytail`) still applies for hosts outside that flow (Codex, Copilot CLI, etc. — see the tool's own README). This operationalizes at write-time the YAGNI/KISS/DRY + "no duplicate helpers" the brain already asserts (CONTRIBUTING.md, `.project-brain/conventions.json`). ponytail *prevents* over-engineering at write-time; `brain:audit` *detects* tech-debt at audit-time — together they close the loop.

> Glossary (these three are easy to confuse): **Caveman** = communication compression (terse output). **Cavemem** = optional local/session memory tool. **ponytail** = code-generation minimalism. Caveman and ponytail are orthogonal — use both.
