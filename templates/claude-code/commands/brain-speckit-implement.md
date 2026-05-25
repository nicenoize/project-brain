---
description: Start a brain workstream for the next spec-kit work-package and run /speckit.implement scoped to that task.
allowed-tools: Bash, Read, Write, Edit
---

You are bridging github/spec-kit's `/speckit.implement` flow into Project Brain's multi-actor coordination. Each spec-kit work-package becomes a brain workstream with its own branch, leases, and resume pack.

If `.specify/` does not exist or `.project-brain/work-packages/spec-<id>-wp*.md` files don't exist for the requested feature, stop and tell the user: *"Run /brain-speckit-tasks `<feature-id>` first to materialize work-packages."*

Otherwise, perform these steps in order:

1. List the available work-packages: `ls .project-brain/work-packages/spec-<id>-wp*.md` (Bash). Pick the first one whose corresponding workstream is not already active (check via `npm run brain:work -- status`).
2. Read that work-package file to extract: the `Task ID` (e.g. `spec-<id>-wp1`), the `Branch` line, the `Actor/tool` line.
3. Run `npm run brain:work -- start --task <Task ID> --actor <actor> --tool <tool>` (Bash). This creates the branch, adds the workstream row to active_state.md, and writes the initial resume pack to stdout.
4. Run `/speckit.implement` scoped to the specific tasks listed in this work-package (the `## Spec-kit tasks` section). Iterate through them in order, respecting `[P]` parallel markers as you would in a normal spec-kit session.
5. When the work-package is complete, run `npm run brain:work -- end --task <Task ID>` (Bash) to mark the workstream done and release its leases.

If the user is on a fleet (multiple sibling projects), include `--project <name>` on the `brain:work start` call. The project is encoded in the work-package's metadata if `brain:speckit tasks` was run inside a fleet.
