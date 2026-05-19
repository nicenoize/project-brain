---
name: <pkg-name>
path: pkg/<pkg-name>/
owner: <handle or "shared">
status: active   # active | parking | deprecated
related_modules: []   # references to .project-brain/modules/*.md (without extension)
related_features: []  # references to .project-brain/features/*.md (without extension)
brain_task_tag: pkg-<pkg-name>
---

# pkg/<pkg-name>

One-paragraph statement of what this package owns. Anchor it to the user-facing
flow or domain concept it implements, not the file layout.

## Boundary

- **Lives in:** `pkg/<pkg-name>/**`
- **Public surface:** what other packages may import from here.
- **Forbidden imports:** packages this one must not depend on (write the rule
  here, then encode it in `.project-brain/conventions.json` so the lint hook
  enforces it).

## Conflict surface

Files most likely to collide with parallel work. List the hottest ~5; agents
should `brain:lease -- add` these before editing when another worker is active.

- `pkg/<pkg-name>/...`

## Current lane

Single sentence. What's actively in flight in this package right now. Updated
by `brain:work -- start --task pkg-<pkg-name>-…` or hand-edits; auto-pruned
when stale.

## Related ADRs

- `.project-brain/decisions/00XX-…md` — why X decision applies here.

## Retrieval hints

Set `BRAIN_TASK=pkg-<pkg-name>` in worktrees scoped to this package so search
and pack boost chunks tagged with the same task_id.
