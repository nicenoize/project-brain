# Design-Direction: Wie das Produkt echt designt aussieht (nicht AI-generiert)

Recherche 2026-08 für Control Room (M2.75) und Landing Page. Wir nutzen **impeccable**
als Design-Skill; dieses Dokument hält fest, *wie* wir es einsetzen und welche
Guardrails zusätzlich gelten. Verbindlich für alle UI-Arbeit.

## Warum AI-Design als AI erkennbar ist

Ein LLM sagt das wahrscheinlichste nächste Token vorher — für Code richtig, für
visuelle Entscheidungen fatal: „wahrscheinlich" = statistischer Durchschnitt von
Millionen Templates. Die Tells sind dokumentiert und in Sekundenbruchteilen erkennbar:

- **Indigo→Purple-Gradient** (der lauteste Tell 2026, direkt auf Tailwinds
  `indigo-500`-Default und dessen Trainingsdaten-Feedback-Loop zurückführbar)
- **Inter überall**, drei gleiche Cards nebeneinander, austauschbare Hero-Section
- Die drei AI-Cluster-Looks unabhängig vom Thema: (a) Cream-Grund + Kontrast-Serif
  + Terracotta-Akzent, (b) Near-Black + ein Neon-Akzent + Glow-Kanten,
  (c) Editorial-Hairlines + Italic-Serif + getrackte Mono-Labels

**Der Fix ist nie ein besseres Modell, sondern ein Mensch, der VOR der Generierung
entscheidet**: Richtung, Palette-Cap, echte Font-Entscheidung, gelockte Tokens.
Genau das operationalisiert impeccable.

## Wie wir impeccable einsetzen (Reihenfolge verbindlich)

1. **`/impeccable init`** einmal pro UI-Projekt (Control-Room-`ui/`, Landing-Repo):
   schreibt PRODUCT.md (Produktwahrheit, Zielgruppe, Szene). Ohne das rät der Agent.
2. **Landing Page = Persuade-Modus** über den new-work-Flow: 7 konkrete visuelle
   Welten aus der Kultur der Zielgruppe (≥3 Materialfamilien!), der Würfel
   (`concept-seed.mjs`) bricht den Kategorie-Default, Sebastian wählt am
   Decision-Board. **Die Wahl der Richtung ist eine Gründerentscheidung, keine
   Agentenentscheidung** — das ist der Kern von „sieht nicht nach AI aus".
3. **Control Room = Operate-Modus** — hier gilt impeccables wichtigste Lektion:
   > „Product UI's failure mode isn't flatness, it's strangeness without purpose.
   > The bar is **earned familiarity**. The tool should disappear into the task."
   Kein Expressions-Wettbewerb: ein gut getunter Sans für alles, Restrained-Farben
   (Neutrals + 1 Akzent nur für Aktionen/Selektion/State), Dichte ist erlaubt,
   Standard-Affordances (Top-Bar + Side-Nav, Command Palette). Marke lebt in
   **präzisen Details**, nicht in Dekoration.
4. **Direction Contract** (THESIS/OWN-WORLD/STORY/FIRST VIEWPORT/FORM) als Kommentar
   im Artefakt — auditierbar, überlebt den Build.
5. **Nach dem Build**: Finish-Reviewer + Documenter (DESIGN.md wird aus der
   *gebauten* Welt geschrieben, nicht vorher erfunden), dann **`/impeccable hooks on`**
   im UI-Projekt — der Detector läuft nach jedem UI-Edit und fängt Slop-Regressionen.

## Zusätzliche Guardrails (projektspezifisch)

- **Font-Bannliste** (impeccables Trainingsdaten-Defaults, ohne zwingenden Grund
  verboten): Inter-as-Display, Space Grotesk, Space Mono, DM Sans, Outfit,
  Plus Jakarta, Playfair, Fraunces, Lora, IBM Plex. Für den Control Room ist ein
  System-Stack/Workhorse-Sans explizit erlaubt und richtig (Operate-Permission).
- **Kein Indigo/Purple-Gradient. Nirgends.** Kein Drei-Cards-Hero auf der Landing.
- **Dark/Light ist keine Default-Entscheidung**: ein Satz physische Szene erzwingt
  sie („Entwickler, mehrere Terminals, lange Sessions, abends" → wahrscheinlich
  dark — aber der Satz muss geschrieben und die Entscheidung begründet sein).
- **Kontrast per APCA prüfen**, nicht nur WCAG-Ratio.
- **States sind Teil des Designs**: jede Komponente mit default/hover/focus/active/
  disabled/loading/error; Skeletons statt Spinner; Empty States, die das Interface
  lehren (deckt sich mit unserem Empty-State-Test aus dem Masterplan: git-intel
  füllt das UI ab Tag 1).
- **Motion 150–250 ms, nur für State** — keine Page-Load-Choreografie im Tool.

## Unser eigentlicher Design-Vorteil: echte Daten als Material

Impeccables „Prove, don't claim" trifft unser Produkt perfekt: Wir müssen nichts
inszenieren — **die deterministischen Visuals SIND die Marke**:

- Repo-**Treemap** mit beleuchteten Leases/Agent-Positionen (Hero-Visual, M2.75)
- Lease-Board mit echten TTL-Countdowns, Hotspot-Ranglisten, Co-Change-Graphen
- Provenance-Footer („basis: measured · source: git-log · window: 170 commits")
  als sichtbares Vertrauens-Detail — Datenehrlichkeit als Ästhetik
- Für alle Charts/Treemaps: `dataviz`-Skill laden (Palette-Validator, Light/Dark)

Ein generisches Dashboard mit Fake-Zahlen sieht nach AI aus; ein Instrument, das
echte, überprüfbare Repo-Wahrheit zeigt, sieht nach Craft aus. Linear ist das
Referenzbeispiel dieser Schule: minimale Grundfläche, Dichte, Hierarchie, und
Sorgfalt in kleinsten Details — nicht Dekoration.

## Anti-Pattern-Checkliste vor jedem Ship

☐ Könnte jemand die Ästhetik allein aus der Kategorie erraten? → nacharbeiten
☐ Indigo-Gradient, Inter-Display, 3-Cards-Hero, Cream+Serif-Default? → raus
☐ Direction Contract im Artefakt vorhanden und vom Build nicht entfernt?
☐ Detector (`/impeccable hooks`) aktiv? Finish-Review gelaufen?
☐ Empty State gefüllt (git-intel) statt „nothing here"?
☐ Jede Zahl im UI trägt Provenance oder eine Aktion (kein Score ohne Aktion)?

## Quellen

- impeccable v4.1.0: `reference/new-work.md` (Konzept-Würfel, Direction Contract,
  Kalibrierungs-Selbstcheck), `reference/operate.md` (Earned Familiarity)
- AI-Slop-Tells: 925studios „AI Slop Fonts and Gradients", prg.sh „Why Your AI
  Keeps Building the Same Purple Gradient Website", vibecodekit „AI Slop Design"
- Referenz-Craft: linear.app UI-Refresh 2026 + DESIGN.md-Analysen (designmd.co)
