import AppKit
import Combine
import SwiftUI
import LeanlampCore

final class IslandModel: ObservableObject {
  @Published var expanded = false
  @Published var layout: NotchLayout
  /// The line under the island when folded (held edit, steer delivered, compaction…).
  @Published var toast: Toast?
  /// Session whose steer field is open in the wall.
  @Published var steering: String?
  /// The keyboard cursor over the live sessions (row index), and whether the wall has the keyboard.
  @Published var cursor: Int?
  /// The note being written in the steer field (a suggestion from the context map can fill it).
  @Published var steerDraft = ""
  @Published var keyboard = false
  /// "Flutlicht" on launch: the gauge lights up segment by segment, then drops to the real value.
  enum Boot { case dark, lit, done }
  @Published var boot: Boot = Motion.reduced ? .done : .dark
  init(layout: NotchLayout) { self.layout = layout }
}

/// Owns the panel and its shapes: the ears (compact), ears + toast, and the wall (expanded).
final class IslandController {
  let store: StateStore
  let actions: Actions
  let model: IslandModel
  let panel: IslandPanel
  private let hosting: FirstMouseHostingView<IslandView>
  private var clickOutside: Any?
  private var ticker: Timer?
  private var hover: Timer?
  private var dwellSince: Date?
  private var leftSince: Date?
  /// Opened by dwelling (not by a click): it folds again when the pointer leaves for a moment.
  private var openedByDwell = false
  /// The first-launch hello: set once, the first time the engine is live; never again after (LEANLAMP_WELCOME=1 forces it).
  private var welcomeUntil: Date?
  static let welcomedKey = "leanlamp.welcomed"
  /// After a fold with the pointer still on the notch, dwelling opens again only once the pointer has left.
  private var dwellArmed = true
  static let dwell: TimeInterval = 0.4
  static let leaveGrace: TimeInterval = 0.8
  private var cancellables = Set<AnyCancellable>()

  init(store: StateStore, actions: Actions, layout: NotchLayout) {
    self.store = store
    self.actions = actions
    model = IslandModel(layout: layout)
    panel = IslandPanel(frame: layout.islandFrame)
    hosting = FirstMouseHostingView(rootView: IslandView(store: store, model: model, actions: actions))
    hosting.sizingOptions = [] // the window is sized here, never by the view's intrinsic size
    hosting.frame = NSRect(origin: .zero, size: layout.islandFrame.size)
    hosting.autoresizingMask = [.width, .height]
    panel.contentView = hosting
    panel.onEscape = { [weak self] in self?.collapse() }
    panel.onMouseDown = { [weak self] in self?.pinOpen() }
    // Like a popover: when another app takes the keyboard (⌘-Tab, a click, Spotlight), the wall folds.
    panel.onResignKey = { [weak self] in DispatchQueue.main.async { self?.model.keyboard = false; self?.collapseFromOutside() } }
    panel.onBecomeKey = { [weak self] in self?.model.keyboard = true }
    panel.onKey = { [weak self] event in self?.handle(event) ?? false }
    // Focus is taken only when the wall opens or a steer field appears — never
    // on a timer, so switching apps by keyboard can never be undone by us.
    // A wall opened by dwelling takes no focus: the hand may still be on the keyboard.
    model.$expanded.dropFirst().sink { [weak self] expanded in DispatchQueue.main.async { guard let self else { return }; self.refit(animate: true, focus: expanded && !self.openedByDwell) } }.store(in: &cancellables)
    model.$steering.dropFirst().sink { [weak self] s in DispatchQueue.main.async { self?.model.steerDraft = ""; self?.refit(animate: true, focus: s != nil) } }.store(in: &cancellables)
    store.$state.dropFirst().sink { [weak self] _ in DispatchQueue.main.async { self?.tick() } }.store(in: &cancellables)
    store.$stale.dropFirst().sink { [weak self] _ in DispatchQueue.main.async { self?.refit(animate: true) } }.store(in: &cancellables)
    let t = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in self?.tick() }
    RunLoop.main.add(t, forMode: .common)
    ticker = t
    // Ten pointer checks a second: one point-in-rect each, no event monitor, no permission.
    let h = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in self?.checkHover() }
    RunLoop.main.add(h, forMode: .common)
    hover = h
    model.$expanded.sink { [weak self] expanded in if !expanded { self?.openedByDwell = false } }.store(in: &cancellables)
    panel.orderFrontRegardless()
    if model.boot == .dark {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.model.boot = .lit }
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.1) { [weak self] in self?.model.boot = .done }
    }
  }

  /// Dwell on the notch itself (never the menu bar beside it) opens the wall;
  /// a wall opened that way folds when the pointer has left it for a moment.
  private func checkHover() {
    let p = NSEvent.mouseLocation
    let now = Date()
    if !model.expanded {
      // NSMouseInRect counts the top edge: a pointer pushed into the notch sits exactly on maxY.
      let inZone = NSMouseInRect(p, model.layout.hotZone, false)
      if !inZone { dwellArmed = true }
      if inZone && dwellArmed {
        if let since = dwellSince {
          if now.timeIntervalSince(since) >= Self.dwell {
            dwellSince = nil
            openedByDwell = true
            model.expanded = true
          }
        } else { dwellSince = now }
      } else { dwellSince = nil }
      return
    }
    guard openedByDwell else { return }
    if NSMouseInRect(p, panel.frame.insetBy(dx: -8, dy: -8), false) { leftSince = nil; return }
    if let since = leftSince {
      if now.timeIntervalSince(since) >= Self.leaveGrace { leftSince = nil; collapse() }
    } else { leftSince = now }
  }

  /// A click inside the wall makes it stay: it was opened on purpose now.
  func pinOpen() { openedByDwell = false }

  func relayout(_ layout: NotchLayout) {
    model.layout = layout
    refit(animate: false)
  }

  /// LEANLAMP_PIN=1: the wall stays open on outside clicks (demos, screenshots). Esc still folds it.
  private let pinned = ProcessInfo.processInfo.environment["LEANLAMP_PIN"] == "1"

  func toggle() { model.expanded.toggle() }
  func collapse() {
    guard model.expanded else { return }
    dwellArmed = false
    model.steering = nil
    model.cursor = nil
    model.expanded = false
  }
  /// The wall by keyboard (WallKey). True when the key was ours.
  private func handle(_ event: NSEvent) -> Bool {
    guard model.expanded else { return false }
    let mods = !event.modifierFlags.intersection([.command, .control, .option]).isEmpty
    guard let key = WallKey.from(keyCode: event.keyCode, characters: event.charactersIgnoringModifiers, modifiers: mods) else { return false }
    let rows = Array((store.engineStatus == .live ? store.state?.live ?? [] : []).prefix(PanelContent.maxRows))
    let open = (store.fresh?.openPending ?? []).filter { !actions.answered.contains($0.id) }
    switch key {
    case .move, .jump:
      model.cursor = WallKey.cursor(model.cursor, key, count: rows.count)
    case .steer:
      guard let c = WallKey.cursor(model.cursor ?? 0, key, count: rows.count), let id = rows[c].sessionId else { return true }
      model.cursor = c
      model.steering = model.steering == id ? nil : id
    case .approve:
      if let p = open.first { actions.approve(p.id) } else { NSSound.beep() }
    case .deny:
      if let p = open.first { actions.deny(p.id) } else { NSSound.beep() }
    case .hold:
      if store.state?.holdsAll == true { actions.releaseAll() } else { actions.holdAll() }
    case .open:
      NotificationCenter.default.post(name: .leanlampOpenWindow, object: nil)
    }
    return true
  }

  private func collapseFromOutside() { if !pinned { collapse() } }

  func close() {
    ticker?.invalidate()
    hover?.invalidate()
    removeClickOutside()
    panel.orderOut(nil)
  }

  /// Twice a second: pick the toast (it counts down and expires on time) and fit the window.
  /// Off by default; menu ▸ Sound for decisions. One soft tick when an edit starts to wait, never for news.
  static var soundForDecisions: Bool {
    get { UserDefaults.standard.bool(forKey: "soundForDecisions") }
    set { UserDefaults.standard.set(newValue, forKey: "soundForDecisions") }
  }
  private var lastSoundKey: String?

  private func tick() {
    if let id = model.steering, !(store.fresh?.live.contains { $0.sessionId == id } ?? false) { model.steering = nil } // its session ended
    if welcomeUntil == nil, store.engineStatus == .live {
      let force = ProcessInfo.processInfo.environment["LEANLAMP_WELCOME"] == "1"
      if force || !UserDefaults.standard.bool(forKey: Self.welcomedKey) {
        welcomeUntil = Date().addingTimeInterval(Toast.welcomeSeconds)
        UserDefaults.standard.set(true, forKey: Self.welcomedKey) // shown once, whether or not it is clicked
      } else {
        welcomeUntil = .distantPast
      }
    }
    let toast = Toast.pick(store.fresh, dismissed: actions.dismissedKeys, welcomeUntil: welcomeUntil)
    if let t = toast, t.attention, t.key != lastSoundKey {
      lastSoundKey = t.key
      if Self.soundForDecisions { NSSound(named: NSSound.Name("Tink"))?.play() }
    }
    if toast != model.toast {
      let shapeChanged = (toast == nil) != (model.toast == nil)
      model.toast = toast
      if shapeChanged { refit(animate: true) }
    }
    if model.expanded { refit(animate: true) }
  }

  /// The window: the shape plus room for the urgent spring's overshoot. Transparent outside the shape.
  private func frame() -> NSRect {
    let layout = model.layout
    let h = IslandShape.contentHeight(store: store, model: model)
    return h > 0 ? layout.panelFrame(contentHeight: h + Motion.slack) : layout.islandFrame
  }

  /// A shrink waiting for the shape to fold first.
  private var shrinkTo: NSRect?
  private var shrinkWork: DispatchWorkItem?

  /// The shape animates in SwiftUI; the window only has to contain it. Growing
  /// happens at once (the new area is transparent until the shape gets there);
  /// shrinking waits until the spring has settled, so the fold is never cut off.
  private func refit(animate: Bool, focus: Bool = false) {
    let target = frame()
    if panel.frame == target {
      shrinkWork?.cancel(); shrinkWork = nil; shrinkTo = nil
    } else if !animate || Motion.reduced || (target.width >= panel.frame.width && target.height >= panel.frame.height) {
      shrinkWork?.cancel(); shrinkWork = nil; shrinkTo = nil
      panel.setFrame(target, display: true)
    } else if shrinkTo != target {
      shrinkWork?.cancel()
      let cover = panel.frame.union(target)
      if cover != panel.frame { panel.setFrame(cover, display: true) }
      shrinkTo = target
      let work = DispatchWorkItem { [weak self] in
        guard let self else { return }
        self.shrinkWork = nil; self.shrinkTo = nil
        let now = self.frame()
        if self.panel.frame != now { self.panel.setFrame(now, display: true) }
      }
      shrinkWork = work
      DispatchQueue.main.asyncAfter(deadline: .now() + Motion.settle, execute: work)
    }
    if !panel.isVisible { panel.orderFrontRegardless() }
    if model.expanded {
      if focus && !pinned && !panel.isKeyWindow { panel.makeKey() } // pinned (demos, tests): never take the keyboard
      installClickOutside()
    } else {
      removeClickOutside()
      // Folded: give the keyboard back. A non-activating panel that leaves the
      // screen hands key status back to the app that is still active.
      if panel.isKeyWindow { panel.orderOut(nil); panel.orderFrontRegardless() }
    }
  }

  private func installClickOutside() {
    guard clickOutside == nil else { return }
    clickOutside = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
      DispatchQueue.main.async { self?.collapseFromOutside() }
    }
  }

  private func removeClickOutside() {
    if let m = clickOutside { NSEvent.removeMonitor(m) }
    clickOutside = nil
  }
}
