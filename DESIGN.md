---
name: Control Room
description: Andon production board for the project-brain Operate surface — work is a T-card in a rail, state is a lamp.
colors:
  panel: "#e9e7e1"
  rail: "#dcd9d1"
  rail-edge: "#c9c5bb"
  card: "#f7f6f2"
  card-edge: "#d5d2c9"
  ink: "#26282b"
  ink-secondary: "#5c5f63"
  ink-tertiary: "#6b6e72"
  hairline: "#c5c2b9"
  lamp-run: "#2e7d43"
  lamp-attn: "#b97f16"
  lamp-attn-ink: "#8a5f0f"
  lamp-stop: "#c0392b"
  lamp-idle: "#9a9d9f"
  signal: "#2b5d8f"
  signal-ink: "#ffffff"
typography:
  headline:
    fontFamily: "B612, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    letterSpacing: "0.14em"
  title:
    fontFamily: "B612, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 700
  body:
    fontFamily: "B612, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "B612 Mono, ui-monospace, monospace"
    fontSize: "10.5px"
    fontWeight: 400
    letterSpacing: "0.06em"
  # Instrument data steps — the mono readout sizes the shipped build uses.
  # This is a dense Operate surface: data text spans 9.5–12.5px deliberately
  # (finish review shipped these; contrast holds ≥4.5:1 via --ink-2/--ink-3).
  data:
    fontFamily: "B612 Mono, ui-monospace, monospace"
    fontSize: "12px"
  dataSmall:
    fontFamily: "B612 Mono, ui-monospace, monospace"
    fontSize: "11.5px"
  caption:
    fontFamily: "B612 Mono, ui-monospace, monospace"
    fontSize: "11px"
  micro:
    fontFamily: "B612 Mono, ui-monospace, monospace"
    fontSize: "9.5px"
    letterSpacing: "0.08em"
  action:
    fontFamily: "B612, system-ui, sans-serif"
    fontSize: "12.5px"
  emptyState:
    fontFamily: "B612, system-ui, sans-serif"
    fontSize: "13px"
  # The one large numeral on the board: the answer-panel score (0-10).
  # Single sanctioned display size; colored only by its lamp band.
  score:
    fontFamily: "B612, system-ui, sans-serif"
    fontSize: "34px"
    fontWeight: 700
rounded:
  chip: "2px"
  card: "3px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "18px"
  xl: "22px"
components:
  chip-state:
    textColor: "{colors.lamp-run}"
    typography: "{typography.label}"
    rounded: "{rounded.chip}"
    padding: "1px 6px 2px"
  t-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "8px 12px"
  rail-row:
    backgroundColor: "{colors.rail}"
    rounded: "{rounded.card}"
    padding: "8px 10px"
  sheet:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.card}"
    padding: "12px 14px"
  density-button:
    backgroundColor: "transparent"
    textColor: "{colors.ink-secondary}"
    typography: "{typography.label}"
    padding: "3px 10px"
  density-button-active:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.signal-ink}"
  provenance:
    textColor: "{colors.ink-tertiary}"
    typography: "{typography.label}"
---

# Design System: Control Room

## Overview

**Creative North Star: "The Andon Board"**

The Control Room is a physical production board rendered on screen, not a dashboard. Work is a T-card hanging in a slotted rail; state is a lamp at the card's head; a conflict pulls the whole row's red light. It deliberately refuses the category default — near-black panel, one neon accent, a grid of stat cards — in favor of warm workshop materials: card stock pinned to a panel in light mode, a graphite board under workshop light in dark mode. Both themes are first-class and follow the system via `prefers-color-scheme`; there is no theme toggle.

Density is the personality: microtype in a cockpit-instrument face (B612), hairline rules, stamped chips, small soft shadows. Structure comes from rails and hairlines, never from a grid of same-size cards. Color is almost entirely reserved for meaning — three andon lamp hues carry state, one signal blue carries interaction, and everything else is warm-grey material.

**Key Characteristics:**
- Warm panel greys as material (card stock / graphite), never pure white or pure black
- Three lamp colors reserved for state only; one blue reserved for interaction only
- State re-lights the row (a tinted wash), not just the badge
- Mono microtype (B612 Mono) for every number, timestamp, path, and label
- Every measured block ends in a provenance footer; every risk carries an action line
- One density control (`packet` / `deployed`) moves every panel at once

## Colors

A warm-grey material world where the only saturated color is meaning: three andon lamps for state, one blue for interaction.

### Primary
- **Signal Blue** (#2b5d8f light / #6ea3d8 dark): the single interaction accent. Buttons in their active state, links, focus rings, caret, text selection, and the row-target flash. It is never a state color and never decoration.

### Secondary — the andon lamps (state only)
- **Run Green** (#2e7d43 / #4caf6e): work in flight. Lamp dot, RUN chip, run row wash.
- **Attention Amber** (#b97f16 / #d99a2b): needs a look. Lamp dot and attn row wash keep the brighter hue.
- **Text-Safe Amber** (#8a5f0f light; falls back to the lamp hue in dark): amber rendered as text — chips, expiring TTLs, the stale freshness note — darkened for legibility on light card stock.
- **Stop Red** (#c0392b / #e05545): blocked or in conflict. Lamp, STOP chip, red row wash, expired TTLs, error notes, and the leased-cell outline in the treemap.
- **Idle Grey** (#9a9d9f / #6f7275): the unlit lamp.

### Neutral
- **Panel** (#e9e7e1 / #232528): the board ground; the page background.
- **Rail** (#dcd9d1 / #1c1e21): the slotted strip a row of cards hangs in; also the masthead ground.
- **Rail Edge** (#c9c5bb / #141517): rail borders, the density control frame, scrollbar thumbs.
- **Card** (#f7f6f2 / #2e3134) with **Card Edge** (#d5d2c9 / #3c3f43): T-card stock and sheet surfaces.
- **Ink** (#26282b / #e8e7e2), **Ink-2** (#5c5f63 / #b0b0aa), **Ink-3** (#6b6e72 / #9c9c96): three-step text hierarchy — primary, secondary/meta, tertiary/labels.
- **Hairline** (#c5c2b9 / #3e4145): table rules and the provenance top border; interior row rules use it at 45% opacity via `color-mix`.

State washes are derived, not standalone tokens: `color-mix(in srgb, var(--lamp-*) 7–12%, transparent)` layered over the rail.

### Named Rules
**The Lamp Rule.** Green, amber, and red exist only to say run / attention / stop. They never brand, never decorate, never highlight a heading.

**The One Signal Rule.** Signal blue is the only color that means "you can act here." It is never used to convey state, and no second interaction accent exists.

**The Text-Safe Amber Rule.** Amber as a lamp dot or wash keeps the bright hue; amber as text uses `--lamp-attn-ink` so it stays legible on light card stock.

## Typography

**UI Font:** B612 (with system-ui) — a cockpit-instrument face, self-hosted at 400/700
**Data/Mono Font:** B612 Mono (with ui-monospace) — every number, path, timestamp, chip, and column header
**Character:** Instrument-panel microtype: small, dense, high-clarity, unglamorous. There is no display scale; the largest text on the surface is the 15px wordmark.

### Hierarchy
- **Headline / wordmark** (700, 15px, uppercase, 0.14em tracking): the masthead wordmark only, with a 9.5px mono sub-line beneath it.
- **Section label** (700, 12px, uppercase, 0.12em tracking, Ink-2): bay headings (`h2`) that name each board section.
- **Title** (700, 13px): the task name on a T-card; record summary lines.
- **Body** (400, 14px, 1.45): base prose, empty-state teaching text, action lines (12.5px).
- **Label / data** (B612 Mono, 10–12px, uppercase where labelling, 0.05–0.08em tracking): chips, table headers, TTLs, feed timestamps, provenance, meta lines. Numbers always get `.num` — tabular figures in the mono face.

### Named Rules
**The Mono Data Rule.** If it is measured — a number, a time, a path, an id, a verb in the audit feed — it is set in B612 Mono. Prose stays in B612.

## Layout

A two-row shell: a rail-colored masthead strip (wordmark, repo path, freshness, density control) over a scrolling floor. The floor is a two-column grid — the board bay at `minmax(0, 1fr)` and a fixed 340px right column stacking the Lease board and Audit feed — with 22px gutters and 18–20px floor padding. Below 980px the right column drops under the board; below 720px the repo path hides, the density control moves to the right edge, and sheet tables switch to fixed layout with the first column at 58%.

Rhythm is tight and even: 8px gaps inside rows, 10px rail padding, 12–14px sheet padding, 18px between sheets, 22px above section labels. The density control's `compact` mode shrinks the same structure everywhere at once — card padding drops to 4px, meta lines hide, feed and record rows tighten, the treemap shrinks to 150px.

**The One Density Rule.** There is exactly one density control and it moves every panel. No panel grows its own compact toggle.

## Elevation & Depth

Depth is mostly material, not shadow: rails sit visibly lower than the cards hanging in them via tone (rail vs. card grey) and 1px edges. Two small soft shadows exist, both layered two-stop values:

### Shadow Vocabulary
- **Card** (`0 1px 2px rgba(38,40,43,0.14), 0 2px 6px rgba(38,40,43,0.08)`; deeper blacks in dark theme): the resting T-card and sheet lift off the rail.
- **Lift** (`0 2px 4px rgba(38,40,43,0.16), 0 6px 16px rgba(38,40,43,0.12)`): reserved for the pulled state — a stop-washed row's card rises slightly.

### Named Rules
**The Pulled-Card Rule.** Extra elevation is a state response: only a blocked/conflict row earns the lift shadow. Nothing floats for decoration.

## Shapes

Near-square: 3px radius on cards, rails, sheets, and the treemap; 2px on chips and the density control. Chips are "stamped, not pill" — a 1px `currentColor` border punched around uppercase mono text. Lamps are the only circles (9px dots with a subtle inset shadow suggesting a physical lens). Borders are 1px everywhere; interior table rules are hairlines at 45% opacity. Icons are tiny inline-SVG masks (disclosure chevron, action arrow) tinted via `background` + `mask`, so they inherit token colors — no icon font, no glyph characters.

## Components

### T-card in a rail row
The signature unit. A rail row (`--rail` ground, 1px rail-edge border, 3px radius, 8×10px padding) holds a lamp dot and a card (`--card`, card-edge border, card shadow, 8×12px padding) carrying the bold 13px task name, a state chip, and an 11px mono meta line (actor in full ink). State washes the row: a 7–12% lamp-color tint layered over the rail (`wash-run` / `wash-attn` / `wash-stop`); stop rows also lift the card's shadow.

### Lamp
9px circle, idle grey by default, filled with the state lamp color; `inset 0 -1px 1px rgba(0,0,0,.25)` gives it a lens. Always `aria-hidden`; the chip carries the text.

### Chip (state)
Uppercase 10.5px mono, 0.06em tracking, 1px `currentColor` border, 2px radius, `1px 6px 2px` padding. Color = state (attn uses text-safe amber; idle uses Ink-3). Never filled.

### Sheet (tables: leases, intel, audit)
A card-surfaced panel (12×14px padding, card shadow). Column headers are 10.5px uppercase mono in Ink-3 over a full hairline; body rows separate with 45%-opacity hairlines; last row borderless. Paths render in 12px mono. Conflict lease rows take the stop wash across their cells. TTLs: mono, text-safe amber when expiring, stop red when expired.

### Density control
A bordered two-segment switch in the masthead: 11px uppercase mono buttons, transparent at rest (Ink-2, ink on hover), signal blue with signal-ink text when `aria-pressed`.

### Treemap (Intel)
Absolutely positioned rail-grey cells with panel-colored 1px gaps, 10px mono labels. Only leased cells act: pointer cursor, `brightness(1.08)` hover, and an inset 2px stop-red outline; clicking anchors to the matching lease row, which flashes a 14% signal tint (`.row-target`). Unleased cells are readout, not control.

### Records (read in place)
`<details>` rows separated by 45% hairlines; the summary carries a rotating chevron (SVG mask, Ink-3, 160ms) and 13px title; the open body is 11.5px mono in Ink-2, pre-wrapped, capped at 300px scroll.

### Provenance line
Mandatory footer under every measured block: 10.5px mono in Ink-3 above the content, separated by a full hairline top border (6px above, 10px margin).

### Action line
12.5px secondary text prefixed with a signal-blue arrow (SVG mask). Pairs with any risk or score.

### Feed
Borderless list rows on hairlines: mono timestamp (Ink-3) + mono verb (ink) + prose detail, baseline-aligned.

### Browser surfaces
The world extends to the chrome: selection is a 28% signal tint, focus-visible is a 2px signal outline (2px offset, chip radius), scrollbars are thin rail-edge thumbs, links are signal blue with offset thin underlines.

**The Provenance Rule.** Every measured block ends in a mono provenance footer over a hairline. No number appears without its source and freshness.

## Do's and Don'ts

### Do:
- **Do** build structure from rails and hairlines; a new panel is a sheet or a rail row, never a stat card.
- **Do** wash the whole row with the state tint (7–12% `color-mix` over rail) when state changes — the badge alone is not enough.
- **Do** set every number, path, timestamp, and label in B612 Mono, uppercase with 0.05–0.08em tracking when it labels.
- **Do** use `--lamp-attn-ink` whenever amber is text.
- **Do** honor `prefers-color-scheme` and `prefers-reduced-motion`; every transition/animation has a reduced-motion off-switch.
- **Do** end every measured block with a `.provenance` footer and pair every risk with an `.action-line`.

### Don't:
- **Don't** use lamp green/amber/red for anything but state — not headings, not branding, not emphasis.
- **Don't** introduce a second interaction accent; signal blue (#2b5d8f / #6ea3d8) is the only "act here" color.
- **Don't** render a grid of same-size stat cards, a near-black+neon theme, or a pill-shaped chip; chips are stamped squares (2px radius, 1px currentColor border).
- **Don't** add per-panel density or theme toggles; the one masthead control and the OS scheme decide.
- **Don't** exceed the instrument scale: nothing larger than the 15px wordmark; no display typography.
