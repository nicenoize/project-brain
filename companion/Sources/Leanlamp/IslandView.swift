import SwiftUI
import LeanlampCore

/// The island: ears beside the notch; folded, an optional toast line under
/// them; expanded, the wall. The window is transparent, so only the black
/// shapes show.
struct IslandView: View {
  @ObservedObject var store: StateStore
  @ObservedObject var model: IslandModel
  @ObservedObject var actions: Actions

  var body: some View {
    let layout = model.layout
    let size = IslandShape.size(store: store, model: model)
    let urgent = !model.expanded && model.toast?.attention == true
    // One black shape: the ears grow into the toast or the wall and fold back,
    // on a spring. The window around it is transparent and already big enough.
    VStack(spacing: 0) {
      EarsRow(store: store, model: model, layout: layout, expanded: model.expanded)
        .frame(width: size.width, height: layout.islandHeight)
        .contentShape(Rectangle())
        .onTapGesture { model.expanded.toggle() }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(IslandSpeech.summary(store: store, toast: model.toast))
        .accessibilityHint(model.expanded ? "Folds the session wall" : "Opens the session wall")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { model.expanded.toggle() }
      if model.expanded {
        PanelContent(store: store, model: model, actions: actions)
          .frame(width: layout.panelWidth)
          .transition(Motion.reduced ? .identity : .asymmetric(
            insertion: .opacity.combined(with: .offset(y: -10)).animation(.easeOut(duration: 0.22).delay(0.06)),
            removal: .opacity.animation(.easeIn(duration: 0.08))))
      } else if let toast = model.toast {
        ToastRow(toast: toast, actions: actions)
          .frame(width: layout.panelWidth, height: ToastRow.height)
          .transition(Motion.reduced ? .identity : .asymmetric(
            insertion: .opacity.animation(.easeOut(duration: 0.18).delay(0.05)),
            removal: .opacity.animation(.easeIn(duration: 0.08))))
      }
    }
    .frame(width: size.width, height: size.height, alignment: .top)
    .background(alignment: .top) { ShapeFill(ears: layout.islandHeight, below: urgent ? Theme.accent : .black) }
    .overlay { PanelEdges().opacity(model.expanded ? 1 : 0) } // a toast draws its own
    .clipped()
    .animation(Motion.reduced ? nil : urgent ? Motion.urgent : Motion.shape, value: size)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
  }
}

/// The shape's paint: black behind the ears, the toast's colour below, so the
/// spring's overshoot shows more of the toast, never a black band under it.
struct ShapeFill: View {
  let ears: CGFloat
  let below: Color
  var body: some View {
    VStack(spacing: 0) {
      Color.black.frame(height: ears)
      below
    }
  }
}

/// The size of the black shape, from fixed row heights, so the window can be
/// fitted before the view lays out. The controller adds the transparent slack.
enum IslandShape {
  static func contentHeight(store: StateStore, model: IslandModel) -> CGFloat {
    if model.expanded {
      let live = store.engineStatus == .live ? store.state : nil
      return PanelContent.height(for: live, pending: store.fresh?.openPending.count ?? 0, steering: model.steering != nil, engine: store.engineStatus, steeringId: model.steering)
    }
    return model.toast != nil ? ToastRow.height : 0
  }

  static func size(store: StateStore, model: IslandModel) -> CGSize {
    let layout = model.layout
    let h = contentHeight(store: store, model: model)
    return CGSize(width: h > 0 ? layout.panelWidth : layout.islandWidth, height: layout.islandHeight + h)
  }
}

/// Left ear: the gauge of the fullest live session. Right ear: who is live, who needs you.
struct EarsRow: View {
  @ObservedObject var store: StateStore
  @ObservedObject var model: IslandModel
  let layout: NotchLayout
  let expanded: Bool

  var body: some View {
    let ear = expanded ? layout.panelEarWidth : layout.earWidth
    HStack(spacing: 0) {
      LeftEar(store: store, boot: model.boot).frame(width: ear, alignment: .leading)
      Color.clear.frame(width: layout.notch.width)
      RightEar(store: store, toast: model.toast).frame(width: ear, alignment: .trailing)
    }
  }
}

struct LeftEar: View {
  @ObservedObject var store: StateStore
  var boot: IslandModel.Boot = .done

  var body: some View {
    // A stale file still holds the last run's numbers: never show them as live.
    let live = store.engineStatus == .live
    let state = live ? store.state : nil
    let busiest = state?.busiest
    let fraction = busiest?.fraction ?? 0
    let needsYou = !(state?.openPending.isEmpty ?? true)
    let hot = Gauge.isHot(fraction: fraction, needsYou: needsYou)
    HStack(spacing: 8) {
      Segments(filled: boot == .dark ? 0 : boot == .lit ? Gauge.segments : live ? Gauge.filled(fraction: fraction) : 0,
               on: boot == .lit ? Theme.accent : hot ? Theme.accent : .white, off: Theme.dim)
      Text(busiest == nil ? "—" : Gauge.k(busiest!.ctx))
        .font(Theme.number(15))
        .foregroundStyle(hot ? Theme.accent : .white)
        .contentTransition(.numericText())
    }
    .padding(.leading, 14)
  }
}

struct RightEar: View {
  @ObservedObject var store: StateStore
  let toast: Toast?

  var body: some View {
    let status = store.engineStatus
    let state = status == .live ? store.state : nil
    let live = state?.live.count ?? 0
    let waiting = state?.waiting.count ?? 0
    let pending = store.fresh?.openPending.count ?? 0
    let holds = state?.activeHolds ?? []
    let soonest = holds.compactMap { $0.minutesLeft }.min()
    let kind: String
    let number: String
    let color: Color
    let dot: Color
    let blink: Bool
    if status == .off { kind = "no engine"; number = ""; color = Theme.accent; dot = Theme.accent; blink = false }
    else if pending > 0, let t = toast, t.attention { kind = "held"; number = t.number; color = Theme.accent; dot = Theme.accent; blink = true }
    else if let t = toast, t.isMemory { kind = "memory"; number = t.number; color = Theme.accent; dot = Theme.accent; blink = false }
    else if status == .starting { kind = "starting"; number = ""; color = Theme.muted; dot = Theme.muted; blink = true }
    else if let t = toast, !t.attention { kind = shortKind(t.kind); number = ""; color = .white; dot = Theme.accent; blink = false }
    else if waiting > 0 { kind = "waiting"; number = "\(waiting)"; color = Theme.accent; dot = Theme.accent; blink = false }
    else if !holds.isEmpty { kind = holds.count == 1 ? "hold" : "\(holds.count) holds"; number = soonest.map { "\($0)m" } ?? "∞"; color = .white; dot = Theme.accent; blink = false }
    else { kind = "\(live) live"; number = ""; color = .white; dot = live > 0 ? Theme.accent : Theme.gray; blink = live > 0 }
    return HStack(spacing: 8) {
      Dot(color: dot, blinking: blink)
      Text(kind.uppercased()).font(Theme.label()).kerning(0.8).foregroundStyle(color).lineLimit(1)
      if !number.isEmpty {
        Text(number).font(Theme.number(15)).foregroundStyle(color).contentTransition(.numericText())
      }
    }
    .padding(.trailing, 14)
  }

  private func shortKind(_ k: String) -> String {
    switch k {
    case "steer delivered": return "steer"
    case "no answer": return "asked"
    default: return k
    }
  }
}

/// Under the folded island: one line, orange when it needs you.
struct ToastRow: View {
  let toast: Toast
  @ObservedObject var actions: Actions
  static let height: CGFloat = 44

  var body: some View {
    let bg = toast.attention ? Theme.accent : Color.black
    let fg = toast.attention ? Theme.ink : Color.white
    HStack(spacing: 10) {
      Dot(color: toast.attention ? Theme.ink : Theme.accent, blinking: toast.attention, size: 10)
      Text(toast.kind.uppercased()).font(Theme.label()).kerning(0.8).foregroundStyle(fg).lineLimit(1).fixedSize()
      if !toast.subject.isEmpty {
        Text(Toast.short(toast.subject, toast.pendingId == nil ? 26 : 18)).font(Theme.strong(12)).foregroundStyle(fg).lineLimit(1).fixedSize()
      }
      if !toast.verb.isEmpty {
        Text(toast.verb).font(Theme.body(12)).foregroundStyle(fg).lineLimit(1).fixedSize()
      }
      Text(toast.text).font(Theme.body(12)).foregroundStyle(fg).lineLimit(1).truncationMode(toast.text.hasPrefix("“") || toast.welcome ? .tail : .head).layoutPriority(1)
      Spacer(minLength: 4)
      if !toast.number.isEmpty {
        Text(toast.number).font(Theme.number(18)).foregroundStyle(fg).contentTransition(.numericText()).fixedSize()
      }
      if toast.isMemory {
        if toast.reclaimable {
          SquareButton(title: "Reclaim", fill: Theme.ink, text: .white, border: Theme.ink) { actions.reclaim(); actions.snooze(toast.key, for: 120) }
        }
        SquareButton(title: "Later", fill: .clear, text: Theme.ink, border: Theme.ink) { actions.snooze(toast.key) }
      }
      if toast.isQuiet {
        let ink = toast.attention ? Theme.ink : Color.white
        SquareButton(title: "Park all", fill: toast.attention ? Theme.ink : Theme.accent, text: toast.attention ? .white : Theme.ink, border: toast.attention ? Theme.ink : Theme.accent) {
          actions.parkAll(toast.parkIds); actions.snooze(toast.key, for: 120)
        }
        SquareButton(title: "Show", fill: .clear, text: ink, border: ink) {
          NotificationCenter.default.post(name: .leanlampOpenWindow, object: WindowTab.parking)
        }
        SquareButton(title: "Later", fill: .clear, text: ink, border: ink) { actions.snooze(toast.key, for: Toast.quietSnooze) }
      }
      if toast.welcome {
        if actions.hooksInstalled != true {
          SquareButton(title: "Connect…", fill: .white, text: Theme.ink, border: .white) {
            actions.snooze(Toast.welcomeKey)
            NotificationCenter.default.post(name: .leanlampConnect, object: nil)
          }
        }
        SquareButton(title: "Got it", fill: .clear, text: .white, border: .white) { actions.snooze(Toast.welcomeKey) }
      }
      if let id = toast.pendingId {
        if actions.answered.contains(id) {
          Text("SENT").font(Theme.label()).kerning(0.8).foregroundStyle(fg).fixedSize()
        } else {
          SquareButton(title: "Approve", fill: Theme.ink, text: .white, border: Theme.ink) { actions.approve(id) }
          SquareButton(title: "Deny", fill: .clear, text: Theme.ink, border: Theme.ink) { actions.deny(id) }
        }
      }
    }
    .padding(.horizontal, 14)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(bg)
    .overlay { if !toast.attention { PanelEdges() } }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("\(toast.kind). \(toast.subject) \(toast.verb) \(toast.text)\(toast.number.isEmpty ? "" : ", \(toast.number) left")")
  }
}

/// Zero radius, 2-pt border, bold mono label — the only button shape in the app.
struct SquareButton: View {
  let title: String
  var fill: Color
  var text: Color
  var border: Color
  var height: CGFloat = 30
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(title)
        .font(Theme.strong(12))
        .foregroundStyle(text)
        .padding(.horizontal, 12)
        .frame(height: height)
        .background(fill)
        .overlay(Rectangle().stroke(border, lineWidth: 2))
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .fixedSize()
  }
}

struct Segments: View {
  let filled: Int
  let on: Color
  let off: Color
  var height: CGFloat = 12
  /// The previous value: segments switch one after another, in the direction of the change.
  @State private var shown: Int
  @State private var rising = true

  init(filled: Int, on: Color, off: Color, height: CGFloat = 12) {
    self.filled = filled; self.on = on; self.off = off; self.height = height
    _shown = State(initialValue: filled) // offscreen renders (the demo) never run onAppear
  }

  var body: some View {
    HStack(alignment: .bottom, spacing: 2) {
      ForEach(0..<Gauge.segments, id: \.self) { i in
        Rectangle().fill(i < shown ? on : off).frame(width: 3, height: height)
          .animation(Motion.reduced ? nil : .easeOut(duration: 0.12).delay(0.035 * Double(rising ? i : Gauge.segments - 1 - i)), value: shown)
      }
    }
    .onChange(of: filled) { old, new in rising = new >= old; shown = new }
    .accessibilityHidden(true)
  }
}

/// A hard square that blinks in steps, like the mockups: no fade.
struct Dot: View {
  let color: Color
  let blinking: Bool
  var size: CGFloat = 8

  var body: some View {
    Group {
      if blinking && !Motion.reduced {
        TimelineView(.periodic(from: .now, by: 0.5)) { context in
          let on = Int(context.date.timeIntervalSince1970 * 2) % 2 == 0
          Rectangle().fill(color).frame(width: size, height: size).opacity(on ? 1 : 0)
        }
      } else {
        Rectangle().fill(color).frame(width: size, height: size)
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}

/// Two-point white edges on the left, right and bottom. The top is the screen edge.
struct PanelEdges: View {
  var body: some View {
    GeometryReader { g in
      Path { p in
        p.move(to: CGPoint(x: 0, y: 0))
        p.addLine(to: CGPoint(x: 0, y: g.size.height))
        p.addLine(to: CGPoint(x: g.size.width, y: g.size.height))
        p.addLine(to: CGPoint(x: g.size.width, y: 0))
      }
      .stroke(Color.white, lineWidth: 4)
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

/// What VoiceOver says for the island (the wording lives in LeanlampCore.Speech).
enum IslandSpeech {
  static func summary(store: StateStore, toast: Toast?) -> String {
    let engine: Speech.Engine = store.engineStatus == .off ? .off : store.engineStatus == .starting ? .starting : .live
    return Speech.island(state: store.state, engine: engine, toast: toast)
  }
}
