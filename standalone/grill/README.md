# grill

Make your coding agent defend its plan **before** it writes a line of code.

`/grill` turns the agent into a skeptical senior reviewer. It grounds itself in *your* repo — git history, co-change patterns, test coverage, ADRs and docs — generates 5–9 adversarial questions about the plan, and then has to **answer them honestly with evidence** (file paths, commits, test names) before implementing. Unanswerable questions become explicit open risks instead of silent assumptions. If the plan survives, it says so plainly and gets to work.

## Example

> **You:** Grill this plan: move session handling out of `routes/` into a new `middleware/auth.ts`.
>
> **Agent:** *Test Evidence:* no test file references `session.ts` — a regression here goes uncaught; smallest fix is a session round-trip test first. *Hidden Coupling:* `session.ts` co-changed with `routes/login.ts` in 14 of its last 20 commits, but the plan never mentions `routes/login.ts` — oversight or deliberate?
>
> **You:** ...oversight, honestly.
>
> **Agent:** Verdict: **revise** — add `routes/login.ts` to the plan and land the regression test before the move. Everything else defended; the middleware split itself is sound.

## The six question categories

**Blast Radius** (what breaks downstream?) · **Prior Decisions** (does a documented decision forbid this?) · **Test Evidence** (which existing test catches a regression?) · **Simpler Alternative** (what's the boring version?) · **Rollback** (how do we undo this cleanly?) · **Hidden Coupling** (which file usually changes together with these?)

## Install

With the [`skills` CLI](https://github.com/vercel-labs/skills):

```sh
npx skills add https://github.com/nicenoize/project-brain/tree/main/standalone/grill
```

Or select it from the repo by name:

```sh
npx skills add nicenoize/project-brain --skill grill
```

Or manually — copy this directory into your skills folder:

```sh
git clone --depth 1 https://github.com/nicenoize/project-brain /tmp/pb &&
  mkdir -p ~/.claude/skills && cp -r /tmp/pb/standalone/grill ~/.claude/skills/grill
```

Then invoke it with `/grill` or just ask: *"grill this plan."*

No dependencies, no configuration, no index, no server — it's a pure prompt skill (a single `SKILL.md`). It works in any git repo; without git history it degrades gracefully to the generic questions.

## License

MIT — see [LICENSE](./LICENSE).

---

Extracted from [Project Brain](https://github.com/nicenoize/project-brain) — the shared work-state layer for parallel coding agents.
