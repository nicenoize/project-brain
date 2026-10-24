# leanlamp companion (working name)

The companion shows the agents on this machine where the eye already is. On a
MacBook with a notch it is an island around the notch: eight segments and the
context of the fullest live session on the left ear, how many sessions are
live or waiting for you on the right. Click the island (or press ⎋ to fold
it) and a black rectangle unfolds with every live session. On displays without
a notch, the menu-bar glyph carries the same gauge and the app menu.

Direction D "Flutlicht": black, white, one orange (#ff5a1f), zero radius.

On first launch the island says hello once, under the notch, for 20 s: how
many sessions it sees, that a click or ⌥⌘L opens them, and Connect… for steer
and hold. It never comes back (`LEANLAMP_WELCOME=1` shows it again for
screenshots), and anything with something to say (a held edit, memory, news)
goes first. Without a notch (external display, clamshell, older Macs) the
window opens once instead, since a bar manager may hide the menu-bar glyph.
`LEANLAMP_NO_NOTCH=1` makes a notch Mac behave like one without, for tests.

## The CLI

`bin/leanlamp.mjs` (package bin `leanlamp`) carries the eight verbs of the
plan; every other brain command stays reachable as `leanlamp x <name>`:

```bash
leanlamp init [--dry-run]       # companion hook + compaction mark (300k) for this repo
leanlamp init --check           # is it all in place and working? read-only, exit 1 on a ✗
leanlamp init --undo [--dry-run] # put back every settings change leanlamp made
leanlamp open [--rebuild]       # the app; built for this Mac on first use (below)
leanlamp status                 # one screen: sessions, context, machine, holds
leanlamp recall <terms>         # what the agent dropped
leanlamp steer <session> "…"    # a note at the next tool call
leanlamp hold "src/**" --for 2h # edits wait for you (hold release --all, approve, deny)
leanlamp compact --at 300k      # where this repo's sessions compact (yours; --shared: the team's file)
leanlamp receipt                # the last 14 days
```

`compact` sets the mark Claude Code reads at session start
(`CLAUDE_CODE_AUTO_COMPACT_WINDOW`), in your own `.claude/settings.local.json`
unless you say `--shared`; it reports the mark that actually wins (local over
project over user) and keeps backups in `~/.project-brain/backups`. There is
no way to make a running session compact from outside.

Every settings file leanlamp writes outside its own folder (the hook in
Claude's settings, a compaction mark in a repo) is recorded in
`~/.project-brain/companion/changes.jsonl`. `leanlamp init --undo` reads it
and puts back exactly that: the hook leaves each file it went into, a mark
returns to the value it replaced, a file leanlamp created and left empty is
removed. A value someone changed since stays, and the command says so (exit 1).
Backups of every file it touches go to `~/.project-brain/backups`.

## Install

The package carries the app's sources, not a binary: `leanlamp open` builds
it on first use with Apple's Command Line Tools (`xcode-select --install` if
`swift` is missing), about 45 s, into `~/.project-brain/app` (`BRAIN_HOME`
moves it), then opens it. What stays is the 3 MB app and a `build.json` with
the package version and engine path it was built for; SwiftPM's ~140 MB of
build files are removed. The next `open` takes 0.03 s; an upgrade or a moved
install rebuilds once. Nothing is downloaded, so nothing needs notarising.
A checkout with `companion/build/Leanlamp.app` (from `scripts/bundle.sh`)
opens that one instead.

## Run it

```bash
cd companion
swift build                  # Command Line Tools are enough; ~30 s the first time
swift run leanlamp           # or .build/debug/leanlamp
swift run leanlamp-selftest  # the core checks (gauge, notch geometry, state, toasts)

scripts/bundle.sh            # → build/Leanlamp.app: release build, icon, fonts, ad-hoc signed
scripts/demo.sh              # → build/leanlamp-demo.mp4 + .gif, the ten-second demo
open build/Leanlamp.app      # menu ▸ Open at login puts it into Login Items
```

The bundle knows this checkout's engine path (Info.plist `LeanlampEngine`), so
it can live anywhere; rebuild it after moving the repo. Fonts are Doto,
JetBrains Mono and Bricolage Grotesque (SIL Open Font License, texts next to
the files), registered for the app's process only.

The app starts the engine itself when nothing is writing the state file:

```bash
npm run brain:companion -- --watch    # the same engine, by hand (1 s ticks)
npm run brain:companion               # the state once, as text; --json for JSON
```

State file: `~/.project-brain/companion/state.json` (`BRAIN_HOME` moves the
directory, `BRAIN_COMPANION_STATE` the file). Engine script lookup for the
app: `LEANLAMP_ENGINE`, else the path `bundle.sh` wrote into Info.plist,
else `scripts/brain-companion.mjs` in the repo this binary was built in.
`node` does not have to be on the app's `PATH` (a Finder or login launch has
almost none): `LEANLAMP_NODE`, else the node `bundle.sh` found, else
Homebrew, `/usr/local`, nvm (newest), Volta, asdf. If no engine writes the
state file, whoever started the last one, the app starts its own (at most
three times in ten minutes). The engine stops with the app (it watches the
app's pid).

The ears say STARTING until the engine's first pass is on disk (under a
second: it reads the last megabyte of each live transcript first), and
ENGINE OFF if nothing arrives within 30 s; after that every tick reads only
appended bytes. `LEANLAMP_START_EXPANDED=1` opens the wall at launch,
for screenshots and demos.

## How it is wired

```
Claude Code transcripts ──tail──▶ brain-companion.mjs ──state.json──▶ leanlamp
      (every config dir            one engine, 1 s                   island · glyph
       a running session uses)      per machine (pid file)           SwiftUI in an NSPanel
```

- The app never reads a transcript, never runs `ps`, never touches an agent.
  Everything it shows is in the state file; the contract is
  `Sources/LeanlampCore/CompanionState.swift` (STATE_VERSION 1).
- Geometry is read from `NSScreen` at launch and on every display change
  (`NotchLayout`). On this 14-inch MacBook Pro: 1512 × 982 pt, notch 185 × 32,
  menu bar 37/38, island 465 × 38, panel 640 wide.
- The panel is borderless and non-activating (a click never steals focus from
  the terminal), above the menu bar, on every Space and over fullscreen apps.

## Not looking at the notch

When an edit waits for you and your pointer is on another display (an
external monitor, clamshell, a Mac without a notch), the same orange line
appears top right on that display, with the countdown and Approve / Deny. It
is gone the moment you answer. The menu-bar glyph turns orange and counts
what waits. News (steer delivered, compactions) stays on the island.

## Two interruptions, no more

Only two things ever turn the island orange on their own: an edit waiting
for your answer, and memory pressure. Memory speaks when the kernel says
critical, or when it says warn and something of ours can give memory back:
helpers (MCP servers, headless browsers, dev servers) whose agent is gone.
Reclaim stops exactly those (`brain:companion -- reclaim`, `--dry-run` to
look first); sessions and docker stacks stay your call (`brain:ps`). Later
keeps the same warning away for an hour.

## The window

`Open ↗` in the wall, or the menu (⌘O, ⌘R for the receipt), opens the full
window: **Sessions** (every session of the last four hours, large, with
steer), **Receipt** (the last 14 days from your own transcripts: median and
p90 context per request, input spent above 500k, compactions and how many
were prepared in advance, per project next to its compaction mark; edits
held, approved, declined; notes delivered and how long they waited; and
**GOT**: every snippet a hook put in front of the agent, read back from the
transcripts, and how often the agent ran the brain command a snippet named
within its next five tool calls), and
**Machine** (memory pressure, agent processes, orphans, holds). In
**Sessions**, `Got n` opens what that agent got: source, hook event, the text,
and IGNORED or RAN <command>. The engine
recomputes the receipt hourly in a niced child (about 10 s and 360 MB peak
for 2 GB of transcripts); `npm run brain:companion -- receipt` prints it.

## Reaching the agents: steer, hold, approve

Monitoring needs nothing. Acting on a session needs one hook in your Claude
settings, once. In the app: `Connect` in the wall (or the menu ▸ Connect to
agents…) asks first, names the settings files it will change, and adds it
on your yes; asking again offers Disconnect. From the terminal:

```bash
npm run brain:companion -- install-hooks --dry-run   # shows which settings files it would touch
npm run brain:companion -- install-hooks             # adds it (backups in ~/.project-brain/backups)
npm run brain:companion -- uninstall-hooks           # takes it out again
npm run brain:companion -- check                     # node, engine, hook per settings file, reach, formats, mark, hook time, app
```

It goes into the user settings of every config dir a running session uses,
so it reaches every session on the machine; sessions pick it up at their next
start. The wall marks sessions without it as MONITOR.

- **Steer.** Click a session in the wall, type a note, Enter. It lands at the
  agent's next tool call as context ("Note from the user…"). CLI:
  `brain:companion -- steer <session> "<note>"`.
- **Hold.** `Hold all edits` in the wall, or `brain:companion -- hold
  "src/billing/**" [--for 2h]` in a repo. A hold covers every worktree of
  that repository, including worktrees made after it (the engine re-reads
  `git worktree list` every 30 s): two agents in two checkouts of one repo
  are held alike. Edits under a held glob wait: the
  island turns orange, Approve / Deny hang under the notch with a countdown.
  No answer in 45 s, or no engine running: Claude Code asks in the terminal
  as usual. A hold can never wedge a session. Bash writes are not held.
- **Approve / deny** from the notch, or `brain:companion -- approve|deny <id>`.
  Every answer is an event with who gave it (notch or terminal).

A hook call takes about 27 ms per tool call on an M-series Mac, and nearly
all of it is Node starting: an empty script takes ~24 ms, leanlamp adds
2–4 ms, the decision itself 0.03 ms. `check` measures it on your machine
against a scratch bus and says when the machine is too busy for the number
to mean anything. No `node:crypto` on that path: loading it alone cost ~2 ms.
(Claude Code times every hook itself, in the transcript: the brain's own
hooks measure 54 ms for the Bash/Read nudge and 363 ms for the answer before
an edit, median over 14 days on the same machine.)

Verified against Claude Code 2.1.308 in headless runs (2026-10-22, an
isolated repo and settings file, the smallest model, under a cent each): a
note queued before the run arrives with the prompt, a note queued mid-run
arrives at the next tool call and is followed; a held Write waits, is
approved from the CLI and then executed; a denied Write is not written, the
agent gets the reason and does not work around it.

## Not there yet

Notarization (needs a Developer ID), other agents (Codex, Gemini, Cursor),
sound and haptics.
`swift test` needs Xcode's XCTest; `leanlamp-selftest` runs the same checks
without it. `LEANLAMP_PIN=1` keeps the wall open on outside clicks (demos).
`Leanlamp --render-wall wall.png` draws the open wall with the demo's
sessions offscreen (nothing of the screen in it).

## Today, and what fills a context

Under the wall's header, live since local midnight: the tokens in all live
contexts now, how many compactions were prepared (3/4), the seconds spent
waiting on the others, notes delivered, edits held and how they were
answered. Compactions come from the main sessions' transcripts (subagents
left out, as in the receipt), the rest from the event log; on a very long
transcript only its tail is read, so an early compaction can be missing
(too low, never too high).

Open a session to steer it and its context map draws in above the field:
what fills the window since the last compaction. The base (system prompt,
tools, CLAUDE.md) is measured at the session's first request; the parts
(command output, file reads, the agent's writing, MCP and web results, hook
notes, the compaction summary) are estimated from the transcript, which runs
about 2× low on code, and scaled to the real context, factor shown
(`est. ×1.9`). When one part the agent controls is a quarter of the context
or more it turns orange with a note to steer with; **Use as note** puts it in
the field. Without a measured base the parts stay raw and unscaled.

## Keyboard and accessibility

⌥⌘L opens or folds the wall from anywhere (the window on Macs without a
notch); ⎋ folds it. Opened that way the wall has the keyboard, and the whole
loop works without the mouse:

| key | does |
|---|---|
| ↑ ↓ (or k j), 1–9 | move the cursor over the sessions |
| ⏎ | steer the session under the cursor (⏎ again sends, ⎋ closes) |
| A / D | approve / deny the oldest held edit |
| H | hold all edits, or release them |
| O | open the window |

A wall opened by dwelling takes no keyboard, so typing in the terminal is
never caught. The island, toasts and session rows speak to VoiceOver
in sentences ("leanlamp. 2 live sessions. fullest: Billing refactor, 211k
of 300k context. needs you: …"), buttons are real buttons. With Reduce
motion on, nothing blinks or slides: state changes land in place. Small
text is at least 6:1 against black (WCAG AA asks 4.5:1).

## Feel

Dwelling 400 ms on the notch opens the wall; a wall opened that way folds
when the pointer has left it for 0.8 s, a click inside keeps it open. The
engine shows the first state within about 0.1 s: it reads the last 1 MB of
each transcript first and the rest in the background (32 MB per tick) for
exact totals.
