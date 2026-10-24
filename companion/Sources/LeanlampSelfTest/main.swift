// `swift run leanlamp-selftest` — the LeanlampCore checks, runnable with the
// Command Line Tools alone (XCTest ships with Xcode only). Same cases as
// Tests/LeanlampCoreTests, plus the toast rules. Exit 1 on the first failure.
import Foundation
import CoreGraphics
import LeanlampCore

var failures = 0
var passed = 0
func check(_ ok: @autoclosure () -> Bool, _ what: String, file: String = #fileID, line: Int = #line) {
  if ok() { passed += 1 } else { failures += 1; print("✖ \(what)  (\(file):\(line))") }
}
func eq<T: Equatable>(_ a: T, _ b: T, _ what: String, file: String = #fileID, line: Int = #line) {
  if a == b { passed += 1 } else { failures += 1; print("✖ \(what): \(a) ≠ \(b)  (\(file):\(line))") }
}

// Gauge
eq(Gauge.filled(fraction: 0), 0, "empty gauge")
eq(Gauge.filled(fraction: 0.01), 1, "anything shows one segment")
eq(Gauge.filled(fraction: 0.655), 5, "65 % is five of eight")
eq(Gauge.filled(fraction: 3), 8, "clamped at eight")
check(!Gauge.isHot(fraction: 0.5), "half is not hot")
check(Gauge.isHot(fraction: 0.75), "three quarters is hot")
check(Gauge.isHot(fraction: 0.1, needsYou: true), "needing you is hot")
eq(Gauge.k(211_400), "211k", "k")
eq(Gauge.k(1_234_000), "1.2M", "M with a decimal")
eq(Gauge.k(1_000_000), "1M", "M without")

// Notch geometry, as NSScreen reports the 14-inch MacBook Pro
let screen = CGRect(x: 0, y: 0, width: 1512, height: 982)
let visible = CGRect(x: 0, y: 0, width: 1512, height: 944)
let left = CGRect(x: 0, y: 950, width: 663, height: 32)
let right = CGRect(x: 848, y: 950, width: 664, height: 32)
if let l = NotchLayout.make(screenFrame: screen, visibleFrame: visible, auxiliaryTopLeft: left, auxiliaryTopRight: right) {
  eq(l.notch, CGRect(x: 663, y: 950, width: 185, height: 32), "notch rect")
  eq(l.menuBarHeight, 38, "menu bar from the visible frame")
  eq(l.islandFrame, CGRect(x: 523, y: 944, width: 465, height: 38), "island frame")
  eq(l.panelFrame(contentHeight: 300), CGRect(x: 435.5, y: 644, width: 640, height: 338), "panel frame")
  eq(l.hotZone, CGRect(x: 663, y: 944, width: 185, height: 38), "hot zone is the notch only")
} else { check(false, "layout from a notch screen") }
check(NotchLayout.make(screenFrame: screen, visibleFrame: visible, auxiliaryTopLeft: nil, auxiliaryTopRight: nil) == nil, "no notch, no layout")
eq(NotchLayout.make(screenFrame: screen, visibleFrame: screen, auxiliaryTopLeft: left, auxiliaryTopRight: right)?.menuBarHeight, 37, "hidden menu bar still covers the notch")
eq(NotchLayout.make(screenFrame: screen, visibleFrame: visible, auxiliaryTopLeft: left, auxiliaryTopRight: right, menuBarHeight: 24)?.menuBarHeight, 38, "a menu bar lower than the notch is not believed")

// State decoding: an engine from before the bus, and one with it
let old = #"{"v":1,"at":"","atMs":1000,"engine":{"pid":1},"machine":{},"sessions":[{"id":"a","title":"Billing","ctx":196400,"limit":300000,"burnPerMin":0,"compactions":2,"state":"tool","label":"Bash · npm test"}]}"#
do {
  let s = try CompanionState.decode(Data(old.utf8))
  eq(s.sessions.count, 1, "old state decodes")
  eq(s.openPending.count, 0, "no bus, no pending")
  check(!s.sessions[0].reachable, "no hook, not reachable")
} catch { check(false, "old state decodes: \(error)") }

let now = Date(timeIntervalSince1970: 1_792_656_000)
let nowMs = now.timeIntervalSince1970 * 1000
func state(pending: [CompanionState.Pending] = [], events: [CompanionState.Event] = [], compactionAt: Double? = nil) -> CompanionState {
  var s = CompanionState.Session(sessionId: "a", title: "Billing refactor", ctx: 57_000, limit: 300_000, compactions: 3, state: "thinking", label: "thinking")
  if let at = compactionAt {
    s.lastCompaction = try? JSONDecoder().decode(CompanionState.Session.Compaction.self, from: Data(#"{"preTokens":291000,"postTokens":57000,"precomputed":true,"atMs":\#(at)}"#.utf8))
  }
  return CompanionState(atMs: nowMs, sessions: [s], pending: pending, events: events)
}

// Toasts
let p = CompanionState.Pending(id: "p1", session: "a", title: "Billing refactor", tool: "Edit", shortFile: "src/billing/invoice.ts", deadline: nowMs + 31_400)
if let t = Toast.pick(state(pending: [p]), now: now) {
  check(t.attention, "a held edit needs you")
  eq(t.pendingId, "p1", "the buttons act on the pending id")
  eq(t.verb, "wants to edit", "verb")
  eq(t.text, "src/billing/invoice.ts", "path")
  eq(t.number, "32s", "seconds left from the deadline, rounded up")
} else { check(false, "pending gives a toast") }
let delivered = CompanionState.Event(kind: "steer-delivered", at: nowMs - 2000, session: "a", title: "Billing refactor", text: "keep ROUND_HALF_EVEN")
eq(Toast.pick(state(pending: [p], events: [delivered]), now: now)?.kind, "held", "a held edit wins over news")
eq(Toast.pick(state(events: [delivered]), now: now)?.kind, "steer delivered", "news shows")
check(Toast.pick(state(events: [delivered]), now: now)?.attention == false, "news is never orange")
check(Toast.pick(state(events: [delivered]), now: now.addingTimeInterval(7)) == nil, "news leaves after six seconds")
let approved = CompanionState.Event(kind: "approved", at: nowMs - 1000, session: "a", title: "Billing refactor", file: "/r/src/a.ts", by: "app")
eq(Toast.pick(state(events: [delivered, approved]), now: now)?.kind, "approved", "the newest news wins")
check(Toast.pick(state(events: [approved]), now: now)?.text.contains("from the notch") == true, "who answered is said")
eq(Toast.pick(state(events: [approved]), now: now)?.verb, "may edit", "approved verb stays whole")
eq(Toast.short("Reddit-Diskussion zu KI-Workflows", 18), "Reddit-Diskussion…", "long titles are cut with an ellipsis")
eq(Toast.short("billing refactor", 18), "billing refactor", "short titles stay")
check(Toast.pick(state(events: [CompanionState.Event(kind: "held", at: nowMs)]), now: now) == nil, "a bare held event is not news (the pending row is)")
check(Toast.pick(state(events: [CompanionState.Event(kind: "held-ask", at: nowMs, why: "no engine")]), now: now) == nil, "no-engine asks are not news")
eq(Toast.pick(state(compactionAt: nowMs - 3000), now: now)?.kind, "compacted", "a fresh compaction shows")
check(Toast.pick(state(compactionAt: nowMs - 3000), now: now)?.text.contains("291k → 57k") == true, "compaction numbers")
check(Toast.pick(state(events: [delivered]), now: now, dismissed: [delivered.key]) == nil, "dismissed stays away")
check(Toast.pick(nil, now: now) == nil, "no state, no toast")

// What the agent got: `followed` is null, false, or the command
let injJSON = #"{"count":3,"estTokens":120,"bySource":{"brain":{"count":2,"estTokens":100,"actionable":2,"followed":1,"followedShare":0.5}},"last":[{"at":1,"source":"brain","event":"PreToolUse:Bash","chars":90,"text":"Project Brain: use brain:search","commands":["search"],"followed":"search"},{"at":2,"source":"brain","event":"PreToolUse:Edit","chars":60,"text":"next: brain:radar","commands":["radar"],"followed":false},{"at":3,"source":"other","event":"PostToolUse:Write","chars":30,"text":"[impeccable]","commands":[],"followed":null}]}"#
if let inj = try? JSONDecoder().decode(CompanionState.Injections.self, from: Data(injJSON.utf8)) {
  eq(inj.brain?.followed, 1, "brain totals")
  eq(inj.last?.map { $0.followedCommand ?? "-" } ?? [], ["search", "-", "-"], "followed command")
  eq(inj.last?.map { $0.scored } ?? [], [true, true, false], "scored or not")
} else { check(false, "injections decode") }

// Resilience: a null where a number belongs costs a field, never the state
let brokenJSON = #"{"v":1,"at":"","atMs":1000,"machine":{"pressure":"warn"},"sessions":[{"id":"a","title":"Billing","ctx":196400,"limit":300000,"state":"tool","label":"Bash","injections":{"count":3,"estTokens":null,"last":[{"source":"brain","event":"PreToolUse","chars":null,"text":"x"}]}},"not a session",{"id":"b","title":null,"ctx":null,"state":"idle"}],"events":[{"kind":"held","at":1},{"kind":null}],"format":{"ok":"maybe"}}"#
do {
  let s = try CompanionState.decode(Data(brokenJSON.utf8))
  eq(s.sessions.count, 2, "the bad element is skipped, the others stay")
  eq(s.sessions[0].ctx, 196400, "good fields survive")
  eq(s.sessions[0].injections?.count, 3, "injections survive a null estTokens")
  eq(s.sessions[0].injections?.estTokens, 0, "null number reads as 0")
  eq(s.sessions[1].title, "b", "a missing title falls back to the id")
  eq(s.events?.count, 1, "a broken event is skipped")
  check(s.format == nil, "an unreadable format block is dropped")
} catch { check(false, "lenient decode: \(error)") }

// The first-launch hello: lowest priority, gone after its time or a click
let helloState = #"{"v":1,"atMs":1000,"sessions":[{"id":"a","title":"billing","state":"tool","ctx":1000,"limit":300000,"lastActivityMs":1000}]}"#
if let st = try? CompanionState.decode(Data(helloState.utf8)) {
  let t0 = Date(timeIntervalSince1970: 1)
  let hello = Toast.pick(st, now: t0, welcomeUntil: t0.addingTimeInterval(20))
  check(hello?.welcome == true, "the hello shows while nothing else speaks")
  check(hello?.text.contains("⌥⌘L") == true, "it says how to open the wall")
  check(Toast.pick(st, now: t0.addingTimeInterval(21), welcomeUntil: t0.addingTimeInterval(20)) == nil, "and leaves after its time")
  check(Toast.pick(st, now: t0, dismissed: [Toast.welcomeKey], welcomeUntil: t0.addingTimeInterval(20)) == nil, "or after Got it")
} else { check(false, "hello state decodes") }

// The real engine's output (tests/state-contract.test.mjs writes it): every part the app shows arrives
let fixtureURL = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
  .appendingPathComponent("Tests/Fixtures/engine-state.json")
if let data = try? Data(contentsOf: fixtureURL), let st = try? CompanionState.decode(data) {
  eq(st.sessions.count, 1, "engine fixture: the session decodes")
  let s0 = st.sessions[0]
  check(s0.ctx > 0 && s0.limit > 0, "engine fixture: context and mark")
  check(s0.lastCompaction != nil, "engine fixture: the compaction")
  check(s0.injections != nil, "engine fixture: what the agent got")
  check(s0.injections?.byKind?["answer"] != nil || s0.injections?.byKind?["hint"] != nil, "engine fixture: injections by kind")
  check(st.receipt?.got?.hints != nil, "engine fixture: the receipt's command hints")
  eq(st.openPending.count, 1, "engine fixture: the held edit")
  check(st.today != nil, "engine fixture: today's numbers")
  check(s0.contextMap?.parts.isEmpty == false, "engine fixture: what fills the context")
  eq(st.activeHolds.count, 1, "engine fixture: the hold")
  check((st.events ?? []).count >= 2, "engine fixture: the events")
  check(st.receipt?.trim != nil, "engine fixture: the receipt")
  check(st.format != nil, "engine fixture: the format verdict")
  check(st.machine.pressure != nil, "engine fixture: the machine")
} else { check(false, "the engine fixture decodes (\(fixtureURL.path))") }

// The setup check as the engine prints it
let checkJSON = #"{"ok":false,"checks":[{"id":"node","status":"ok","text":"node 24.4.0"},{"id":"hook","status":"fail","text":"not in ~/.claude/settings.json","fix":"leanlamp init"},{"id":"speed","status":"later"},{"id":"app","status":"warn","text":"built, not running","fix":"leanlamp open"}]}"#
if let r = SetupReport.decode(Data(checkJSON.utf8)) {
  eq(r.checks.map(\.id), ["node", "hook", "app"], "a malformed check row is skipped, the rest stay")
  eq(r.failures, 1, "one failure")
  check(r.needsConnect, "a missing hook asks for Connect")
  eq(r.checks[1].mark, "✗", "fail mark")
} else { check(false, "setup report decodes") }
check(SetupReport.decode(Data("not json".utf8)) == nil, "garbage is no report")

// One bad held edit must not hide the others
let mixedPending = #"{"v":1,"atMs":1000,"sessions":[],"pending":[{"id":"p1","tool":"Edit","deadline":"soon"},{"id":"p2","tool":"Edit","deadline":40000}],"holds":[{"id":"h1"},{"id":"h2","glob":"src/**"}]}"#
if let s = try? CompanionState.decode(Data(mixedPending.utf8)) {
  eq(s.openPending.map(\.id), ["p2"], "the readable held edit survives")
  eq(s.activeHolds.map(\.id), ["h2"], "the readable hold survives")
} else { check(false, "mixed pending decodes") }

// Memory: the second interruption
var memState = state()
memState.machine = CompanionState.Machine(pressure: "warn", orphans: 2, orphanMb: 1600)
let mem = Toast.pick(memState, now: now)
eq(mem?.kind, "memory", "warn + orphans interrupts")
check(mem?.reclaimable == true, "reclaimable")
eq(mem?.number, "1.6 GB", "what comes back")
memState.machine = CompanionState.Machine(pressure: "warn", orphans: 0, orphanMb: 0)
check(Toast.pick(memState, now: now) == nil, "warn with nothing of ours is no interruption")
memState.machine = CompanionState.Machine(pressure: "critical", orphans: 0, orphanMb: 0)
check(Toast.pick(memState, now: now)?.reclaimable == false, "critical always speaks, nothing to reclaim")
check(Toast.pick(memState, now: now, dismissed: ["memory|critical|0"]) == nil, "Later keeps it away")
memState.machine = CompanionState.Machine(pressure: "critical", orphans: 1, orphanMb: 300)
eq(Toast.pick(state(pending: [p]), now: now)?.kind, "held", "a held edit wins over memory")

// Transcript format
let fmtOK = try? JSONDecoder().decode(CompanionState.Format.self, from: Data(#"{"ok":true,"versions":["2.1.296","2.1.304"],"newestTested":"2.1.307","newerThanTested":false,"issues":[]}"#.utf8))
eq(fmtOK?.line, "transcript format ok · Claude Code 2.1.296, 2.1.304", "format ok line")
let fmtBad = try? JSONDecoder().decode(CompanionState.Format.self, from: Data(#"{"ok":false,"versions":["9.0.0"],"newestTested":"2.1.307","newerThanTested":true,"issues":[{"session":"a","title":"billing","issues":["assistant records carry no usage: context cannot be read"]}]}"#.utf8))
eq(fmtBad?.line, "transcript format changed: billing: assistant records carry no usage: context cannot be read", "format drift line")

// VoiceOver
eq(Speech.island(state: nil, engine: .off, toast: nil), "leanlamp. The engine is not running.", "speech, engine off")
let speechState = state(pending: [p])
let heldToast = Toast.pick(speechState, now: now)
eq(Speech.island(state: speechState, engine: .live, toast: heldToast), "leanlamp. 1 live session. fullest: Billing refactor, 57k of 300k context. needs you: Billing refactor wants to edit src/billing/invoice.ts, 32s left", "the large workspace, held edit")

// The wall by keyboard
eq(WallKey.from(keyCode: 125, characters: nil, modifiers: false), .move(1), "↓ moves down")
eq(WallKey.from(keyCode: 0, characters: "A", modifiers: false), .approve, "A approves")
eq(WallKey.from(keyCode: 0, characters: "a", modifiers: true), nil, "⌘A is the system's")
eq(WallKey.from(keyCode: 0, characters: "3", modifiers: false), .jump(2), "3 jumps to the third")
eq(WallKey.from(keyCode: 0, characters: "x", modifiers: false), nil, "other keys pass")
eq(WallKey.cursor(nil, .move(1), count: 3), 0, "first ↓ lands on the top row")
eq(WallKey.cursor(nil, .move(-1), count: 3), 2, "first ↑ lands on the bottom row")
eq(WallKey.cursor(2, .move(1), count: 3), 2, "stops at the end")
eq(WallKey.cursor(1, .jump(5), count: 3), 1, "a jump past the rows stays")
eq(WallKey.cursor(4, .steer, count: 2), 1, "rows went away: clamp")
eq(WallKey.cursor(0, .move(1), count: 0), nil, "no rows, no cursor")

// What fills the context
let mapBash = ContextMap(ctx: 200_000, base: 60_000, parts: [.init(kind: "bash", tokens: 70_000), .init(kind: "base", tokens: 60_000), .init(kind: "read", tokens: 40_000)])
eq(mapBash.advice?.part.kind, "bash", "the biggest part the agent controls gets the note")
let mapBase = ContextMap(ctx: 100_000, base: 70_000, parts: [.init(kind: "base", tokens: 70_000), .init(kind: "summary", tokens: 20_000), .init(kind: "read", tokens: 10_000)])
check(mapBase.advice == nil, "no note when no part the agent controls is a quarter")
eq(ContextMap.name("base"), "system + tools", "the measured base by name")

// Parking: what sessions.mjs writes, decoded forgivingly
let parkJSON = #"""
{"openMb":3972,"idleMb":2170,"idleHours":2,"open":[{"pid":1,"sessionId":"a","title":"vinyl-reel-42","mb":421,"park":true,"lastMessageMs":1},{"pid":"bad"}],"parked":[{"sessionId":"b","title":"export","goal":"build the export","resume":"cd ~/w && claude --resume b"},{"title":3}]}
"""#
if let p = try? JSONDecoder().decode(Parking.self, from: Data(parkJSON.utf8)) {
  eq(p.open.count, 1, "a bad open row costs that row only")
  eq(p.quiet.map { $0.sessionId }, ["a"], "quiet = parkable")
  eq(p.parked.first?.goal, "build the export", "the card keeps the first ask")
  eq(p.parked.count, 1, "a bad card costs that card only")
} else { check(false, "parking decodes") }
eq(mbText(2170), "2.1 GB", "GB from 1024 MB on")
eq(mbText(421), "421 MB", "MB below")
eq(agoText(Date().timeIntervalSince1970 * 1000 - 3 * 3600_000), "3 h ago", "hours ago")

print(failures == 0 ? "✔ \(passed) checks passed" : "✖ \(failures) failed, \(passed) passed")
exit(failures == 0 ? 0 : 1)
