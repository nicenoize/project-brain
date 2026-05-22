---
title: Fleet-mode project discovery + per-record tagging
status: canonical
layer: decision
module: indexing
feature: fleet
date: 2026-05-22
---

# Fleet-mode project discovery + per-record tagging

## Context

Until this change, project-brain indexed one repository per invocation. Real teams often work across several sibling project directories that interact at runtime (backend + workers + k8s-orchestration + frontend + shared-schemas). With one brain per repo, cross-project questions ("what consumes `order.created`?", "what does this fleet deploy?") had no single retrieval surface.

We needed an opt-in fleet mode that:

- Discovers multiple projects under one fleet root without hard-coding paths.
- Tags every indexed record with its owning project.
- Stays byte-identical for the single-project case.

## Decision

`scripts/projects.mjs` exports `discoverProjects(root)`, which walks one level deep under `root` and classifies each subdirectory by the presence of language/stack markers (`package.json`, `go.mod`, `pyproject.toml`, `Chart.yaml`, `kustomization.yaml`, `Dockerfile`, `*.proto`, `*.tf`). It returns `ProjectDescriptor[]` with `{ name, dir, kinds[], git, hasReadme }` and throws on duplicate basenames.

Activation is automatic: `isFleetMode(projects)` returns `true` when `projects.length >= 2`, unless `BRAIN_FLEET_MODE` explicitly overrides it (`0`=off, `1`=on). `BRAIN_FLEET_PROJECTS` whitelists specific names; `BRAIN_FLEET_EXCLUDE` blacklists.

`scripts/brain-index.mjs` runs the file-discovery step per-project when fleet mode is on:

```js
for (const project of projects) {
  const projFiles = await listIndexableFiles({ root: path.join(ROOT, project.dir) });
  for (const f of projFiles) projectByFile.set(path.posix.join(project.dir, f), project.name);
}
```

Every record built in the main loop now carries `project: projectByFile.get(file) || ''`. The new fields (`project`, `edgeFrom`, `edgeTo`, `edgeKind`, `edgeConfidence`, `projectKinds`) were added to `normalizeRecord` / `matchesFilter` in one schema bump, with `BRAIN_AUTO_RECOVER=1` handling Lance schema migration ([[0008-aggregate-vector-records]] style).

Symlinks that resolve to the fleet root itself or an ancestor are skipped — a `project-brain -> .` self-symlink no longer makes the host repo look like its own subproject.

## Consequences

- **Single-project mode unchanged**: `discoverProjects` returns 0 or 1 entries → fleet behavior off, existing pipelines run byte-identical.
- **`--project NAME` flag** added to `brain:search`, `brain:ask`, `brain:pack` (comma-list for OR). Records can now be filtered/boosted by owning project.
- **Cross-project records** (`repo-summary`, `cross-project-edge`, `fleet-summary`) all reuse the same `project` field, no new schema axis needed.
- **TS semantic graph** is skipped at index time in fleet mode (it assumes one tsconfig); `brain:impact --cross-project` invokes it per-project on demand.
- **First fleet index** on an existing single-project Lance table errors on schema mismatch unless `BRAIN_AUTO_RECOVER=1` is set — documented in setup.

## Related

- [[0010-cross-project-edge-detection]] — what the `project` tag enables.
- [[0011-fleet-active-state-coordination]] — workstream/lease project column.
- `scripts/projects.mjs`, `scripts/brain-index.mjs`, `scripts/store.mjs#normalizeRecord`.
