import AppKit
import SwiftUI
import LeanlampCore

/// `leanlamp --render-demo <dir>`: the ten-second demo, rendered offscreen from
/// the real views and a fixed script — no screen capture, nothing of the
/// user's screen in it. Writes numbered PNG frames (30 fps) into <dir>;
/// `scripts/demo.sh` turns them into an MP4 and a GIF.
///
///   0.0–3.5 s  an agent works: the context climbs past 75 % and the gauge turns orange
///   3.5 s      it wants to edit a held file: the island lights up, Approve / Deny
///   5.2–6.4 s  the pointer moves to Approve and clicks
///   6.6 s      approved — the agent continues
///   8.6–10 s   the line: less context, same agent.
enum DemoRenderer {
  static let fps = 30.0
  static let seconds = 10.0
  /// The frame shows the top of a 14-inch MacBook Pro screen, 960 pt around the notch.
  static let size = CGSize(width: 960, height: 190)

  @MainActor
  static func run(outDir: String) -> Int32 {
    Fonts.register()
    try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
    let store = StateStore(path: "/dev/null/leanlamp-demo")
    let actions = Actions(script: nil, statePath: "/dev/null")
    let layout = NotchLayout(
      screen: CGRect(x: 0, y: 0, width: size.width, height: 600),
      notch: CGRect(x: (size.width - 185) / 2, y: 600 - 32, width: 185, height: 32),
      menuBarHeight: 37)
    let model = IslandModel(layout: layout)
    model.boot = .done
    let frames = Int(seconds * fps)
    for i in 0..<frames {
      let t = Double(i) / fps
      let state = script(at: t)
      store.injectForDemo(state, now: state.atMs)
      model.toast = Toast.pick(state, now: Date(timeIntervalSince1970: state.atMs / 1000))
      let view = DemoFrame(store: store, model: model, actions: actions, t: t)
        .frame(width: size.width, height: size.height)
      let renderer = ImageRenderer(content: view)
      renderer.scale = 2
      guard let img = renderer.cgImage else { FileHandle.standardError.write("frame \(i) failed\n".data(using: .utf8)!); return 1 }
      let rep = NSBitmapImageRep(cgImage: img)
      guard let png = rep.representation(using: .png, properties: [:]) else { return 1 }
      let name = String(format: "%@/frame-%04d.png", outDir, i)
      do { try png.write(to: URL(fileURLWithPath: name)) } catch { return 1 }
    }
    print("leanlamp: \(frames) frames → \(outDir)")
    return 0
  }

  /// The open wall at second `t` of the script, as one PNG (for docs and checks: nothing of the screen in it).
  @MainActor
  static func renderWall(to out: String, t: Double = 4.0) -> Int32 {
    Fonts.register()
    let store = StateStore(path: "/dev/null/leanlamp-demo")
    let actions = Actions(script: nil, statePath: "/dev/null")
    let layout = NotchLayout(
      screen: CGRect(x: 0, y: 0, width: size.width, height: 600),
      notch: CGRect(x: (size.width - 185) / 2, y: 600 - 32, width: 185, height: 32),
      menuBarHeight: 37)
    let model = IslandModel(layout: layout)
    model.boot = .done
    model.expanded = true
    model.keyboard = true
    model.cursor = 0
    model.steering = "s1"
    ContextMapRow.drawImmediately = true
    var state = script(at: t)
    // the billing session's context, shaped like a real one: a long test run fills it
    state.sessions[0].contextMap = ContextMap(ctx: 238_000, base: 61_000, scale: 1.9, since: "compaction", parts: [
      .init(kind: "bash", tokens: 84_000), .init(kind: "base", tokens: 61_000), .init(kind: "assistant", tokens: 38_000),
      .init(kind: "summary", tokens: 22_000), .init(kind: "read", tokens: 27_000), .init(kind: "you", tokens: 6_000)
    ], top: [.init(kind: "bash", label: "npm test -- billing", tokens: 52_000)])
    store.injectForDemo(state, now: state.atMs)
    let view = IslandView(store: store, model: model, actions: actions)
      .frame(width: layout.panelWidth, height: IslandShape.size(store: store, model: model).height)
    let renderer = ImageRenderer(content: view)
    renderer.scale = 2
    guard let img = renderer.cgImage, let png = NSBitmapImageRep(cgImage: img).representation(using: .png, properties: [:]) else { return 1 }
    do { try png.write(to: URL(fileURLWithPath: out)) } catch { return 1 }
    print("leanlamp: wall → \(out)")
    return 0
  }

  /// `leanlamp --render-parked <png>`: the PARKED tab with made-up sessions (never the user's).
  @MainActor
  static func renderParked(to out: String) -> Int32 {
    Fonts.register()
    let now = Date().timeIntervalSince1970 * 1000
    let h = 3_600_000.0
    let store = StateStore(path: "/dev/null/leanlamp-demo")
    let actions = Actions(script: nil, statePath: "/dev/null")
    var state = script(at: 1)
    func o(_ pid: Int, _ id: String, _ title: String, _ project: String, _ mb: Double, _ quiet: Double, park: Bool, why: String) -> Parking.Open {
      var x = Parking.Open(pid: pid, sessionId: id, title: title, mb: mb, park: park, lastMessageMs: now - quiet * h, why: why); x.project = project; return x
    }
    var c1 = Parking.Card(sessionId: "c1", title: "export-csv", goal: "build the CSV export for the guest lists, one file per event", resume: "cd ~/code/guestlist && claude --resume 6f1c…")
    c1.project = "guestlist"; c1.branch = "feature/export"; c1.lastAsk = "and the date column as ISO, please"
    c1.lastAgent = "Export works for single events; the multi-event zip is next. Tests: 41 passing."; c1.edited = ["src/export/csv.ts", "src/export/zip.ts", "tests/export.test.ts"]
    c1.lastMessageMs = now - 26 * h; c1.parkedAt = now - 2 * h
    var c2 = Parking.Card(sessionId: "c2", title: "billing-retry", goal: "why do failed invoices never retry?", resume: "cd ~/code/billing && claude --resume 9a04…")
    c2.project = "billing"; c2.branch = "fix/retry-backoff"; c2.lastAgent = "The cron skips invoices with a null next_attempt; fixed and covered, PR not opened yet."
    c2.edited = ["jobs/retry.ts"]; c2.lastMessageMs = now - 3 * 24 * h; c2.parkedAt = now - 2 * h
    state.parking = Parking(openMb: 3_970, idleMb: 2_170, open: [
      o(1, "s1", "billing-api", "billing", 412, 0.05, park: false, why: "working"),
      o(2, "s2", "landing-copy", "site", 288, 0.6, park: false, why: "recent"),
      o(3, "s3", "vinyl-reel-42", "vinyl-reel", 421, 24, park: true, why: "idle"),
      o(4, "s4", "notar-forms", "notar-forms", 296, 9 * 24, park: true, why: "idle"),
      o(5, "s5", "roomplanner-10", "roomplanner", 341, 8 * 24, park: true, why: "idle")
    ], parked: [c1, c2])
    state.parking?.idleHours = 2
    store.injectForDemo(state, now: now)
    let view = ParkingContent(store: store, actions: actions).frame(width: 1120, height: 820, alignment: .top).background(Color.black)
    let renderer = ImageRenderer(content: view)
    renderer.scale = 2
    guard let img = renderer.cgImage, let png = NSBitmapImageRep(cgImage: img).representation(using: .png, properties: [:]) else { return 1 }
    do { try png.write(to: URL(fileURLWithPath: out)) } catch { return 1 }
    print("leanlamp: parked → \(out)")
    return 0
  }

  /// When the edit is held: the toast springs out of the island.
  static let held = 3.5

  /// The app's urgent spring (response 0.34 s, damping 0.58), sampled: ImageRenderer runs no animations. PURE.
  static func spring(_ dt: Double) -> Double {
    if dt <= 0 { return 0 }
    let w = 2 * Double.pi / 0.34, z = 0.58
    let wd = w * (1 - z * z).squareRoot()
    return 1 - exp(-z * w * dt) * (cos(wd * dt) + z * w / wd * sin(wd * dt))
  }

  /// The state at second `t` of the script. PURE.
  static func script(at t: Double) -> CompanionState {
    let start = 1_792_656_000_000.0
    let nowMs = start + t * 1000
    let ease = { (x: Double) -> Double in x < 0 ? 0 : x > 1 ? 1 : x * x * (3 - 2 * x) }
    let ctx = Int(196_400 + 41_600 * ease(t / 3.5))
    var billing = CompanionState.Session(sessionId: "s1", title: "billing refactor", project: "acme/web", gitBranch: "split-invoices", ctx: ctx, limit: 300_000, limitSource: "settings", burnPerMin: 12_000, compactions: 2, state: "tool", label: "Bash · npm test -- billing")
    billing.control = true
    var timetable = CompanionState.Session(sessionId: "s2", title: "timetable mobile", project: "acme/app", ctx: 144_200, limit: 300_000, state: "thinking", label: "thinking")
    timetable.control = true
    var notes = CompanionState.Session(sessionId: "s3", title: "release notes", project: "acme/web", ctx: 58_100, limit: 300_000, state: "idle", label: "idle for 2 h")
    notes.control = true
    var pending: [CompanionState.Pending] = []
    var events: [CompanionState.Event] = []
    let heldAt = start + held * 1000
    let approvedAt = start + 6.6 * 1000
    if t >= held && t < 6.6 {
      billing.held = 1
      billing.label = "Edit · src/billing/invoice.ts"
      pending = [CompanionState.Pending(id: "p1", session: "s1", title: "billing refactor", tool: "Edit", shortFile: "src/billing/invoice.ts", at: heldAt, deadline: heldAt + 45_000)]
    }
    if t >= 6.6 {
      billing.label = "Edit · src/billing/invoice.ts"
      events = [CompanionState.Event(kind: "approved", at: approvedAt, session: "s1", title: "billing refactor", file: "src/billing/invoice.ts", shortFile: "src/billing/invoice.ts", by: "app")]
    }
    return CompanionState(atMs: nowMs, machine: CompanionState.Machine(totalGb: 24, freePct: 41, pressure: "normal", agentProcesses: 3, agentRssGb: 0.6, orphans: 0, orphanMb: 0),
                          sessions: [billing, timetable, notes], pending: pending, events: events,
                          today: CompanionState.Today(compactions: 4, prepared: 3, waitedSeconds: 11, held: t >= held ? 2 : 1, approved: t >= 6.6 ? 2 : 1, steered: 3))
  }
}

/// One frame: a dark desktop, the menu bar, the notch, the island, the toast,
/// a pointer, and at the end the line.
struct DemoFrame: View {
  @ObservedObject var store: StateStore
  @ObservedObject var model: IslandModel
  @ObservedObject var actions: Actions
  let t: Double

  var body: some View {
    let layout = model.layout
    ZStack(alignment: .top) {
      LinearGradient(colors: [Color(white: 0.20), Color(white: 0.14)], startPoint: .top, endPoint: .bottom)
      // menu bar
      HStack(spacing: 18) {
        Rectangle().fill(Color.white).frame(width: 13, height: 13)
        Text("Terminal").font(.system(size: 13, weight: .bold))
        Text("File"); Text("Edit"); Text("View"); Text("Window")
        Spacer()
        Text("Tue 14:03").font(.system(size: 12)).foregroundStyle(Color(white: 0.85))
      }
      .font(.system(size: 13))
      .foregroundStyle(.white)
      .padding(.horizontal, 16)
      .frame(height: layout.islandHeight)
      .background(Color(white: 0.11))
      // the island and its toast, as the app draws them: one shape that springs open
      let open = model.toast == nil ? 0 : DemoRenderer.spring(t - DemoRenderer.held)
      let width = layout.islandWidth + (layout.panelWidth - layout.islandWidth) * min(1, open)
      VStack(spacing: 0) {
        EarsRow(store: store, model: model, layout: layout, expanded: false)
          .frame(width: width, height: layout.islandHeight)
        if let toast = model.toast {
          ToastRow(toast: toast, actions: actions)
            .frame(width: layout.panelWidth, height: ToastRow.height)
            .opacity(min(1, max(0, (t - DemoRenderer.held - 0.05) / 0.18)))
        }
      }
      .frame(width: width, height: layout.islandHeight + ToastRow.height * max(0, open), alignment: .top)
      .background(alignment: .top) { ShapeFill(ears: layout.islandHeight, below: model.toast?.attention == true ? Theme.accent : .black) }
      .clipped()
      .frame(maxWidth: .infinity, alignment: .top)
      // the notch itself, over everything
      Rectangle().fill(Color.black).frame(width: layout.notch.width, height: 32)
      // pointer
      if let p = pointer() {
        Pointer(pressed: p.pressed).offset(x: p.x, y: p.y).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      }
      // the line
      if t >= 8.6 {
        let a = min(1, (t - 8.6) / 0.4)
        HStack(spacing: 14) {
          Segments(filled: 5, on: Theme.accent, off: Theme.dim, height: 20)
          Text("leanlamp").font(Theme.title(30)).foregroundStyle(.white)
          Text("less context, same agent.").font(Theme.body(15)).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.opacity(0.92))
        .opacity(a)
      }
    }
    .frame(width: DemoRenderer.size.width, height: DemoRenderer.size.height)
    .clipped()
  }

  /// Pointer path: from below the terminal to the Approve button, a click at 6.3 s.
  private func pointer() -> (x: CGFloat, y: CGFloat, pressed: Bool)? {
    guard t >= 5.0 && t < 8.4 else { return nil }
    let from = CGPoint(x: 520, y: 172), to = CGPoint(x: 690, y: 60)
    let k = max(0, min(1, (t - 5.0) / 1.2))
    let e = k * k * (3 - 2 * k)
    return (from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e, t >= 6.25 && t < 6.45)
  }
}

struct Pointer: View {
  let pressed: Bool
  var body: some View {
    Path { p in
      p.move(to: .zero); p.addLine(to: CGPoint(x: 0, y: 17)); p.addLine(to: CGPoint(x: 4.5, y: 13)); p.addLine(to: CGPoint(x: 7.5, y: 19.5))
      p.addLine(to: CGPoint(x: 10, y: 18.5)); p.addLine(to: CGPoint(x: 7, y: 12)); p.addLine(to: CGPoint(x: 12.5, y: 12)); p.closeSubpath()
    }
    .fill(Color.black)
    .overlay(Path { p in
      p.move(to: .zero); p.addLine(to: CGPoint(x: 0, y: 17)); p.addLine(to: CGPoint(x: 4.5, y: 13)); p.addLine(to: CGPoint(x: 7.5, y: 19.5))
      p.addLine(to: CGPoint(x: 10, y: 18.5)); p.addLine(to: CGPoint(x: 7, y: 12)); p.addLine(to: CGPoint(x: 12.5, y: 12)); p.closeSubpath()
    }.stroke(Color.white, lineWidth: 1.2))
    .scaleEffect(pressed ? 0.88 : 1, anchor: .topLeading)
    .frame(width: 14, height: 21, alignment: .topLeading)
  }
}
