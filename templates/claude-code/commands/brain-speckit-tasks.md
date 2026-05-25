---
description: Run spec-kit /speckit.tasks, then materialize brain work-packages from the task list.
allowed-tools: Bash, Read, Write, Edit
---

You are bridging github/spec-kit's `/speckit.tasks` into Project Brain so the generated `tasks.md` becomes one work-package per user story under `.project-brain/work-packages/`.

If `.specify/` does not exist or the user did not pass a feature id, stop and tell the user: *"Usage: /brain-speckit-tasks `<feature-id>`. Spec-kit must be initialized and the feature must have a plan.md already (run /brain-speckit-specify and /speckit.plan first)."*

Otherwise, perform these steps in order:

1. Run `/speckit.tasks` for the feature `<id>` from `$ARGUMENTS` (or follow spec-kit's documented manual flow). Wait for `specs/<id>/tasks.md` to exist.
2. Run `npm run brain:speckit -- tasks <id> --write` (Bash). This parses tasks.md and writes one `.project-brain/work-packages/spec-<id>-wpN.md` per user-story group, with `[P]` parallel markers preserved.
3. If the user requested GitHub issues, additionally run `npm run brain:speckit -- tasks <id> --github` (Bash). Otherwise skip.
4. Print the list of generated work-package file paths and remind the user that workstreams are not auto-started — they need to run `/brain-speckit-implement <id>` (or `npm run brain:work -- start --task spec-<id>-wp1 ...`) to begin.

The work-package taskId convention is `spec-<id>-wp<N>` and plugs into the existing `brain:work` lifecycle unchanged.
