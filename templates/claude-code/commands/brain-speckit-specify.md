---
description: Run spec-kit /speckit.specify, then mirror the resulting spec into Project Brain.
allowed-tools: Bash, Read, Write, Edit
---

You are bridging github/spec-kit's `/speckit.specify` flow into Project Brain so the new spec gets a corresponding `.project-brain/features/<id>.md` and is immediately indexable.

If `.specify/` does not exist in this repo, stop and tell the user: *"Spec-kit is not initialized in this repo. Run `specify init` (or install spec-kit first), then re-run this command."*

Otherwise, perform these steps in order. Treat each as required; do not skip.

1. Run `/speckit.specify $ARGUMENTS` (or, if that subcommand isn't installed in this agent, follow spec-kit's documented manual flow to create `specs/<id>/spec.md`). Confirm with the user the feature `<id>` that was created.
2. Wait for `specs/<id>/spec.md` to exist on disk.
3. Run `npm run brain:speckit -- import <id>` (Bash). This creates `.project-brain/features/<id>.md` with brain frontmatter + cross-links into the spec/plan/tasks files. The spec.md itself remains canonical.
4. Run `npm run brain:sync` (Bash) so the new spec + the brain feature doc are indexed and searchable.
5. Print a short summary: feature id, paths written, and the next command (`/brain-speckit-tasks <id>` after planning).

Always re-import after substantive `/speckit.specify` edits — the brain feature doc is intentionally derived from the spec, and the importer is idempotent.
