# Default Conventions

## Git

Branch pattern:

```txt
type/kebab-case-description
type/123-kebab-case-description
```

Types:

- feature
- fix
- refactor
- chore
- docs
- test

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
