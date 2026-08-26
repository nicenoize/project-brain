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

## Tool-Stack-Entscheidung (bewertet 2026-08)

| Tool | Verdict | Begründung |
|---|---|---|
| **Motion** (motion.dev, ex-Framer-Motion) | ✅ **Adoptieren** — unsere Animations-Grundlage | Unabhängige OSS-Library, 12 KB vanilla / React-Build mit Layout-Animations + AnimatePresence. Trägt beide Surfaces: orchestrierte Signature-Motion auf der Landing, 150–250-ms-State-Transitions im Control Room. Die eine klare Übernahme. |
| **Spline** (3D) | ⚠️ **Nur auf Direction-Befehl** | React-Integration ist reif (`@splinetool/react-spline`, r3f-Export). ABER: schwebende abstrakte 3D-Formen im Hero sind 2026 selbst schon ein Template-Look — die neue Version des Purple-Gradients. Und unser Masterplan sagt: das Hero-Visual ist die **echte Treemap mit Live-Leases**. Spline nur, wenn die gewürfelte Direction 3D wirklich verlangt; echte Daten schlagen dekoratives 3D. |
| **Kokonut UI** (+ Magic UI / Aceternity, gleiche Kategorie) | ⚠️ **Verhalten ja, Look nie** | Animierte shadcn/Motion-Komponenten zum Kopieren — im Sichtbaren exakt der Template-Look, den wir vermeiden („a stock component inside a committed form is a lapse" — impeccable). Erlaubt: als Qualitäts-Referenz und als Verhaltens-/A11y-Skelett (shadcn-Primitives), das vollständig in unsere eigene Token-Welt umgekleidet wird. Verboten: eine Kokonut-Komponente, die man als solche wiedererkennt. |
| **Emergent.sh** | ❌ **Nicht verwenden** | AI-App-Builder (Prompt → fertige App via Agenten-Team). Das ist das Gegenteil unseres Ziels — „schnell mit AI zusammengecodet" als Produktprinzip — und zugleich Markt-Nachbar unseres eigenen Stacks. Höchstens Wettbewerbsbeobachtung. |

**Merksatz:** Teuer aussehen entsteht nicht durch teure Effekte, sondern durch
Kohärenz — eine Welt, ein Motion-Grammar, komplette States, echte Daten. Effekte
aus Libraries, die jeder kopieren kann, signalisieren das Gegenteil.

## Der Durchlauf: Design-Pipeline mit Slop-Gates (verbindlicher Ablaufplan)

Jede UI-Surface (Landing, Control Room, spätere Views) durchläuft diese Phasen.
Kein Gate ist übersprungbar; „sieht schon gut aus" ist kein Gate.

**Phase 0 — Fundament (einmalig pro Projekt)**
1. `/impeccable init` → PRODUCT.md (Produktwahrheit, Zielgruppe, Szene).
2. Der Physische-Szene-Satz wird geschrieben („Entwickler, mehrere Terminals,
   lange Abend-Sessions") → erzwingt Dark/Light begründet statt per Default.
3. Name/Brand-Entscheidung (Sebastian) liegt vor.

**Phase 1 — Richtung (menschliche Entscheidung, pro Surface)**
4. Impeccable new-work: 7 Kandidaten aus ≥3 Materialfamilien, Konzept-Würfel,
   Decision-Board mit Comps. **Sebastian wählt.** Ohne diese Wahl wird nicht gebaut.
5. Direction Contract (THESIS/OWN-WORLD/STORY/FIRST VIEWPORT/FORM) steht im Artefakt.

**Phase 2 — Tokens locken (vor dem ersten Komponenten-Code)**
6. Palette (Strategie explizit: Restrained für Control Room), Font-Entscheidung
   gegen die Bannliste, Spacing-Skala, Motion-Grammar (Motion-lib, Dauer-Regeln)
   als Token-Datei. Ab hier gilt: Tokens ändern = Entscheidung, nicht Drift.
7. **Slop-Gate maschinell verankern**: `.project-brain/conventions.json`-Regeln
   für `ui/**` (block: Indigo/Purple-Gradient-Klassen, Bannlisten-Fonts,
   Inline-Hex außerhalb der Token-Datei) — läuft über unser eigenes
   `brain:lint-conventions` als PreToolUse-Hook + CI. Das Brain bewacht sein
   eigenes Design-System (Dogfooding).

**Phase 3 — Bauen**
8. Verhalten von shadcn-Primitives, Look zu 100 % aus eigenen Tokens; Motion nur
   nach Grammar; jede Komponente mit allen 7 States; Empty States lehren und sind
   per git-intel gefüllt; jede Zahl trägt Provenance oder Aktion.

**Phase 4 — Slop-Gates (Reihenfolge fix)**
9. `detect.mjs` (impeccable-Detector) auf allen geänderten Targets → Mechanisches fixen.
10. Screenshot-Runde (Desktop + Mobile, gebatcht), Kritik gegen Direction Contract.
11. **Finish-Reviewer** (frischer Kontext, nie der Build-Thread) mit Contract,
    Screenshots, QUALITY-BAR — Verdict-Tabelle wird berichtet wie sie ist.
12. Kategorie-Rate-Test: Könnte man die Ästhetik aus „Dev-Tool-Dashboard" erraten?
    Ja → zurück zu Phase 2/3. APCA-Kontrast-Check.

**Phase 5 — Versiegeln**
13. DESIGN.md wird vom Documenter aus der *gebauten* Welt geschrieben.
14. `/impeccable hooks on` bleibt aktiv → jeder spätere UI-Edit läuft durch den
    Detector; Regressionen werden Findings, nicht Geschmacksfragen.

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
