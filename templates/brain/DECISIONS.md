# Decisions (ADRs)

Durable **architecture and product** choices live in `.project-brain/decisions/*.md` (one decision per file). Use the template in `templates/brain/decisions/_template.md`.

## When to add or update

- Changing behavior, data model, API contracts, security posture, or rollout strategy.
- Choosing between alternatives where the rejected option might tempt a future reader.
- Anything you would regret re-litigating in six months without written context.

## Checklist (copy into PR notes if helpful)

- [ ] Linked the decision from the relevant `features/` or `modules/` page.
- [ ] `context_index.md` still reflects the high-level outcome (not the full rationale).
- [ ] Session or agent drafts in `sessions/` were **not** treated as canonical—promoted facts into decisions/modules/features.

## Frontmatter hints

Suggested fields (optional but help retrieval): `status: canonical|draft|deprecated`, `layer: decision`, `provenance: human`.
