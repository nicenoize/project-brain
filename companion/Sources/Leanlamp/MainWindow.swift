import AppKit
import SwiftUI
import LeanlampCore

/// The full window: Sessions (every agent, large), Receipt (what the last
/// days cost and what the companion did), Machine (memory, holds, idle
/// sessions). Same state file, same actions as the island.
final class MainWindowController: NSObject, NSWindowDelegate {
  private var window: NSWindow?
  private let store: StateStore
  private let actions: Actions
  private let connect: () -> Void

  init(store: StateStore, actions: Actions, connect: @escaping () -> Void) {
    self.store = store
    self.actions = actions
    self.connect = connect
  }

  func show(tab: WindowTab = .sessions) {
    if window == nil {
      let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 740), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
      w.titlebarAppearsTransparent = true
      w.titleVisibility = .hidden
      w.isMovableByWindowBackground = true
      w.backgroundColor = .black
      w.appearance = NSAppearance(named: .darkAqua)
      w.minSize = NSSize(width: 900, height: 560)
      w.isReleasedWhenClosed = false
      w.delegate = self
      w.center()
      w.setFrameAutosaveName("leanlamp.main")
      window = w
    }
    window?.contentView = NSHostingView(rootView: WindowRoot(store: store, actions: actions, initial: tab, connect: connect))
    // LEANLAMP_WINDOW_BEHIND=1 (screenshots): open behind everything, never take focus.
    if ProcessInfo.processInfo.environment["LEANLAMP_WINDOW_BEHIND"] == "1" { window?.orderBack(nil); return }
    NSApp.activate(ignoringOtherApps: true)
    window?.makeKeyAndOrderFront(nil)
  }
}

enum WindowTab: String, CaseIterable, Identifiable {
  case sessions, parking, receipt, machine
  var id: String { rawValue }
  var title: String { self == .parking ? "PARKED" : rawValue.uppercased() }
}

struct WindowRoot: View {
  @ObservedObject var store: StateStore
  @ObservedObject var actions: Actions
  @State var tab: WindowTab
  let connect: () -> Void

  init(store: StateStore, actions: Actions, initial: WindowTab, connect: @escaping () -> Void) {
    self.store = store
    self.actions = actions
    self.connect = connect
    _tab = State(initialValue: initial)
  }

  var body: some View {
    let state = store.fresh
    VStack(spacing: 0) {
      HStack(alignment: .lastTextBaseline, spacing: 28) {
        Text("leanlamp").font(Theme.title(26)).foregroundStyle(.white)
        ForEach(WindowTab.allCases) { t in
          Button { tab = t } label: {
            VStack(spacing: 6) {
              Text(t.title).font(Theme.label(11)).kerning(1).foregroundStyle(tab == t ? .white : Theme.muted)
              Rectangle().fill(tab == t ? Theme.accent : .clear).frame(height: 3)
            }
            .fixedSize()
          }
          .buttonStyle(.plain)
        }
        Spacer()
        Text(statusLine(state)).font(Theme.label(10)).kerning(0.8).foregroundStyle(store.engineStatus == .off ? Theme.accent : Theme.muted)
      }
      .padding(.horizontal, 32)
      .padding(.top, 34)
      .padding(.bottom, 14)
      .overlay(alignment: .bottom) { Rectangle().fill(Color.white).frame(height: 2) }

      Group {
        switch tab {
        case .sessions: SessionsTab(store: store, actions: actions)
        case .parking: ParkingTab(store: store, actions: actions)
        case .receipt: ReceiptTab(store: store, actions: actions)
        case .machine: MachineTab(store: store, actions: actions, connect: connect)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
    .background(Color.black)
    .preferredColorScheme(.dark)
  }

  private func statusLine(_ s: CompanionState?) -> String {
    switch store.engineStatus {
    case .off: return "ENGINE OFF — npm run brain:companion -- --watch"
    case .starting: return "STARTING"
    case .live:
      guard let s else { return "LIVE" }
      return "\(s.live.count) LIVE · CONTROL \(s.reachableCount)/\(s.sessions.count)"
    }
  }
}

// MARK: - Parked

/// Sessions left open only to keep their context: park them (a card keeps
/// what they were about, RAM comes back), find them here, resume in Terminal.
struct ParkingTab: View {
  @ObservedObject var store: StateStore
  @ObservedObject var actions: Actions

  var body: some View {
    ScrollView { ParkingContent(store: store, actions: actions) }
  }
}

/// The tab's content without its scroll view (ImageRenderer draws no ScrollView).
struct ParkingContent: View {
  @ObservedObject var store: StateStore
  @ObservedObject var actions: Actions

  var body: some View {
    let p = store.fresh?.parking
    Group {
      VStack(alignment: .leading, spacing: 0) {
        HStack(alignment: .top, spacing: 0) {
          ReceiptColumn(label: "OPEN", lead: p.map { mbText($0.openMb) } ?? "—", leadCaption: "\(p?.open.count ?? 0) sessions with their MCP servers", rows: [], hot: false)
          ReceiptColumn(label: "QUIET", lead: p.map { mbText($0.idleMb) } ?? "—", leadCaption: "\(p?.quiet.count ?? 0) without a message for \(Int(p?.idleHours ?? 2)) h", rows: [], hot: (p?.idleMb ?? 0) >= 1024)
          ReceiptColumn(label: "PARKED", lead: "\(p?.parked.count ?? 0)", leadCaption: "cards: what each was about, how to resume", rows: [], hot: false)
        }
        .fixedSize(horizontal: false, vertical: true)
        .overlay(alignment: .bottom) { Theme.rule.frame(height: 1) }
        if let p, !p.quiet.isEmpty {
          HStack(spacing: 12) {
            SquareButton(title: "Park all quiet · \(mbText(p.idleMb)) back", fill: Theme.accent, text: Theme.ink, border: Theme.accent, height: 32) {
              actions.parkAll(p.quiet.map { $0.sessionId })
            }
            Text("Each keeps a card here; the transcript stays, claude --resume brings it all back.").font(Theme.body(11)).foregroundStyle(Theme.muted)
            Spacer()
          }
          .padding(.horizontal, 32).padding(.vertical, 20)
        }
        if let p, !p.leftovers.isEmpty {
          HStack(spacing: 12) {
            SquareButton(title: "Stop leftovers · \(mbText(p.leftoverMb))", fill: .clear, text: .white, border: .white, height: 32) { actions.cleanLeftovers() }
            Text("\(p.leftovers.count) process\(p.leftovers.count == 1 ? "" : "es") closed sessions left running from their scratchpad: \(p.leftovers.compactMap { $0.command.map { String($0.split(separator: " ").first.map { ($0 as NSString).lastPathComponent } ?? "") } }.joined(separator: ", "))")
              .font(Theme.body(11)).foregroundStyle(Theme.muted).lineLimit(1)
            Spacer()
          }
          .padding(.horizontal, 32).padding(.bottom, 8)
        }
        Text("OPEN").font(Theme.label(11)).kerning(1).foregroundStyle(Theme.muted).padding(.horizontal, 32).padding(.top, 20).padding(.bottom, 8)
        ForEach(p?.open ?? []) { o in OpenRow(open: o, parking: actions.parking.contains(o.sessionId)) { actions.park(o.sessionId) } }
        if p == nil {
          Text("Waiting for the engine (it looks every 30 s).").font(Theme.body(13)).foregroundStyle(Theme.muted).padding(32)
        }
        if let cards = p?.parked, !cards.isEmpty {
          Text("PARKED").font(Theme.label(11)).kerning(1).foregroundStyle(Theme.muted).padding(.horizontal, 32).padding(.top, 28).padding(.bottom, 8)
          ForEach(cards) { c in CardRow(card: c) { actions.resume(c.sessionId) } }
        }
      }
      .padding(.bottom, 32)
    }
  }
}

struct OpenRow: View {
  let open: Parking.Open
  let parking: Bool
  let park: () -> Void

  var body: some View {
    HStack(spacing: 16) {
      Rectangle().fill(open.park ? Theme.accent : open.why == "working" ? Color.white : Theme.gray).frame(width: 8, height: 8)
      Text(open.title).font(Theme.strong(13)).foregroundStyle(.white).lineLimit(1).frame(width: 260, alignment: .leading)
      Text(open.project ?? "").font(Theme.body(12)).foregroundStyle(Theme.muted).lineLimit(1).frame(width: 180, alignment: .leading)
      Text(agoText(open.lastMessageMs)).font(Theme.body(12)).foregroundStyle(Theme.muted).frame(width: 110, alignment: .leading)
      Text(mbText(open.mb)).font(Theme.strong(12)).foregroundStyle(.white).frame(width: 80, alignment: .trailing)
      Spacer()
      if parking {
        Text("PARKING").font(Theme.label(10)).kerning(1).foregroundStyle(Theme.accent)
      } else if open.park {
        SquareButton(title: "Park", fill: .clear, text: .white, border: .white, height: 26, action: park)
      } else {
        Text(open.why == "working" ? "WORKING" : open.why == "recent" ? "IN USE" : "—").font(Theme.label(10)).kerning(1).foregroundStyle(Theme.grayText)
      }
    }
    .padding(.horizontal, 32)
    .frame(height: 44)
    .overlay(alignment: .bottom) { Theme.rule.frame(height: 1) }
  }
}

struct CardRow: View {
  let card: Parking.Card
  let resume: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .firstTextBaseline, spacing: 12) {
        Text(card.title).font(Theme.strong(14)).foregroundStyle(.white).lineLimit(1)
        Text([card.project, card.branch].compactMap { $0 }.joined(separator: " @ ")).font(Theme.body(12)).foregroundStyle(Theme.muted).lineLimit(1)
        Spacer()
        Text("last message \(agoText(card.lastMessageMs))").font(Theme.label(10)).kerning(0.6).foregroundStyle(Theme.grayText)
        SquareButton(title: "Resume in Terminal", fill: .clear, text: .white, border: .white, height: 26, action: resume)
      }
      if let g = card.goal { line("ASKED", g) }
      if let a = card.lastAsk { line("LAST", a) }
      if let s = card.lastAgent { line("STOOD", s) }
      if let e = card.edited, !e.isEmpty { line("EDITED", e.joined(separator: ", ")) }
      if let r = card.resume {
        Text(r).font(Theme.body(11)).foregroundStyle(Theme.grayText).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
      }
    }
    .padding(.horizontal, 32).padding(.vertical, 14)
    .overlay(alignment: .bottom) { Theme.rule.frame(height: 1) }
  }

  private func line(_ label: String, _ text: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Text(label).font(Theme.label(10)).kerning(1).foregroundStyle(Theme.accent).frame(width: 56, alignment: .leading)
      Text(text).font(Theme.body(12)).foregroundStyle(.white).lineLimit(2)
    }
  }
}

// MARK: - Sessions

struct SessionsTab: View {
  @ObservedObject var store: StateStore
  @ObservedObject var actions: Actions
  @State private var steering: String?
  @State private var showingGot: String?

  var body: some View {
    let state = store.fresh
    ScrollView {
      VStack(spacing: 0) {
        ForEach(state?.openPending ?? []) { p in
          PendingRow(pending: p, actions: actions).frame(height: 52)
        }
        // LEANLAMP_GOT_FIRST=1 (screenshots): open the first session's "what it got"
        Color.clear.frame(height: 0).onAppear {
          if ProcessInfo.processInfo.environment["LEANLAMP_GOT_FIRST"] == "1", showingGot == nil {
            showingGot = store.fresh?.live.first(where: { ($0.injections?.count ?? 0) > 0 })?.sessionId
          }
        }
        let sessions = (state?.live ?? []) + (state?.idle ?? [])
        if sessions.isEmpty {
          Text(store.engineStatus == .live ? "No session in the last four hours. Start claude in a terminal." : "Waiting for the engine.")
            .font(Theme.body(13)).foregroundStyle(Theme.muted).padding(32)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        ForEach(sessions) { s in
          BigSessionRow(session: s, steering: steering == s.sessionId, showingGot: showingGot == s.sessionId, actions: actions, toggleSteer: {
            steering = steering == s.sessionId ? nil : s.sessionId
          }, toggleGot: {
            showingGot = showingGot == s.sessionId ? nil : s.sessionId
          })
        }
      }
    }
  }
}

struct BigSessionRow: View {
  @State private var draft = ""
  let session: CompanionState.Session
  let steering: Bool
  let showingGot: Bool
  @ObservedObject var actions: Actions
  let toggleSteer: () -> Void
  let toggleGot: () -> Void

  var body: some View {
    let needsYou = session.state == "waiting" || (session.held ?? 0) > 0
    let hot = Gauge.isHot(fraction: session.fraction, needsYou: needsYou)
    let idle = session.isIdle
    VStack(spacing: 0) {
      HStack(alignment: .center, spacing: 22) {
        Segments(filled: Gauge.filled(fraction: session.fraction), on: hot ? Theme.accent : (idle ? Theme.gray : .white), off: Theme.dim, height: 34)
          .scaleEffect(x: 1.6, y: 1, anchor: .leading)
          .frame(width: 60, alignment: .leading)
        VStack(alignment: .leading, spacing: 6) {
          HStack(spacing: 10) {
            Text(session.title).font(Theme.title(19)).foregroundStyle(idle ? Theme.muted : .white).lineLimit(1)
            if !session.reachable {
              Text("MONITOR").font(Theme.label(9)).kerning(0.6).foregroundStyle(Theme.grayText)
                .padding(.horizontal, 5).frame(height: 15).overlay(Rectangle().stroke(Theme.gray, lineWidth: 1))
            }
          }
          Text(metaLine).font(Theme.body(11)).foregroundStyle(Theme.muted).lineLimit(1)
          Text(nowLine).font(Theme.body(12)).foregroundStyle(needsYou || hot ? Theme.accent : (idle ? Theme.grayText : .white)).lineLimit(1).truncationMode(.middle)
        }
        Spacer(minLength: 12)
        VStack(alignment: .trailing, spacing: 4) {
          HStack(alignment: .lastTextBaseline, spacing: 4) {
            Text(Gauge.k(session.ctx)).font(Theme.number(34)).foregroundStyle(hot ? Theme.accent : (idle ? Theme.muted : .white))
            Text("/ \(Gauge.k(session.limit))").font(Theme.body(11)).foregroundStyle(Theme.muted)
          }
          Text(limitLine).font(Theme.body(10)).foregroundStyle(Theme.grayText)
        }
        VStack(spacing: 8) {
          if let inj = session.injections, inj.count > 0 {
            SquareButton(title: showingGot ? "Close" : "Got \(inj.count)", fill: .clear, text: Theme.muted, border: Theme.gray, height: 28, action: toggleGot)
          }
          if session.reachable && !idle {
            SquareButton(title: steering ? "Close" : "Steer", fill: .clear, text: .white, border: .white, height: 28, action: toggleSteer)
          }
        }
        .frame(width: 92, alignment: .trailing)
      }
      .padding(.horizontal, 32)
      .padding(.vertical, 16)
      if steering {
        if let map = session.contextMap {
          ContextMapRow(map: map) { draft = $0 }
            .frame(height: PanelContent.mapRow)
            .padding(.horizontal, 18)
        }
        SteerField(session: session, actions: actions, text: $draft, close: toggleSteer)
          .frame(height: 46)
          .padding(.horizontal, 18)
      }
      if showingGot, let inj = session.injections {
        GotDrawer(injections: inj)
          .padding(.horizontal, 32)
          .padding(.bottom, 16)
      }
    }
    .overlay(alignment: .bottom) { Theme.rule.frame(height: 1) }
  }

  private var metaLine: String {
    var parts: [String] = []
    if let p = session.project { parts.append(p) }
    if let b = session.gitBranch, !b.isEmpty, b != "HEAD" { parts.append(b) }
    if let m = session.model { parts.append(m.replacingOccurrences(of: "claude-", with: "")) }
    if session.compactions > 0 { parts.append("\(session.compactions)× compacted") }
    if session.burnPerMin > 0 { parts.append("+\(Gauge.k(session.burnPerMin))/min") }
    if let pid = session.pid { parts.append("pid \(pid)") }
    return parts.joined(separator: " · ")
  }

  private var nowLine: String {
    if let h = session.held, h > 0 { return "waiting for your answer on an edit" }
    if let n = session.inbox, n > 0 { return "\(n) note\(n == 1 ? "" : "s") queued · \(session.label)" }
    return session.state == "waiting" ? "waiting for you" : session.label
  }

  private var limitLine: String {
    switch session.limitSource {
    case "settings", "settings.local": return "compacts at \(Gauge.k(session.limit)) (project settings)"
    case "user settings": return "compacts at \(Gauge.k(session.limit)) (user settings)"
    case "compaction": return "compacted near \(Gauge.k(session.limit)) before"
    default: return "model window"
    }
  }
}

// MARK: - Receipt

struct ReceiptTab: View {
  @ObservedObject var store: StateStore
  @ObservedObject var actions: Actions

  var body: some View {
    let r = store.fresh?.receipt ?? store.state?.receipt
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        if let r {
          HStack(alignment: .top, spacing: 0) {
            ReceiptColumn(label: "TRIM", lead: Gauge.k(r.trim.contextP50), leadCaption: "median context per request", rows: [
              ("p90", Gauge.k(r.trim.contextP90)),
              ("input spent above 500k", percent(r.trim.shareAbove500k)),
              ("compactions", "\(r.trim.compactions)"),
              ("prepared in advance", percent(r.trim.precomputedShare)),
              ("wait for the others (median)", r.trim.waitSeconds.map { String(format: "%.0f s", $0) } ?? "—")
            ], hot: r.trim.shareAbove500k >= 0.2)
            if let b = r.got?.hints {
              let kinds = r.got?.byKind
              ReceiptColumn(label: "GOT", lead: Gauge.k(b.estTokens ?? 0), leadCaption: "tokens of command hints the brain injected", rows: [
                ("hints", "\(b.count)"),
                ("followed within 5 calls", "\(b.followed ?? 0)"),
                ("follow rate", followRate(b.followedShare)),
                ("answers before edits", kinds?["answer"].map { "\(Gauge.k($0.estTokens ?? 0)) tok" } ?? "—"),
                ("state after compaction", kinds?["state"].map { "\(Gauge.k($0.estTokens ?? 0)) tok" } ?? "—"),
                ("other hooks and plugins", r.got?.bySource?["other"].map { "\(Gauge.k($0.estTokens ?? 0)) tok" } ?? "—")
              ], hot: (b.followedShare ?? 0) < 0.05 && (b.actionable ?? 0) >= 20)
            }
            ReceiptColumn(label: "GUARD", lead: "\(r.guardian.held)", leadCaption: "edits held for your answer", rows: [
              ("approved", "\(r.guardian.approved)"),
              ("  from the notch", "\(r.guardian.approvedFromNotch)"),
              ("declined", "\(r.guardian.denied)"),
              ("handed back to the terminal", "\(r.guardian.handedBack)")
            ], hot: false)
            ReceiptColumn(label: "STEER", lead: "\(r.steer.delivered)", leadCaption: "notes delivered to running agents", rows: [
              ("median wait for a tool call", r.steer.medianWaitSeconds.map { String(format: "%.1f s", $0) } ?? "—")
            ], hot: false)
          }
          .fixedSize(horizontal: false, vertical: true)
          .overlay(alignment: .bottom) { Theme.rule.frame(height: 1) }

          ProjectTable(projects: r.projects)
            .padding(.horizontal, 32)
            .padding(.top, 24)

          HStack {
            Text("last \(r.days) days · \(r.source.transcripts) transcripts · \(String(format: "%.1f", r.source.bytes / 1e9)) GB read in \(String(format: "%.1f", r.source.ms / 1000)) s · \(computedAt(r.atMs)) · all numbers from your own transcripts and the companion bus · nothing left this machine")
              .font(Theme.body(10)).foregroundStyle(Theme.grayText).lineLimit(2)
            Spacer()
            SquareButton(title: actions.computingReceipt ? "…" : "Recompute", fill: .clear, text: .white, border: .white, height: 30) { actions.recomputeReceipt() }
          }
          .padding(32)
        } else {
          VStack(alignment: .leading, spacing: 14) {
            Text("No receipt yet.").font(Theme.title(22)).foregroundStyle(.white)
            Text("The engine computes one every hour from the last 14 days of transcripts (about 10 s for 2 GB).").font(Theme.body(12)).foregroundStyle(Theme.muted)
            SquareButton(title: actions.computingReceipt ? "Computing…" : "Compute now", fill: .white, text: Theme.ink, border: .white, height: 32) { actions.recomputeReceipt() }
          }
          .padding(32)
        }
      }
    }
  }

  private func percent(_ x: Double) -> String { "\(Int((x * 100).rounded())) %" }
  private func followRate(_ x: Double?) -> String {
    guard let x else { return "—" }
    return x > 0 && x < 0.01 ? String(format: "%.1f %%", x * 100) : "\(Int((x * 100).rounded())) %"
  }
  private func computedAt(_ ms: Double) -> String {
    let f = DateFormatter(); f.dateFormat = "HH:mm"
    return "computed \(f.string(from: Date(timeIntervalSince1970: ms / 1000)))"
  }
}

struct ReceiptColumn: View {
  let label: String
  let lead: String
  let leadCaption: String
  let rows: [(String, String)]
  let hot: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(label).font(Theme.label(11)).kerning(1.2).foregroundStyle(Theme.accent)
      Text(lead).font(Theme.number(64)).foregroundStyle(hot ? Theme.accent : .white).lineLimit(1).minimumScaleFactor(0.5)
      Text(leadCaption).font(Theme.body(11)).foregroundStyle(Theme.muted)
      Rectangle().fill(Theme.rule).frame(height: 1).padding(.vertical, 6)
      ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
        HStack {
          Text(row.0).font(Theme.body(12)).foregroundStyle(Theme.muted)
          Spacer()
          Text(row.1).font(Theme.strong(12)).foregroundStyle(.white)
        }
      }
    }
    .padding(32)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .overlay(alignment: .trailing) { Theme.rule.frame(width: 1) }
  }
}

struct ProjectTable: View {
  let projects: [CompanionState.Receipt.Project]

  var body: some View {
    VStack(spacing: 0) {
      row(["PROJECT", "REQUESTS", "MEDIAN", "P90", "> 500K", "COMPACTS AT"], header: true, hot: false)
      ForEach(projects.prefix(14)) { p in
        row([p.project, "\(p.requests)", Gauge.k(p.contextP50), Gauge.k(p.contextP90), "\(Int((p.shareAbove500k * 100).rounded())) %", p.window.map { Gauge.k($0) } ?? "model default"], header: false, hot: p.shareAbove500k >= 0.2)
      }
    }
  }

  private func row(_ cells: [String], header: Bool, hot: Bool) -> some View {
    HStack(spacing: 0) {
      ForEach(Array(cells.enumerated()), id: \.offset) { i, c in
        Text(c)
          .font(header ? Theme.label(10) : (i == 0 ? Theme.strong(12) : Theme.body(12)))
          .kerning(header ? 0.8 : 0)
          .foregroundStyle(header ? Theme.muted : (hot && (i == 4 || i == 3) ? Theme.accent : .white))
          .lineLimit(1)
          .frame(maxWidth: i == 0 ? .infinity : 120, alignment: i == 0 ? .leading : .trailing)
      }
    }
    .padding(.vertical, 9)
    .overlay(alignment: .bottom) { (header ? Color.white : Theme.rule).frame(height: header ? 2 : 1) }
  }
}

// MARK: - Machine

struct MachineTab: View {
  @ObservedObject var store: StateStore
  @ObservedObject var actions: Actions
  let connect: () -> Void

  var body: some View {
    let s = store.fresh
    let m = s?.machine
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        HStack(alignment: .top, spacing: 0) {
          ReceiptColumn(label: "MEMORY", lead: m?.freePct.map { "\(Int($0)) %" } ?? "—", leadCaption: "free of \(m?.totalGb.map { "\(Int($0)) GB" } ?? "?")", rows: [
            ("kernel pressure", m?.pressure ?? "—"),
            ("swap in use", m?.swapUsedGb.map { String(format: "%.1f GB", $0) } ?? "—")
          ], hot: m?.pressure == "warn" || m?.pressure == "critical")
          ReceiptColumn(label: "AGENTS", lead: m?.agentProcesses.map { "\($0)" } ?? "—", leadCaption: "agent processes running", rows: [
            ("resident memory", m?.agentRssGb.map { String(format: "%.1f GB", $0) } ?? "—"),
            ("orphaned helpers", m?.orphans.map { "\($0)" } ?? "—"),
            ("idle sessions (no message 10 min)", "\(s?.idle.count ?? 0)")
          ], hot: (m?.orphans ?? 0) > 0)
          ReceiptColumn(label: "HOLDS", lead: "\(s?.activeHolds.count ?? 0)", leadCaption: "globs whose edits wait for you", rows: (s?.activeHolds ?? []).map { h in
            (h.isAll ? "every edit, every repo" : "\(h.glob)\(h.project.map { " · \($0)" } ?? "")\((h.worktrees ?? 1) > 1 ? " +\((h.worktrees ?? 1) - 1) worktrees" : "")", h.minutesLeft.map { "\($0) min" } ?? "until released")
          }, hot: !(s?.activeHolds.isEmpty ?? true))
        }
        .fixedSize(horizontal: false, vertical: true)
        .overlay(alignment: .bottom) { Theme.rule.frame(height: 1) }
        HStack(spacing: 12) {
          if s?.holdsAll ?? false {
            SquareButton(title: "Release all holds", fill: Theme.accent, text: Theme.ink, border: Theme.accent, height: 32) { actions.releaseAll() }
          } else {
            SquareButton(title: "Hold all edits · 30 min", fill: .clear, text: .white, border: .white, height: 32) { actions.holdAll() }
            if !(s?.activeHolds.isEmpty ?? true) {
              SquareButton(title: "Release all holds", fill: .clear, text: .white, border: .white, height: 32) { actions.releaseAll() }
            }
          }
          Spacer()
          Text("What can go, and what is yours to close: npm run brain:ps").font(Theme.body(11)).foregroundStyle(Theme.muted)
        }
        .padding(32)
        // the live format line, until the setup check (which has its own FORMAT row) has run
        if let f = s?.format, !(actions.setup?.checks.contains { $0.id == "format" } ?? false) {
          HStack(spacing: 10) {
            Rectangle().fill(f.ok ? Color.white : Theme.accent).frame(width: 10, height: 10)
            Text(f.line).font(Theme.body(12)).foregroundStyle(f.ok ? Theme.muted : Theme.accent).lineLimit(2)
            Spacer()
          }
          .padding(.horizontal, 32)
          .padding(.bottom, 24)
        }
        SetupSection(actions: actions, connect: connect)
      }
    }
    .onAppear {
      // a fresh check when the tab opens (it measures the hook, ~3 s), at most every 5 min
      if actions.setupAt.map({ Date().timeIntervalSince($0) > 300 }) ?? true { actions.runCheck() }
    }
  }
}

/// `leanlamp init --check` in the window: one row per check, the fix next to what is wrong.
struct SetupSection: View {
  @ObservedObject var actions: Actions
  let connect: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .firstTextBaseline, spacing: 14) {
        Text("SETUP").font(Theme.label(11)).kerning(1).foregroundStyle(.white)
        Text(summary).font(Theme.body(12)).foregroundStyle((actions.setup?.failures ?? 0) > 0 ? Theme.accent : Theme.muted)
        Spacer()
        SquareButton(title: actions.checking ? "Checking…" : "Check again", fill: .clear, text: .white, border: .white, height: 28) { actions.runCheck() }
          .disabled(actions.checking)
      }
      .padding(.bottom, 14)
      ForEach(actions.setup?.checks ?? [], id: \.rowKey) { c in
        SetupRow(check: c, connect: connect)
      }
    }
    .padding(.horizontal, 32)
    .padding(.bottom, 32)
  }

  private var summary: String {
    guard let r = actions.setup else { return actions.checking ? "checking node, engine, hook, reach, formats, hook time…" : "not checked yet" }
    let at = actions.setupAt.map { DateFormatter.localizedString(from: $0, dateStyle: .none, timeStyle: .short) } ?? ""
    return r.failures == 0 ? "everything leanlamp needs is in place · \(at)" : "\(r.failures) thing\(r.failures == 1 ? "" : "s") to fix · \(at)"
  }
}

struct SetupRow: View {
  let check: SetupReport.Check
  let connect: () -> Void

  private var markColor: Color { check.status == .fail ? Theme.accent : check.status == .ok ? .white : Theme.muted }
  private var spoken: String {
    let what = check.status == .ok ? "OK" : check.status == .fail ? "Problem" : "Note"
    let fix = check.fix.map { ". Fix: \($0)" } ?? ""
    return "\(what): \(check.id), \(check.text)\(fix)"
  }

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Text(check.mark).font(Theme.body(13)).foregroundStyle(markColor).frame(width: 14, alignment: .leading)
      Text(check.id.uppercased()).font(Theme.label(10)).kerning(0.8).foregroundStyle(Theme.muted).frame(width: 64, alignment: .leading)
      Text(check.text).font(Theme.body(12)).foregroundStyle(check.status == .fail ? Color.white : Theme.muted).fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 12)
      fixView
    }
    .padding(.vertical, 7)
    .overlay(alignment: .bottom) { Theme.rule.frame(height: 1) }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(spoken)
  }

  @ViewBuilder private var fixView: some View {
    if check.id == "hook" && check.status == .fail {
      SquareButton(title: "Connect…", fill: Theme.accent, text: Theme.ink, border: Theme.accent, height: 26) { connect() }
    } else if let fix = check.fix {
      Text(fix).font(Theme.body(11)).foregroundStyle(Theme.muted).textSelection(.enabled)
    }
  }
}

/// The last things hooks put in front of this agent, newest first, with whether it acted on them.
struct GotDrawer: View {
  let injections: CompanionState.Injections

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text("WHAT IT GOT").font(Theme.label(10)).kerning(1).foregroundStyle(Theme.accent)
        Text("\(injections.count) snippet\(injections.count == 1 ? "" : "s") · ≈ \(injections.estTokens < 1000 ? "\(injections.estTokens)" : Gauge.k(injections.estTokens)) tokens this session").font(Theme.body(11)).foregroundStyle(Theme.muted)
        Spacer()
        if let b = injections.brain, let a = b.actionable, a > 0 {
          Text("followed \(b.followed ?? 0) of \(a) brain hints").font(Theme.body(11)).foregroundStyle((b.followedShare ?? 0) < 0.05 ? Theme.accent : .white)
        }
      }
      .padding(.vertical, 10)
      .overlay(alignment: .bottom) { Theme.rule.frame(height: 1) }
      ForEach(Array((injections.last ?? []).reversed().enumerated()), id: \.offset) { _, i in
        HStack(alignment: .top, spacing: 14) {
          Text(i.source.uppercased()).font(Theme.label(9)).kerning(0.6).foregroundStyle(i.source == "brain" ? Theme.accent : Theme.grayText).frame(width: 74, alignment: .leading)
          Text(i.event).font(Theme.body(10)).foregroundStyle(Theme.muted).frame(width: 140, alignment: .leading).lineLimit(1)
          Text(i.text.replacingOccurrences(of: "\n", with: " ")).font(Theme.body(11)).foregroundStyle(.white).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
          Text(verdict(i)).font(Theme.label(9)).kerning(0.6).foregroundStyle(i.followedCommand != nil ? .white : Theme.grayText).frame(width: 96, alignment: .trailing)
        }
        .padding(.vertical, 8)
        .overlay(alignment: .bottom) { Theme.rule.frame(height: 1) }
      }
    }
  }

  private func verdict(_ i: CompanionState.Injections.Injection) -> String {
    if let c = i.followedCommand { return "RAN \(c.uppercased())" }
    return i.scored ? "IGNORED" : "\(i.chars) CHARS"
  }
}
