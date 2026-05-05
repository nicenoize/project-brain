# Project Brain Architecture

Project Brain has one reusable package and many project brains.

```mermaid
flowchart TD
  Global["Global Project Brain repo<br/>/Users/seebo/Coding/project-brain"] --> Skill["Reusable skill<br/>SKILL.md"]
  Global --> Scripts["Reusable scripts<br/>brain:guard, brain:index, brain:update-skill"]
  Global --> Templates["Reusable templates<br/>PR template, GitHub workflow, Git hooks"]
  Global --> Conventions["Global conventions<br/>GitFlow, code rules, Cavemem policy"]

  App["Application repo<br/>club-ops or another app"] --> AppBrain["Project memory<br/>.project-brain/*.md"]
  App --> Link["skills/project-brain<br/>symlink/submodule/checkout"]
  Link --> Global

  AppBrain --> Index["Local generated index<br/>.project-brain/search_index.json"]
  Scripts --> Index
  Scripts --> Guard["Guard checks<br/>branch, PR target, secrets, brain files"]
  Templates --> CI["GitHub Actions<br/>fetch Project Brain + run checks"]
  Templates --> Hooks["Local Git hooks<br/>update skill after pull/checkout"]

  Cavemem["Cavemem<br/>local/session recall"] --> AppBrain
  Cavemem -. "durable facts get promoted" .-> AppBrain
```

## Source Of Truth

- Global Project Brain repo owns reusable skill code, scripts, templates, GitFlow rules, code conventions, and Cavemem policy.
- Application repos own project-specific memory under `.project-brain/`.
- Generated indexes are local caches and are never the source of truth.
- Cavemem is useful personal recall, but shared facts must be promoted into `.project-brain/*.md`.

## Consumer Repo Layout

Recommended app layout:

```txt
app-repo/
  .project-brain/
    active_state.md
    context_index.md
    product_plan.md
    repo_context.md
    decisions/
    features/
    modules/
    sessions/
  skills/
    project-brain -> ../project-brain
  .github/
    PULL_REQUEST_TEMPLATE.md
    workflows/project-brain.yml
```

`skills/project-brain` can be a symlink, Git submodule, mounted checkout, or CI checkout. It should not be a full copied fork unless the app intentionally vendors a pinned version.

## Update Flow

```mermaid
sequenceDiagram
  participant Dev as Developer
  participant App as App repo
  participant PB as Project Brain repo
  participant GH as GitHub Actions

  Dev->>App: git pull or git checkout branch
  App->>PB: npm run brain:update-skill
  PB-->>App: fast-forward only
  App->>App: setup-package refreshes scripts/templates when needed
  Dev->>App: commit / PR
  GH->>App: checkout app PR head
  GH->>PB: checkout canonical Project Brain
  GH->>App: run brain:health and brain:guard
```

The updater refuses to overwrite local Project Brain changes. Set `PROJECT_BRAIN_UPDATE_STASH=1` only when you explicitly want it to stash local changes before updating.
