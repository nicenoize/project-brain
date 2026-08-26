# Project Brain → kommerzielles Agent-Ops-Produkt: Masterplan

## Kontext

Project Brain ist heute ein privates, symlink-installiertes Agent-Skill-Toolkit (51 `brain:*`-Skripte, ~21.6k LOC, 62 Testdateien, nur 2 Dependencies). Die Wettbewerbsanalyse (repowise: 5.8k Stars, AGPL+SaaS, deterministischer Kern, Benchmark-als-Moat, Funnel aus kleinen Gratis-Tools) ergab: Nicht die „Karte des Codes" verkaufen (Retrieval/Index — verlorener Kampf gegen tree-sitter + 18 Sprachen), sondern die **Karte der Arbeit** — den geteilten Arbeitszustand zwischen Menschen und parallel laufenden Coding-Agenten. Diesen Markt besetzt niemand, und der Schmerz wächst mit der Agent-Adoption.

**Fixierte Entscheidungen (User, 2026-08):** Keil = Agent-Ops direkt · AI = Copilot-Schicht auf deterministischem, LLM-freiem Kern (Credits) · Lizenz = AGPL-3.0 + kommerzielle Lizenz + Hosted · Team = 2 Personen (User macht Hauptarbeit, Co-Founder wird stärker onboarded), Bootstrap, kleine versandfähige Inkremente · **Produktgesicht = „Agent Control Room"**: lokales Web-UI (`<cli> serve`), das Agenten von v1 an auch **startet** (nicht nur beobachtet) — aber bewusst KEIN Editor/Terminal-Ersatz à la Superset/Cursor.

**Marktlage Interface (Recherche 2026-08):** Der Parallel-Agenten-Runner-Markt ist besetzt und wird auf 0 € kommodifiziert — Superset (source-available, Free für Einzelne / $15 Team-Seat, „bring your own subscriptions" = keine Inferenz-Marge), Conductor (gratis, VC-subventioniert), Claude Squad, Nimbalyst, Paneflow; Vibe Kanban nach Bloop-Shutdown nur noch Community. Konsequenz: Wir gewinnen den Runner-Feature-Krieg nicht und versuchen es nicht — das Control Room ist lokal **kostenlos** (Funnel + Demo) und differenziert sich durch das, was kein Runner hat: Governance (Leases/Briefs/Grills/ADRs), Gedächtnis und Audit. Monetarisiert werden Team-Sync, geteilter State-Server, Audit/Compliance und AI-Credits.

**Bewusste Kursänderung:** `docs/roadmap-next.md` schließt einen Cloud-Service explizit aus. Dieser Plan revidiert das gezielt und eng begrenzt: Die Cloud synct **nur Koordinationszustand** (Leases, Workstreams, Events) — nie Code, nie den Index. Das wird als ADR festgehalten.

---

## 1. Produktdefinition

**Kategorie-Claim:** „Der geteilte Work-State-Layer für Teams mit parallelen Coding-Agenten: wer — Mensch oder Agent — hält welche Dateien, unter welcher Entscheidung, mit welchem Brief, und was danach geschah."

**Produktform:** Drei Oberflächen über einer Engine: (1) **CLI** (8 Verben, Hooks, ambient — für Agenten und Power-User), (2) **Agent Control Room** — lokales Web-UI via `<cli> serve`: Kanban der Work Packages, Agenten-Start in Worktrees (auf `brain:orchestrate` aufgesetzt), Live-Lease-Board mit TTL und Konflikten, Brief/Grill-Freigaben, Audit-Trail, (3) **GitHub-App** (Checks/PR-Kommentare). Das Cloud-Team-Dashboard ist dasselbe UI gegen die Cloud-API — eine Codebase. Abgrenzung: Diff-Review in v1 nur leichtgewichtig (Datei-Liste + `git diff`-Ansicht), Editor-Handoff an VS Code/Cursor statt eigenem Editor.

**Drei Botschafts-Säulen:**
1. **Agenten, die sich nicht auf die Füße treten** (Leases, Work Packages, Handoffs) — der demo-bare Schmerz. Kommuniziert wird das dreistufige Enforcement-Modell (Hard-Block wo Hooks existieren / Advisory / Audit — s. Ehrlichkeits-Klausel in §2), nie ein universelles Blocking-Versprechen.
2. **Kein Edit ohne Grund** (Brief/Grill/ADR *vor* der Implementierung, am Commit/PR erzwungen — nicht post-hoc gemined wie bei repowise). Audit-Trail = Manager-/Compliance-Story.
3. **Deterministischer Kern, ehrliche Zahlen** (kein LLM im Hot Path, local-first, öffentlicher Benchmark mit publizierten Niederlagen — repowise-Playbook, das wir mit der vorhandenen Eval-Disziplin glaubwürdig füllen können).

**Positionierung:** Wir verkaufen die „Karte der Arbeit"; die dafür nötige „Karte des Codes" bauen wir **selbst** — als eigene, deterministische Code-Intelligence-Schicht nach den repowise-Prinzipien (zero-LLM, git-basiert, reproduzierbar), aber gezielt auf das zugeschnitten, was Agent-Ops braucht (Blast Radius, Hotspots, Co-Change, Risiko), nicht als eigenständiges Codebase-Intelligence-Produkt. Keine Integration/Abhängigkeit zu repowise; keine Code-Übernahme (deren AGPL-Code würde unser eigenes Dual-Licensing unmöglich machen — wir brauchen volles Copyright am eigenen Code). Linear/Jira = Ticket-Granularität menschlicher Absicht; wir = Datei-Granularität dessen, was Agenten *jetzt gerade tun*.

**Rebrand:** neuer Name in Woche 1 entscheiden (Kriterien: npm-Scope frei, .dev-Domain frei, als Verb nutzbar). Arbeitstitel unten: `<cli>`.

**Wedge-User:** der Solo-„Agent-Manager" mit 3+ parallelen Claude-Code-Sessions/Worktrees — Pain existiert heute, kein Org-Buy-in nötig, Single-Machine-Lock reicht ihm. Expansion ab ~Monat 6: 2–10-Personen-AI-native-Teams (erster zahlender Seat-Markt).

**Packaging/Pricing (Hypothese, an repowise geankert):**
| Tier | Preis | Inhalt |
|---|---|---|
| Free (AGPL, lokal, für immer) | 0 | Kompletter CLI **+ komplettes lokales Control Room** (Single-User, inkl. Agenten-Start): Leases, Work, Briefs, Grill, Handoffs, ADRs, Guard, lokaler Index, Ambient Routing, Eval. Für Solo vollständig — sonst stirbt der Funnel gegen die gratis VC-Runner (Superset/Conductor). |
| Pro | $15/Monat (inkl. $5 AI-Credits) | Sync-Relay über Maschinen/CI, AI-Copilot (credit-metered, Tagesdeckel), persönliche Statistiken. |
| Team | $25/Seat, 3-Seat-Min. | Geteilter Work-State-Server, Cloud-Dashboard (= dasselbe Control-Room-UI gegen die Cloud-API), GitHub-App-Enforcement, Audit-Log/-Export. **Value-Metrik: menschliche Seats, Agenten unlimitiert.** Preisanker validiert: Superset nimmt $15/Team-Seat für reines Running ohne Governance. |
| Enterprise (erst Phase 4) | Custom | SSO, On-Prem-Sync, kommerzielle Lizenz ohne AGPL. |

**North-Star-Metriken** — das Produkt misst sie selbst für den Kunden (`<cli> report`, monatlich): (1) Konflikt-/Duplikatarbeit-Rate, (2) Tokens/Zeit-bis-Kontext pro Session-Start, (3) Decision-Coverage (% PRs mit verlinktem Brief/ADR). Das ist zugleich die Renewal-Begründung des Kunden.

---

## 2. Technische Architektur (verifiziert am Code)

### Ehrlichkeits-Klausel: das Enforcement-Modell (überall so kommunizieren)
Leases/Briefs wirken auf **drei Stufen**, und wir sagen das offensiv, bevor es ein HN-Kommentar tut:
1. **Hard-Block** — nur wo Hooks existieren (Claude Code `PreToolUse` via `brain-lint-conventions`; Cursor-Hooks): Edit auf geleaste Datei wird abgelehnt.
2. **Advisory** — überall sonst: Brief/Warnung vor dem Start, im Control Room und CLI sichtbar.
3. **Post-hoc-Audit** — `events.jsonl`/Server-Events zeigen jede Verletzung nachweisbar („codex-b editierte trotz Lease").
Roadmap-Ziel ist, Stufe 1 auf mehr Runner auszudehnen (Wrapper-Skripte, MCP), aber das Marketing verspricht nie mehr als die jeweilige Stufe. Der Audit-Trail ist gerade *deshalb* wertvoll, weil Stufe 1 nicht universell ist.

### M-1 — Sofort-Distribution, VOR allem Packaging (~1 PW, Woche 1–2)
Reorder gegenüber v1 des Plans: erst Nutzerkontakt, dann Refactoring.
- **`grill` als Standalone-Skill** (`npx skills add …`, MIT) sofort extrahieren — als **bewusste Dual-Lizenzierung eigenen Codes** (wir halten das Copyright; Gründer-IP-Vereinbarung s. u.). Kein Brain nötig, eine Attributionszeile. Das ist der erste Lern- und Reichweitenkanal; alles Weitere im Plan profitiert von dem Feedback.
- `handoff`-Skill 2–3 Wochen später.
- Parallel: Name festzurren — npm-Scope, .dev-Domain **und Trademark-Quickcheck** (Lehre aus „Superset": vier Namenskollisionen).
- **Gründer-IP-Vereinbarung jetzt**: Copyright-Assignment/CLA zwischen beiden Gründern *vor* dem ersten Commit des Co-Founders — sonst ist Dual-Licensing später blockiert. (Geschäfts-/Rechtsentscheidung, extern prüfen lassen.)

### M0 — Vertrauen & Hygiene (~1.5 PW, sofort shippen)
- `LICENSE` (AGPL-3.0-only) + `license`-Feld; CLA-Entscheidung dokumentieren (nötig für Dual-Licensing).
- **Plugin-Auto-Enable entfernen**: `templates/claude-code/settings.recommended.json` (Zeilen ~106–141, `enabledPlugins` mit 14 Plugins + `extraKnownMarketplaces` mit 3 externen Repos) — beide Keys raus; Liste wandert in `settings.community-plugins.json`, nur via explizitem `init --community-plugins` installiert und vorher durch `brain:skill-audit` gejagt (macht die Liability zur Demo des Trust-Features).
- Consent-Prompts + `--dry-run` im Init-Flow: `scripts/setup-package.mjs` in Pure-Core (`init-plan.mjs`, berechnet strukturierte Diffs, unit-testbar) + Prompt-Shell splitten. Wiederverwendet: `mergePackageScripts`/`mergePackageDeps` (`scripts/common.mjs:240ff`), `syncClaudeSettings`.
- `package.json`: `private` raus, `bin`, `files` (bin/, scripts/, templates/, references/, SKILL.md, LICENSE — ohne tests/docs/eigene Brain-Daten).

### M1 — CLI-Packaging (~2.5 PW): `npx <cli> init`
- **Neuer Dispatcher `bin/cli.mjs`** (~150 Zeilen): Verb-Tabelle → `spawnSync(process.execPath, [scriptPath, ...args])`, Skriptpfade via `new URL('../scripts/…', import.meta.url)` aufgelöst — funktioniert identisch für npm-Install, `npm link` und Symlink-Checkout. Kein Refactor der 79 Skripte (viele parsen `argv` auf Top-Level; Spawnen erhält die isMain-/Subprocess-Test-Disziplin).
- **`scripts/common.mjs`**: `ROOT` (heute `process.cwd()`, Zeile 12) → `findRoot()` (aufwärts nach `.project-brain/`, dann `.git/`); `PACKAGE_DIR` neu neben `SKILL_DIR` (Zeile 14); Template-Lookups probieren `PACKAGE_DIR` zuerst. 55 Importer bleiben unberührt.
- `mergePackageScripts` dual-mode: CLI-Modus merged nur ~10 Einträge der Form `"brain:lease": "<cli> lease"`; Skill-Modus (Symlink vorhanden) emittiert weiter die heutigen `--preserve-symlinks`-Formen. **Skill-Mode bleibt voll funktionsfähig** (SKILL.md/Claude-Code-Nutzer merken nichts; `bin/update.sh` bleibt deren Updater).
- `<cli> migrate`: erkennt Symlink-Install, konvertiert Scripts + Settings-Hook-Pfade konsent-basiert, räumt früher auto-aktivierte Dritt-Plugins ab, fasst `.project-brain/`-Daten nicht an.
- CI-Smoke auf 3 Beine erweitern (Symlink / `npm pack`+npx / migrate) — das bestehende Smoke-Setup ist der Kopfstart.

### M2 — Oberflächen-Schnitt + optionaler Index (~2 PW)
- **8 öffentliche Verben**: `init, status, lease, work, brief, grill, handoff, guard` (+ `orchestrate` als Flaggschiff-Advanced, + `ai`, `login`, `migrate`). Alles andere über Escape-Hatch `<cli> x <script>` — nichts wird gelöscht; `close/reflect/route/pack` bleiben in Hooks verdrahtet.
- **`@xenova/transformers` → `optionalDependencies`** (Unterschied ~5 MB vs. ~300 MB npx-Install); `embed.mjs` lazy-importiert mit sauberer Degradation (Muster existiert schon für LanceDB).
- **`scripts/index-provider.mjs`** (Interface `available/ensureIndex/search`): `builtin` (heutiger Embedding-Stack, weiter vom 138-Fälle-Eval bewacht) / `none` (BM25+Git-Heuristik; `grill` ist ohnehin primär Blast-Radius/ADR/Test-getrieben). Der Embedding-Index wird optional; die neue eigene Code-Intelligence-Schicht (M2.5) wird der deterministische Default. Konsumenten: `brain-search/ask/pack/grill/impact`.
- **Session-Grundkosten 24k → ≤4k Token** (gemessene Baseline in `eval-methodology.md`): 1-Seiten-State-Digest injizieren, Details on demand. Ist selbst eine Marketing-Zahl.

### M2.5 — Eigene Code-Intelligence-Schicht (~3 PW, **vor dem Control Room**)
**Reihenfolge-Begründung (Empty-State-Fix):** Ein frisches Repo hat keine Leases, ADRs oder Briefs — ein Control Room darüber wäre am Tag 1 leer und würde deinstalliert. Git-Intelligence (Hotspots, Co-Change, Ownership) ist **sofort aus `git log` befüllbar** und liefert das „Aha in 5 Minuten": `init` endet mit einem gefüllten Bild des Repos, das UI hat vom ersten Öffnen an Inhalt. Deshalb M2.5 vor M2.75.
Eigene, unabhängig gebaute Version der repowise-Prinzipien (zero-LLM, deterministisch, reproduzierbar) — **kein Fremdcode** (Copyright-Reinheit ist Voraussetzung fürs eigene Dual-Licensing). Gezielt auf Agent-Ops-Bedarf geschnitten, nicht auf 18-Sprachen-Vollständigkeit:
- **Git-Intelligence zuerst** (sprachunabhängig, rein aus `git log`, billig): Hotspots (Churn × Alter), Co-Change-Paare („wer B ändert, ändert meist auch C"), Ownership/Bus-Faktor pro Pfad. Neues Modul `scripts/git-intel.mjs`; Muster existieren in `brain-why.mjs` (log-Parsing) und `footprint.mjs`.
- **Dependency-Graph ausbauen statt neu bauen**: `scripts/ts-graph.mjs` + `lang-symbols.mjs` + `brain-impact.mjs`/`brain-edges.mjs` existieren; Roadmap liegt in `docs/roadmap-symbol-index.md`. TS/JS zuerst (eigener Stack + Wedge-Zielgruppe), weitere Sprachen nach Nachfrage.
- **Change-Risk-Score** (0–10 je Branch/PR, deterministisch): Kombination aus Blast-Radius (Graph), Hotspot-Überlappung, Co-Change-Vollständigkeit („Datei X geändert, üblicher Partner Y nicht"), Lease-/Workstream-Konflikten. Fließt in `brief` (Advisory), `grill` (Fragengenerierung), `guard`/GitHub-App (PR-Kommentar) und die Bench-Metriken.
- Jede Heuristik wird über die vorhandene Eval-Disziplin validiert, bevor sie default-on geht (paired bootstrap, publizierte Baselines) — dieselbe Beweisführung wie repowise, mit eigenem Datensatz.

### M2.75 — Agent Control Room v1 (~7 PW ehrlich geschätzt, das Produktgesicht)
**Schätzungs-Korrektur nach Review:** Prozess-Supervision (Zombie-Runner, verwaiste Worktrees, Crash-Recovery, Log-Handling) ist der teuerste Teil und war mit 5 PW schöngerechnet. Scope-Deckel von Anfang an, nicht als Notbremse: **v1 startet nur einen Runner-Typ (Claude Code) auf macOS/Linux**; weitere Runner (Codex, Cursor-CLI) folgen nach Nachfrage. Beobachten/Governance funktioniert von Anfang an runner-agnostisch (liest nur State).

**Sicherheitsmodell des Serve-Daemons (Pflicht, nicht optional):** Der Daemon startet Prozesse über eine lokale HTTP-API — ohne Schutz wäre das eine Drive-by-RCE (beliebige Webseite POSTet via DNS-Rebinding/CSRF auf localhost). Daher: (a) bind ausschließlich `127.0.0.1`; (b) per-Session-Token, beim `serve`-Start generiert und nur über die geöffnete Browser-URL übergeben — jede API-Anfrage trägt es; (c) `Origin`/`Host`-Header-Validierung; (d) **`runner-cmd` ist niemals über die API setzbar** — nur aus der lokalen Config-Datei lesbar; die API referenziert Work-Package-IDs, keine Kommandos; (e) CORS aus. Eigener Testblock dafür.

**Auslieferungs-Entscheidung: Localhost-Web-App aus dem CLI, Desktop-Wrapper später.** Begründung: (a) eine Codebase dient lokal *und* später als Cloud-Team-Dashboard (nur anderes API-Target); (b) kein Signierungs-/Update-/App-Store-Aufwand für 2 Personen; (c) das Prozess-Management (Agenten starten) lebt ohnehin im lokalen Daemon, nicht im Browser — ein späterer Tauri-Wrapper (für Tray, Notifications, „App-Gefühl") bleibt dadurch eine dünne Hülle um dieselbe App und wird erst gebaut, wenn Nutzer danach fragen (frühestens P3).

- **`<cli> serve`** (neu `scripts/brain-serve.mjs`): lokaler HTTP-Server (Node `http`, kein Framework-Zwang im AGPL-Client) + öffnet Browser. Serviert ein statisches UI-Bundle (React/Vite, eigenes Verzeichnis `ui/`, im npm-Paket vorgebaut enthalten) + eine JSON-API über den existierenden State: `active_state.md` (via `activeStateJson()`), `events.jsonl`, Findings/Grills/ADRs, `git-intel`-Daten. SSE für Live-Updates (Datei-Watcher auf `.project-brain/`).
- **Agenten-Start von v1 an** (User-Entscheidung): UI-Aktion „Start work package" ruft die `brain:orchestrate`-Maschinerie (Worktree spawnen, Runner-Prozess via `--runner-cmd`-Template, Slot-Lease gegen Über-Spawn — existiert alles in `brain-orchestrate.mjs`). Der Serve-Daemon wird Prozess-Supervisor: PID-Tracking, Log-Tailing ins UI, Stop-Button. **Kein eingebettetes Terminal in v1** — Log-Stream + „Open in Terminal/Editor"-Handoff; PTY-Interaktion ist der größte Scope-Fresser der Konkurrenz und genau deren Terrain.
- Views v1: Fleet (Repos × Workstreams), In-Flight-Board (Work Packages mit Agent-Status ▶/⏸/⚠), Lease-Board (TTL-Countdown, Konflikte rot), Brief/Grill-Panel (Approve / „Grill first"), Audit-Feed, Light-Diff (Datei-Liste + `git diff`-Render, Editor-Handoff für echtes Review).
- **Design-Pipeline verbindlich**: jede UI-Surface läuft durch den Durchlauf in `docs/design-direction.md` (impeccable init→Würfel→Direction Contract→Token-Lock→Slop-Gates→DESIGN.md; Animations-Stack = Motion/motion.dev; Kokonut/Magic-UI nur als Verhaltens-Skelett, nie sichtbar; Spline nur auf Direction-Befehl). Die Slop-Gates sind teils maschinell via eigenem `brain:lint-conventions` auf `ui/**` verankert.
- Governance-Hook: Start aus dem UI erzwingt den Brief („diese Dateien sind geleast / ADR X regiert") *vor* dem Spawn — das ist der Moment, der uns von jedem Runner unterscheidet, und der Screenshot fürs Marketing.

### M3 — Koordinations-Server + Remote-Driver (~4 PW, erste Paid-Funktion)
- **Entscheidung: API-Server (Postgres), `active_state.md` wird im Team-Modus zur materialisierten View.** Begründung: Leases sind Mutual Exclusion — Git-Transport (Push-Races, kein TTL) und CRDTs (Konvergenz ≠ Exklusion) können das prinzipiell nicht; nur ein Single-Arbiter-`INSERT … WHERE NOT EXISTS` gibt eine wahre Antwort auf „wer hält was". Git-Föderation bleibt Roadmap für *Wissen* (Constellation), nicht für Locks.
- **Neuer Seam `scripts/state-backend.mjs`** (`acquireLeases/releaseLeases/listState/upsertWorkstream/endWorkstream/appendEvent`): `local`-Driver wrappt heutiges `active-state.mjs` (`withStateLock`, Zeile 26) unverändert — Free-Tier bleibt byte-identisch offline; `remote`-Driver ruft die API und rewritet `active_state.md` über die existierenden `replaceTable/replaceSection`-Funktionen, sodass alle Markdown-Konsumenten (SessionStart-Hook, `brief`, `route`, Menschen) ohne Änderung weiterlaufen. Call-Site-Wechsel nur in `brain-lease/work/orchestrate/handoff`.
- **Degradation = SLA-Strategie**: Server unerreichbar → `acquire` fail-closed mit klarer Meldung; `--offline` erzeugt lokale Lease mit `scope=local` + Event-Queue; Replay bei Reconnect, Konflikte werden als Blocker sichtbar. Ausfall heißt Rückfall auf Lokal-Modus, nie Stillstand.
- **Server-MVP in separatem Repo** (Dual-License-Hygiene: nie AGPL-Client-Code linken): kleines Node-Service + Postgres. Schema: `orgs/repos/actors` (Actor = GitHub-Identität × Agent-Label → Audit sagt „codex-a für @seebo"), `leases` (mit `expires_at`-TTL, lazy enforced, kein Reaper), `workstreams`, `events` (append-only = **der Audit-Trail**, Briefs/Grills per Hash referenziert). Auth: GitHub Device Flow (`<cli> login`).
- **Glob-Overlap-Semantik ist Kernprodukt, kein Detail**: eigenes, pur getestetes Modul `scripts/lease-overlap.mjs` mit definierter Semantik (Segment-weise Glob-Schnittprüfung: `src/**` ⊗ `src/auth/*.ts` = Konflikt; nicht unterstützte Konstrukte wie `!`-Negation werden bei Lease-Anlage abgelehnt statt falsch geprüft). Identischer Code läuft lokal (`brief`/`lease`) und serverseitig vor dem INSERT — eine Implementierung, eine Wahrheit, Property-/Fuzz-Tests.
- **Lokaler Audit-Trail in beiden Tiers**: `appendEvent` schreibt immer `.project-brain/events.jsonl` (Muster wie `reflect`/`USAGE_LOG`) — zugleich der Upgrade-Funnel („verbinde das Repo und sieh das als Dashboard").

### M4 — Hosted Dashboard + GitHub (~3 PW, + ~2 PW App)
- **Stack für 2 Personen**: eine Next.js-App auf Vercel (Koordinations-API als Route-Handler + Hosting des **Control-Room-UI-Bundles gegen die Cloud-API** — das UI aus M2.75 wird wiederverwendet, nur Daten-Layer getauscht), Neon/Supabase-Postgres, Auth.js mit GitHub OAuth, Stripe. Ein Deployable, eine DB, null Ops. Aufwand sinkt gegenüber ursprünglicher Schätzung, weil die Views schon existieren.
- Cloud-only-Zusätze: Multi-User-Ansicht (Actors), Lease-Revoke durch Owner, Audit-Export, Handoff-Archiv (`handoff --publish`).
- **GitHub Phase A (billig)**: bestehenden Workflow `templates/github-workflows/project-brain.yml` (fährt heute schon `guard`/`maintain --ci`) um `<cli> report --ci` erweitern → JSON an die API. **Phase B (App)**: Webhook-Check-Runs + Brief-artiger PR-Kommentar („diese Dateien sind bis 14:00 von codex-a geleast; ADR 0012 regiert diesen Bereich") — die App führt nie Kundencode aus, sie rendert nur, was die Action gemeldet hat (umgeht das Sandboxing-Problem komplett).

### M5 — AI-Copilot (~3 PW)
- **Struktureller Boundary**: alles LLM in `scripts/ai/copilot.mjs`; Lint-Regel (Erweiterung von `brain-lint-conventions.mjs`) verbietet Imports von außerhalb `scripts/ai/` und jeden Hook-Pfad. LLM nur hinter explizitem `<cli> ai <verb>`/`--ai`, nie exit-code-relevant. Deterministische JSON-Outputs sind der *Input* des Copilots.
- Zwei Provider: `hosted` (API-Proxy, serverseitige Credit-Ledger `credit_ledger(org, delta, feature, tokens)`, Monatsgrant je Plan, Stripe-Top-ups) und `byok` (eigener Key, keine Credits — hält den AGPL-Tier ehrlich).
- Erste Features (je auf existierendem strukturiertem Output): (1) **ADR-Draft** aus Diff + Grill-Q&A + Blast-Radius — höchste Zahlungsbereitschaft; (2) Brief-Erklärung; (3) Handoff-Narrativ; (4) Reflect-Destillat.

**Gesamt: ~26 PW Kern (+2 GitHub-App), ehrlich geschätzt. Reihenfolge: M-1 (Distribution) → M0–M2 (Packaging, ~6 PW) → M2.5 (git-intel, füllt das UI) → M2.75 (Control Room = Launch-Moment, Product Hunt/Show HN) → M3–M5. Nutzerkontakt beginnt in Woche 1, nicht in Monat 3.**

---

## 2b. Praktiken-Katalog aus repowise (verbindlich, je Milestone zugeordnet)

**Engineering:**
- **Budgets als CI-Test**: ≤4k-Token-Footprint wird eine CI-Assertion über das vorhandene `brain:health`-Footprint-Audit (M2); Bruch = roter Build, nicht Vorsatz.
- **Determinismus als getesteter Vertrag**: gleiche Inputs ⇒ byte-identische Briefs/Risk-Scores/PR-Kommentare; expliziter Snapshot-Test (M2.5/M4).
- **Kalibrierung statt Konstanten**: Change-Risk-Gewichte gegen echte Revert-/Fix-Historie kalibrieren (paired bootstrap, M2.5) — nie handgetunt.
- **Confidence-Stamping**: jedes Signal trägt „measured vs. inferred" + Quelle; git-intel-Outputs und Briefs eingeschlossen (M2.5).
- **`<cli> doctor`** (M1): bündelt repair/health/Provider-Verfügbarkeit zu einem „warum geht's nicht"-Befehl.

**Sicherheit/Privacy:**
- **`DATA_HANDLING.md` + Threat-Model vor dem ersten Team-Kunden** (M3): Kernaussage „die Cloud sieht nie Code, nur Koordinationszustand" — stärker als repowise' Claim, muss dokumentiert und im Pricing sichtbar sein.
- **Freshness-Metadaten auf jeder API-/UI-Antwort** (`state_age`, `stale_warning`) — Staleness-Banner aus search/pack generalisieren (M2.75).
- **Secrets-Scanning default-on im PR-Pfad** der GitHub-App (gitleaks-Integration existiert opt-in in `guard`) (M4).

**UI/UX (Control Room + GitHub-App):**
- **Silent-by-default-PR-Bot**: Kommentar in-place editiert bei jedem Push; grüner PR = kein Kommentar (M4, wörtlich übernehmen).
- **Repo-Treemap als Hero-Visual**: geleaste Pfade + Agent-Positionen beleuchtet — zentrales Control-Room-View und der Marketing-Screenshot (M2.75).
- **Öffentliche, teilbare Per-PR-Brief-/Handoff-Seite ohne Login** — virale Oberfläche analog repowise' PR-Analyseseiten (M4).
- **Provenance-Footer auf allem Generierten** („deterministisch erzeugt aus X") + Freshness-Badge (M2.75+).
- **Kein Score ohne Aktion**: jeder Risk-Score/Befund kommt mit konkretem nächstem Schritt (Grill starten / Lease splitten / ADR nachziehen) (M2.5+).
- **1-Minuten-Quickstart + Agent-driven Setup** (copy-paste-Prompt, existiert als „First agent command" — polieren) + README-Badge → eigene Seite (M1).
- **Post-v1-Kandidat**: VS-Code-Extension „Lease in der Gutter" („diese Datei hält claude-a bis 14:00") — klein, hochsichtbar, nach P2 evaluieren.

---

## 3. Go-to-Market (parallel zu den Milestones)

- **Step 0 (W1–2, = M-1):** `grill`-Skill shippen (MIT, „mein Agent musste seinen Plan verteidigen und gab zu, dass er falsch war" — screenshot-bar), Name+Trademark, Gründer-IP. **Distribution vor Packaging** — das Skill-Feedback informiert alles Weitere.
- **Step 1 (W2–8, = M0/M1):** Lizenz, npx-Install (<2 min für Fremde als hartes Gate), 8 Verben, ≤4k-Token-Budget; `handoff`-Skill nachschieben. Repowise' modpack-Play.
- **Step 1.5 (M2.75-Launch):** Control Room auf Product Hunt + Show HN — der Launch-Hook ist nicht „noch ein Runner", sondern der Governance-Moment: *„Watch my agent get stopped before editing a leased file — and asked to defend its plan first."* Screenshot/GIF-getrieben; die Gratis-Runner-Konkurrenz wird in der Story explizit anerkannt („use Superset/Conductor to run 100 agents — use us so they don't wreck each other's work").
- **Step 2 (M2–5):** **`agent-bench`** als öffentliches Beweis-Repo: N geskriptete Claude-Code-Sessions mit überlappenden Task-Sets auf einem Fixture-Repo, mit/ohne `<cli>`. Metriken: File-Konflikte, Duplikatarbeit (LOC von ≥2 Agenten fürs selbe Ziel), Rework (revertierte LOC), Tokens-bis-erster-produktiver-Edit. **Mit paired-bootstrap-CIs und publizierten Niederlagen** — Harness und Methodik (`brain-eval-compare.mjs`, `docs/eval-methodology.md`) existieren bereits. **Kosten-/Reproduzierbarkeits-Design (Review-Fix):** festes API-Budget vorab definieren (Größenordnung $200–500 pro Bench-Runde); kleiner fixierter Task-Set (~10 Tasks) × wiederholte Runs statt vieler Tasks × einem Run; Modell/Version/Seed-Prompts gepinnt und publiziert; Nondeterminismus wird nicht wegdiskutiert, sondern als Varianz in den CIs ausgewiesen — das ist selbst Teil der Honest-Methodology-Story.
- **Step 3 (M3–5):** GitHub-App Free-Tier als Org-Discovery-Funnel (PR-Kommentar + Badge).
- **Step 4 (laufend):** Launch-Sequenz grill-Skill → agent-bench als Show HN („Wir haben gemessen, wie sehr sich parallele Coding-Agenten gegenseitig behindern — mit Daten") → Kernprodukt-HN erst *nach* dem Bench. Content-Takt 1 Post/2 Wochen (Co-Founder): Honest-Methodology-Essays, Agent-Ops-Incident-Teardowns.

**Phasen-Gates & Kill-Kriterien (mit Kalenderdaten führen):**
| Phase | Zeitraum | Gate | Kill/Pivot |
|---|---|---|---|
| P1 installierbar | M0–2 | 300 Skill-Installs oder 200 Stars; ≥30 Weekly Actives, ≥40 % W4-Retention | Nutzen alle nur `grill`, nicht Leases → Pivot zu Context-CI/grill-first-Produkt |
| P2 Beweis | M2–5 | Bench zeigt ≥30 % Overlap-/Rework-Reduktion mit CI; 800 Stars; 10 App-Org-Installs | Bench zeigt keinen Gewinn → nicht monetarisieren, Hedge ziehen |
| P3 Monetarisierung | M5–8 | 20 Pro-Subs; 3 zahlende Design-Partner-Teams; 1 Case Study | <10 Pro nach 8 Wochen Billing → Team-only oder Monetarisierung pausieren |
| P4 Team-GA | M8–12 | €2–4k MRR, 5+ zahlende Teams → Entscheidung Bootstrap vs. Raise | — |

**Struktureller Hedge gegen „Markt zu früh":** P1–P3 stehen komplett auf Solo-Agent-Manager + Context-CI-Wert (Brief/Grill/ADR funktioniert mit *einem* Agenten); nur P4 hängt an Team-Skalen-Adoption.

**Design-Partner-Akquise (konkrete Aktivität, nicht Wunsch):** Ziel 3 zahlende Team-Design-Partner in P3. Quellen, aktiv bearbeitet ab P2: (a) jede Org mit ≥2 GitHub-App-Installs bekommt eine persönliche Mail; (b) Nutzer der grill/handoff-Skills, die in Issues/Discussions auftauchen; (c) 20 kalte, aber recherchierte DMs an sichtbare „Ich fahre X parallele Agenten"-Poster (X/Reddit/HN — die schreiben öffentlich über den Schmerz); (d) eigenes Netzwerk beider Gründer. Angebot: 6 Monate Team-Tier gegen wöchentliches Feedback + zitierbare Metriken. Owner: Co-Founder, mit Founder-Backup.

**Team-Split:** Founder = Kern-CLI, Packaging, State-Backend/Server, Bench-Harness-Design (deterministischer kritischer Pfad). Co-Founder = GitHub-App + Dashboard (saubere Schnittstelle, end-to-end besitzbar), Bench-Betrieb + gesamter Content/Community + Design-Partner-Akquise, später Stripe. Vesting 4J/1J-Cliff beidseitig + expliziter **Monat-4-Checkpoint** (App-MVP + 6 Content-Pieces geliefert, sonst Neuverhandlung vor dem Cliff) + Wochenstunden-Floor. Gründer-IP-Vereinbarung vor erstem Co-Founder-Commit (s. M-1). *(Geschäftsentscheidung, keine Rechtsberatung — jetzt aufschreiben, solange der Goodwill hoch ist.)*

**Solo-Fallback-Spur (falls der Co-Founder nicht committet, ehrlich eingeplant):** Der kritische Pfad P1–P2 (M-1→M2.75 + Bench) ist bewusst komplett Founder-seitig machbar; bei Solo-Betrieb entfallen GitHub-App Phase B und das Cloud-Dashboard rückt hinter den ersten zahlenden Pro-Kunden (Team-Tier verschiebt sich um ~1 Quartal), Content-Takt halbiert sich auf 1 Post/Monat. Der Monat-4-Checkpoint ist zugleich das Entscheidungsdatum für diese Spur.

---

## 4. Top-Risiken

1. **Anthropic shippt native Multi-Session-Koordination** → tool-agnostisch bleiben (Cursor-Hooks existieren; generisches MCP-Surface ergänzen); besitzen, was der Vendor nicht baut: Cross-Tool-State, ADR/Brief-Governance, git-getrackte Historie.
2. **Lease-Split-Brain** offline/lokal vs. Server-Wahrheit → fail-closed default, `scope=local`-Markierung, Replay mit Konflikt-Surfacing, Property-Tests auf dem Reconciliation-Pfad.
3. **repowise baut Work-State** (oder wir geraten in deren Code-Intel-Terrain) → unsere Code-Intelligence bleibt Mittel zum Zweck (füttert Brief/Grill/Risk), nie Headline-Produkt; Differenzierung bleibt der mutable Koordinationszustand + Intent-first-Enforcement, den deren read-only/post-hoc-DNA nicht abdeckt. Kein Fremdcode, kein Integrations-Lock-in.
4. **Dual-License-/IP-Hygiene** → CLA ab erstem externen PR; Server von Tag 1 in separatem Repo; MIT für die viralen Skills.
5. **2 Teilzeit-Personen** → alles ≤2-Wochen-Inkremente, Kill-Kriterien mit Datum, kein Enterprise vor P4.
6. **Gratis-Runner-Kommodifizierung** (Superset free, Conductor free, VC-subventioniert) → nie über Runner-Features konkurrieren; Control Room lokal kostenlos halten; Monetarisierung ausschließlich auf Team-Sync/Governance/Audit — Dinge, die ein Runner-Hersteller nur mit einem Architekturwechsel nachbauen kann.
7. **Prozess-Management-Scope im Control Room v1** (Agenten-Start ab v1, User-Entscheidung) → strikt auf orchestrate-Reuse + Log-Streaming begrenzen, kein PTY/eingebettetes Terminal, Stop/Restart + Fehlerpfade zuerst testen; wenn v1 dadurch >6 PW droht, Start-Feature auf „ein Runner-Typ (Claude Code), ein OS (macOS)" einschränken statt zu verschieben.

---

## 5. Umsetzung — kritische Dateien

| Datei | Änderung |
|---|---|
| `package.json` | Rename, `private` raus, `bin`, `files`, `license`; `@xenova` → optional |
| `LICENSE` (neu) | AGPL-3.0-only |
| `bin/cli.mjs` (neu) | Dispatcher + Verb-Tiering + `x`-Escape-Hatch |
| `scripts/common.mjs:12-14` | `findRoot()`, `PACKAGE_DIR`; `mergePackageScripts` dual-mode |
| `scripts/setup-package.mjs` | Split in `init-plan.mjs` (pure) + Consent-Shell; `--dry-run` |
| `templates/claude-code/settings.recommended.json:106-141` | Plugin-Auto-Enable entfernen → opt-in Datei + skill-audit-Gate |
| `scripts/state-backend.mjs` (neu) | local/remote-Driver-Seam — daran hängt der gesamte Paid-Tier |
| `scripts/active-state.mjs` | `replaceTable/replaceSection` exportieren (Materialized-View-Writer) |
| `scripts/index-provider.mjs` (neu) | builtin/none; Konsumenten search/ask/pack/grill/impact |
| `scripts/git-intel.mjs` (neu) | Hotspots, Co-Change, Ownership/Bus-Faktor aus git log |
| `scripts/ts-graph.mjs`, `brain-impact.mjs`, `brain-edges.mjs` | Ausbau zu Blast-Radius + Change-Risk-Score (eigene Code-Intel-Schicht) |
| `scripts/ai/copilot.mjs` (neu) | LLM-Gateway hosted/byok; Lint-Regel als Boundary |
| `scripts/brain-serve.mjs` (neu) + `ui/` (neu, React/Vite) | Control Room: lokaler Server, JSON-API über State, SSE, Prozess-Supervisor auf orchestrate-Basis |
| `scripts/brain-orchestrate.mjs` | Runner-Spawn/Slot-Lease als wiederverwendbare Funktionen exportieren (für den Serve-Daemon) |
| Neues ADR | Kursänderung „Cloud nur für Koordinationszustand" + „Control Room statt Editor" dokumentieren |
| Separates Repo | Koordinations-Server (Postgres) + Cloud-Hosting des UI-Bundles |

## 6. Verifikation

- **M0/M1:** CI-Smoke-Matrix 3 Beine (Symlink-Install / `npm pack` + `npx <tarball> init --yes` in frischem Repo / `migrate` auf pre-seeded Skill-Install); bestehende 62 Testdateien müssen grün bleiben; Fremd-Test „Install <2 min".
- **M2:** `brain:eval` gegen den builtin-Provider (138 Fälle) — keine Regression; `none`-Provider-Degradationspfade mit Subprocess-Tests; Token-Footprint-Messung via bestehendem `brain:health`-Footprint-Audit (Ziel ≤4k).
- **M2.5:** Jede Code-Intel-Heuristik gegen historische Daten validieren (z. B. Change-Risk-Score vs. tatsächliche Revert-/Fix-Commits im eigenen Fleet, paired bootstrap via `brain-eval-compare.mjs`); Fixture-Tests für git-intel auf synthetischen Repos.
- **M2.75:** Subprocess-Test: `serve` starten → API-Endpunkte gegen Fixture-State prüfen; E2E-Smoke: Work Package im UI starten → Worktree + Runner-PID existieren → Stop → sauber beendet, Slot-Lease freigegeben; Brief-Gate-Test: Start auf geleaste Dateien wird blockiert und zeigt den Brief. **Security-Tests**: API-Call ohne Session-Token → 401; falscher `Origin` → abgelehnt; `runner-cmd` via API setzen → unmöglich (nur Work-Package-IDs); Bind nur auf 127.0.0.1. **Empty-State-Test**: frisches Repo → `init` → Control Room zeigt binnen 5 Minuten gefüllte git-intel-Ansicht (Hotspots/Ownership), nie einen leeren Screen.
- **M3:** Property-Tests auf Lease-Reconciliation (offline→online-Replay); Integrationstest: zwei Clients, ein Server, überlappende Lease-Anfragen → genau einer gewinnt; Degradationstest Server-down.
- **M5:** Lint-Regel-Test: Import von `scripts/ai/` außerhalb des Gateways schlägt fehl; kein Hook-Pfad erreicht LLM-Code.
- **GTM:** Phasen-Gates aus §3 sind die Produkt-Verifikation; `agent-bench` selbst ist der End-to-End-Test des Wertversprechens.
