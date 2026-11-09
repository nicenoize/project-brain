import SwiftUI
import LeanlampCore

/// The wall below the ears: edits waiting for you, every live session (click
/// one to steer it), then holds and the machine. Heights are fixed so the
/// window can be sized before the view lays out.
struct PanelContent: View {
  @ObservedObject var store: StateStore
  @ObservedObject var model: IslandModel
  @ObservedObject var actions: Actions
  @Namespace private var cursorSpace

  static let header: CGFloat = 46
  static let pendingRow: CGFloat = 44
  static let row: CGFloat = 46
  static let steerRow: CGFloat = 44
  static let mapRow: CGFloat = 78
  static let line: CGFloat = 30
  static let stats: CGFloat = 58
  static let footer: CGFloat = 44
  static let edge: CGFloat = 2
  static let maxRows = 6
  static let maxPending = 3

  /// `pending` comes from the fresh state: held edits can be answered while the engine is still starting.
  static func height(for state: CompanionState?, pending: Int, steering: Bool, engine: StateStore.EngineStatus, steeringId: String? = nil) -> CGFloat {
    let live = min(maxRows, state?.live.count ?? 0)
    var h = header + footer + edge
    if state?.today != nil { h += stats }
    h += CGFloat(min(maxPending, pending)) * pendingRow
    h += CGFloat(max(1, live)) * row
    if steering { h += steerRow }
    if let id = steeringId, state?.live.first(where: { $0.sessionId == id })?.contextMap != nil { h += mapRow }
    if (state?.idle.count ?? 0) > 0 { h += line }
    if let state, !state.live.isEmpty, state.reachableCount == 0 { h += line }
    if let f = state?.format, !f.ok { h += line }
    return h
  }

  var body: some View {
    let status = store.engineStatus
    let state = status == .live ? store.state : nil
    let live = Array((state?.live ?? []).prefix(Self.maxRows))
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        Text("Sessions").font(Theme.title(20)).foregroundStyle(.white)
        Text(subtitle(state)).font(Theme.body(11)).foregroundStyle(Theme.muted).lineLimit(1)
        Spacer(minLength: 8)
        Text(status == .off ? "ENGINE OFF" : status == .starting ? "STARTING" : controlLabel(state)).font(Theme.label()).kerning(0.8).foregroundStyle(status == .off ? Theme.accent : Theme.muted).lineLimit(1)
        SquareButton(title: "Open ↗", fill: .white, text: Theme.ink, border: .white, height: 26) {
          NotificationCenter.default.post(name: .leanlampOpenWindow, object: nil)
        }
      }
      .padding(.horizontal, 14)
      .frame(height: Self.header)
      .overlay(alignment: .bottom) { Theme.rule.frame(height: 1) }

      if let state, let today = state.today {
        TodayRow(today: today, liveContext: state.live.reduce(0) { $0 + $1.ctx })
          .frame(height: Self.stats)
          .overlay(alignment: .bottom) { Theme.rule.frame(height: 1) }
      }

      ForEach(Array((store.fresh?.openPending ?? []).prefix(Self.maxPending))) { p in
        PendingRow(pending: p, actions: actions).frame(height: Self.pendingRow)
      }

      if live.isEmpty {
        HStack {
          Text(status == .off ? "no engine — run: npm run brain:companion -- --watch" : status == .starting ? "reading the transcripts…" : "no live session — start claude in a terminal")
            .font(Theme.body(12)).foregroundStyle(Theme.muted)
          Spacer()
        }
        .padding(.horizontal, 14)
        .frame(height: Self.row)
        .overlay(alignment: .bottom) { Theme.rule.frame(height: 1) }
      } else {
        ForEach(Array(live.enumerated()), id: \.element.id) { index, session in
          SessionRow(session: session, selected: model.steering == session.sessionId)
            .frame(height: Self.row)
            .overlay(alignment: .leading) {
              if model.cursor == index {
                Theme.accent.frame(width: 4).matchedGeometryEffect(id: "cursor", in: cursorSpace)
              }
            }
            .animation(Motion.reduced ? nil : .spring(response: 0.26, dampingFraction: 0.82), value: model.cursor)
            .contentShape(Rectangle())
            .onTapGesture {
              guard let id = session.sessionId else { return }
              model.cursor = index
              model.steering = model.steering == id ? nil : id
            }
          if let id = session.sessionId, model.steering == id {
            if let map = session.contextMap {
              ContextMapRow(map: map) { model.steerDraft = $0 }
                .frame(height: Self.mapRow)
            }
            SteerField(session: session, actions: actions, text: $model.steerDraft) { model.steering = nil }
              .frame(height: Self.steerRow)
          }
        }
      }

      if let state, !state.live.isEmpty, state.reachableCount == 0 {
        HStack(spacing: 10) {
          Text(actions.hooksInstalled == true ? "connected — sessions started from now on can be steered" : "monitor only — steer and hold need one hook in your Claude settings")
            .font(Theme.body(11)).foregroundStyle(Theme.accent).lineLimit(1)
          Spacer(minLength: 6)
          if actions.hooksInstalled != true {
            SquareButton(title: "Connect", fill: Theme.accent, text: Theme.ink, border: Theme.accent, height: 22) {
              NotificationCenter.default.post(name: .leanlampConnect, object: nil)
            }
          }
        }
        .padding(.horizontal, 14)
        .frame(height: Self.line)
      }
      if let state, !state.idle.isEmpty {
        InfoLine(text: "\(state.idle.count) idle · brain:ps shows what can go", color: Theme.muted)
          .frame(height: Self.line)
      }
      if let f = state?.format, !f.ok {
        InfoLine(text: f.line, color: Theme.accent).frame(height: Self.line)
      }

      HStack(spacing: 10) {
        if model.keyboard && model.steering == nil {
          Text(WallKey.legend).font(Theme.body(11)).foregroundStyle(Theme.grayText).lineLimit(1)
            .transition(.opacity)
        } else {
          Text(machineLine(state?.machine)).font(Theme.body(11)).foregroundStyle(pressureColor(state?.machine)).lineLimit(1)
        }
        Spacer(minLength: 8)
        if let msg = actions.lastMessage {
          Text(msg).font(Theme.body(10)).foregroundStyle(Theme.accent).lineLimit(1).truncationMode(.tail)
        }
        holdButton(state)
      }
      .padding(.horizontal, 14)
      .frame(height: Self.footer)
    }
    .padding(.bottom, Self.edge)
  }

  @ViewBuilder private func holdButton(_ state: CompanionState?) -> some View {
    let all = state?.holdsAll ?? false
    let others = (state?.activeHolds.count ?? 0) - (all ? 1 : 0)
    if others > 0 {
      Text("\(others) hold\(others == 1 ? "" : "s")").font(Theme.body(11)).foregroundStyle(.white)
    }
    if all {
      SquareButton(title: "Release edits", fill: Theme.accent, text: Theme.ink, border: Theme.accent) { actions.releaseAll() }
    } else {
      SquareButton(title: "Hold all edits", fill: .clear, text: .white, border: .white) { actions.holdAll() }
    }
  }

  private func controlLabel(_ state: CompanionState?) -> String {
    guard let state else { return "LIVE" }
    let n = state.reachableCount
    return n == 0 ? "MONITOR ONLY" : "CONTROL \(n)/\(state.sessions.count)"
  }

  private func subtitle(_ state: CompanionState?) -> String {
    guard let state else { return "" }
    let projects = Array(Set(state.live.compactMap { $0.project })).sorted()
    let places = projects.prefix(3).joined(separator: " · ") + (projects.count > 3 ? " · +\(projects.count - 3)" : "")
    return places.isEmpty ? "\(state.sessions.count) sessions" : places
  }

  private func machineLine(_ m: CompanionState.Machine?) -> String {
    guard let m else { return "machine —" }
    var parts: [String] = []
    if let t = m.totalGb { parts.append("RAM \(Int(t)) GB") }
    if let f = m.freePct { parts.append("\(Int(f)) % free") }
    if let p = m.pressure { parts.append("pressure \(p)") }
    if let o = m.orphans, o > 0 { parts.append("\(o) orphan\(o == 1 ? "" : "s")") }
    return parts.joined(separator: " · ")
  }

  private func pressureColor(_ m: CompanionState.Machine?) -> Color {
    switch m?.pressure { case "warn", "critical": return Theme.accent; default: return Theme.muted }
  }
}

/// Today, live: what is in the contexts right now and what leanlamp did since midnight.
/// The digits roll when a number changes.
struct TodayRow: View {
  let today: CompanionState.Today
  let liveContext: Int

  var body: some View {
    HStack(spacing: 0) {
      Tile(value: Gauge.k(liveContext), label: "IN CONTEXT NOW")
      Tile(value: today.compactions == 0 ? "0" : "\(today.prepared)/\(today.compactions)", label: today.compactions == 0 ? "COMPACTIONS" : "COMPACTIONS PREPARED")
      Tile(value: "\(today.waitedSeconds)s", label: "WAITED ON COMPACTION", hot: today.waitedSeconds > 60)
      Tile(value: "\(today.steered)", label: "NOTES DELIVERED")
      Tile(value: "\(today.held)", label: today.held == 0 ? "EDITS HELD" : "HELD · \(today.approved)✓ \(today.denied)✗")
    }
    .padding(.horizontal, 14)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Today: \(Gauge.k(liveContext)) in context now, \(today.compactions) compactions, \(today.prepared) prepared, waited \(today.waitedSeconds) seconds, \(today.steered) notes delivered, \(today.held) edits held")
  }

  struct Tile: View {
    let value: String
    let label: String
    var hot = false
    var body: some View {
      VStack(alignment: .leading, spacing: 4) {
        Text(value).font(Theme.number(22)).foregroundStyle(hot ? Theme.accent : .white)
          .contentTransition(.numericText()).animation(Motion.reduced ? nil : .snappy, value: value)
        Text(label).font(Theme.label(8)).kerning(0.6).foregroundStyle(Theme.grayText).lineLimit(1)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

struct InfoLine: View {
  let text: String
  let color: Color
  var body: some View {
    HStack {
      Text(text).font(Theme.body(11)).foregroundStyle(color).lineLimit(1).truncationMode(.tail)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 14)
  }
}

/// What fills this session's context: one stacked bar (it draws in from the
/// left), the biggest parts by name, and, when one part the agent controls is a
/// quarter of the context or more, a note to steer with — one click puts it in
/// the field below.
struct ContextMapRow: View {
  let map: ContextMap
  let useNote: (String) -> Void
  /// Offscreen renders run no onAppear: they draw the bar at once.
  static var drawImmediately = false
  @State private var drawn = ContextMapRow.drawImmediately

  var body: some View {
    let total = max(1, map.ctx, map.parts.reduce(0) { $0 + $1.tokens })
    let advice = map.advice
    VStack(alignment: .leading, spacing: 7) {
      GeometryReader { g in
        HStack(spacing: 1) {
          ForEach(Array(map.parts.enumerated()), id: \.offset) { i, p in
            Rectangle().fill(color(p, rank: i, advice: advice?.part.kind))
              .frame(width: max(0, (g.size.width - CGFloat(map.parts.count)) * CGFloat(p.tokens) / CGFloat(total)))
          }
          Spacer(minLength: 0)
        }
        .frame(width: drawn ? g.size.width : 0, alignment: .leading)
        .clipped()
      }
      .frame(height: 10)
      HStack(spacing: 12) {
        ForEach(Array(map.parts.prefix(4).enumerated()), id: \.offset) { i, p in
          HStack(spacing: 5) {
            Rectangle().fill(color(p, rank: i, advice: advice?.part.kind)).frame(width: 7, height: 7)
            Text("\(ContextMap.name(p.kind)) \(Gauge.k(p.tokens))").font(Theme.body(10)).foregroundStyle(p.kind == advice?.part.kind ? Theme.accent : Theme.muted).lineLimit(1)
          }
          .fixedSize()
        }
        Spacer(minLength: 0)
        if map.scale != 1 { Text("est. ×\(String(format: "%.1f", map.scale))").font(Theme.body(9)).foregroundStyle(Theme.grayText).fixedSize() }
      }
      HStack(spacing: 8) {
        if let a = advice {
          Text("→ \(a.note)").font(Theme.body(10)).foregroundStyle(.white).lineLimit(1).truncationMode(.tail)
          Spacer(minLength: 4)
          SquareButton(title: "Use as note", fill: Theme.accent, text: Theme.ink, border: Theme.accent, height: 20) { useNote(a.note) }
        } else if let item = map.top.first {
          Text("biggest: \(item.label) \(Gauge.k(item.tokens))").font(Theme.body(10)).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
          Spacer(minLength: 0)
        }
      }
      .frame(height: 20)
    }
    .padding(.horizontal, 14)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    .background(Color.white.opacity(0.04))
    .onAppear { withAnimation(Motion.reduced ? nil : .easeOut(duration: 0.55)) { drawn = true } }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Context: " + map.parts.prefix(4).map { "\(ContextMap.name($0.kind)) \(Gauge.k($0.tokens))" }.joined(separator: ", ") + (advice.map { ". Suggested note: \($0.note)" } ?? ""))
  }

  /// Black, white, one orange: the part to act on is orange, the measured base dim, the rest white fading by size.
  private func color(_ p: ContextMap.Part, rank: Int, advice: String?) -> Color {
    if p.kind == advice { return Theme.accent }
    if p.kind == "base" { return Theme.dim }
    if p.kind == "summary" { return Theme.gray }
    return Color.white.opacity(max(0.3, 0.9 - 0.15 * Double(rank)))
  }
}

/// An edit waiting for you, orange, with the two answers.
struct PendingRow: View {
  let pending: CompanionState.Pending
  @ObservedObject var actions: Actions

  var body: some View {
    TimelineView(.periodic(from: .now, by: 0.5)) { ctx in
      HStack(spacing: 10) {
        Dot(color: Theme.ink, blinking: true, size: 10)
        Text(Toast.short(pending.title ?? "an agent", 18)).font(Theme.strong(12)).foregroundStyle(Theme.ink).lineLimit(1).fixedSize()
        Text("wants to \((pending.tool ?? "edit").lowercased())").font(Theme.body(12)).foregroundStyle(Theme.ink).lineLimit(1).fixedSize()
        Text(pending.shortFile ?? pending.file ?? "a file")
          .font(Theme.body(12)).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.head).layoutPriority(1)
        Spacer(minLength: 4)
        Text("\(pending.secondsLeft(now: ctx.date))s").font(Theme.number(18)).foregroundStyle(Theme.ink).fixedSize()
        if actions.answered.contains(pending.id) {
          Text("SENT").font(Theme.label()).kerning(0.8).foregroundStyle(Theme.ink)
        } else {
          SquareButton(title: "Approve", fill: Theme.ink, text: .white, border: Theme.ink) { actions.approve(pending.id) }
          SquareButton(title: "Deny", fill: .clear, text: Theme.ink, border: Theme.ink) { actions.deny(pending.id) }
        }
      }
      .padding(.horizontal, 14)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Theme.accent)
      .overlay(alignment: .bottom) { Theme.ink.frame(height: 1) }
    }
  }
}

struct SessionRow: View {
  let session: CompanionState.Session
  var selected = false

  var body: some View {
    let needsYou = session.state == "waiting" || (session.held ?? 0) > 0
    let hot = Gauge.isHot(fraction: session.fraction, needsYou: needsYou)
    HStack(spacing: 10) {
      Rectangle().fill(dotColor(needsYou: needsYou, hot: hot)).frame(width: 10, height: 10)
      VStack(alignment: .leading, spacing: 5) {
        HStack(spacing: 8) {
          Text(session.title).font(Theme.strong(12)).foregroundStyle(.white).lineLimit(1)
          Text(whereLine).font(Theme.body(10)).foregroundStyle(Theme.muted).lineLimit(1)
          if !session.reachable {
            Text("MONITOR").font(Theme.label(9)).kerning(0.6).foregroundStyle(Theme.grayText)
              .padding(.horizontal, 4).frame(height: 14).overlay(Rectangle().stroke(Theme.gray, lineWidth: 1)).fixedSize()
          }
          if let n = session.inbox, n > 0 {
            Text("\(n) NOTE\(n == 1 ? "" : "S") QUEUED").font(Theme.label(9)).kerning(0.6).foregroundStyle(Theme.accent).fixedSize()
          }
        }
        GeometryReader { g in
          ZStack(alignment: .leading) {
            Theme.rule
            Rectangle().fill(hot ? Theme.accent : .white).frame(width: g.size.width * session.fraction)
          }
        }
        .frame(height: 6)
      }
      Text(Gauge.k(session.ctx))
        .font(Theme.number(16))
        .foregroundStyle(hot ? Theme.accent : .white)
        .frame(width: 60, alignment: .trailing)
        .contentTransition(.numericText())
      Text(stateLine)
        .font(Theme.body(11))
        .foregroundStyle(needsYou || hot ? Theme.accent : Theme.muted)
        .frame(width: 170, alignment: .trailing)
        .lineLimit(1)
    }
    .padding(.horizontal, 14)
    .background(selected ? Color.white.opacity(0.08) : Color.clear)
    .overlay(alignment: .bottom) { Theme.rule.frame(height: 1) }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(session.title), \(whereLine). \(Gauge.k(session.ctx)) of \(Gauge.k(session.limit)) context. \(stateLine)\(session.reachable ? "" : ". Monitor only")")
    .accessibilityHint(session.reachable ? "Opens a note field to steer this session" : "")
    .accessibilityAddTraits(.isButton)
  }

  private var whereLine: String {
    var s = session.project ?? ""
    if let b = session.gitBranch, !b.isEmpty, b != "HEAD" { s += " · \(b)" }
    if session.compactions > 0 { s += " · \(session.compactions)× compacted" }
    return s
  }

  private var stateLine: String {
    if let h = session.held, h > 0 { return "waiting for your answer" }
    switch session.state {
    case "waiting": return "waiting for you"
    case "thinking": return "thinking"
    default: return session.label
    }
  }

  private func dotColor(needsYou: Bool, hot: Bool) -> Color {
    if needsYou || hot { return Theme.accent }
    switch session.state {
    case "thinking", "tool": return .white
    default: return Theme.gray
    }
  }
}

/// A note for one session, delivered at its next tool call.
struct SteerField: View {
  let session: CompanionState.Session
  @ObservedObject var actions: Actions
  @Binding var text: String
  let close: () -> Void
  @State private var sending = false
  @FocusState private var focused: Bool

  var body: some View {
    HStack(spacing: 10) {
      Text("STEER").font(Theme.label()).kerning(0.8).foregroundStyle(Theme.accent)
      TextField("", text: $text, prompt: Text(session.reachable ? "a note \(session.title) reads at its next tool call" : "queued until the session runs the hook").foregroundColor(Theme.grayText))
        .textFieldStyle(.plain)
        .font(Theme.body(12))
        .foregroundStyle(.white)
        .focused($focused)
        .onSubmit(send)
        .onExitCommand(perform: close)
      SquareButton(title: sending ? "…" : "Send", fill: .white, text: Theme.ink, border: .white) { send() }
    }
    .padding(.horizontal, 14)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color.white.opacity(0.08))
    .overlay(alignment: .bottom) { Theme.rule.frame(height: 1) }
    .onAppear { DispatchQueue.main.async { focused = true } }
  }

  private func send() {
    guard !sending, let id = session.sessionId, !text.trimmingCharacters(in: .whitespaces).isEmpty else { return }
    sending = true
    actions.steer(session: id, text: text) { ok in
      sending = false
      if ok { text = ""; close() }
    }
  }
}
