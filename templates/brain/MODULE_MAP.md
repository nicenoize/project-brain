# Module / service map (hand-maintained)

Edit this file in `.project-brain/MODULE_MAP.md` after `brain:init`. It is **not** generated: keep a short list of major surfaces (apps, packages, services) and what they depend on so agents can orient without crawling the whole tree.

| Surface / service | Role | Primary deps (internal) | Notes |
|-------------------|------|-------------------------|-------|
| _example: web app_ | User UI | `lib/auth`, `lib/api` | |
| _example: API_ | HTTP handlers | `lib/db`, `lib/billing` | |

## Conventions

- One row per deployable or major package; link to `.project-brain/modules/*.md` where detail lives.
- Prefer stable names over file paths unless the path *is* the product boundary.
- Refresh when ownership or dependency direction changes; mention significant updates in PR descriptions.
