import AppKit
import LeanlampCore

final class AppDelegate: NSObject, NSApplicationDelegate {
  let store = StateStore()
  private let engine = EngineLauncher()
  private(set) lazy var actions = Actions(script: engine.script, statePath: store.path)
  private(set) lazy var window = MainWindowController(store: store, actions: actions, connect: { [weak self] in self?.connect() })
  private var statusItem: StatusItemController?
  private(set) var island: IslandController?
  private var strip: StripController?
  private var hotkey: Hotkey?

  func applicationDidFinishLaunching(_ notification: Notification) {
    Fonts.register()
    engine.startIfNeeded(store: store)
    engine.supervise(store: store)
    statusItem = StatusItemController(store: store, app: self)
    rebuildIsland()
    strip = StripController(store: store, actions: actions) { NSScreen.notchScreen() }
    hotkey = Hotkey { [weak self] in
      guard let self else { return }
      if let island = self.island { island.toggle() } else { self.openWindow(.sessions) }
    }
    NotificationCenter.default.addObserver(self, selector: #selector(screensChanged), name: NSApplication.didChangeScreenParametersNotification, object: nil)
    NotificationCenter.default.addObserver(forName: .leanlampOpenWindow, object: nil, queue: .main) { [weak self] note in
      self?.openWindow((note.object as? WindowTab) ?? .sessions)
    }
    NotificationCenter.default.addObserver(forName: .leanlampConnect, object: nil, queue: .main) { [weak self] _ in
      self?.connect()
    }
    actions.refreshHookStatus()
    store.start()
    NSLog("leanlamp: state \(store.path) · engine \(engine.script ?? "not found") · notch \(island == nil ? "no" : "yes") · fonts \(Fonts.registered.joined(separator: ", "))")
    // For screenshots and demos: LEANLAMP_START_EXPANDED=1 opens the wall at launch.
    if let tab = ProcessInfo.processInfo.environment["LEANLAMP_OPEN_WINDOW"].flatMap(WindowTab.init(rawValue:)) {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.openWindow(tab) }
    }
    // First launch without a notch (external display, clamshell, older Mac): no island to say hello, and the
    // menu-bar glyph may be hidden by a bar manager — so the window opens once, like any app's first launch.
    if island == nil, !UserDefaults.standard.bool(forKey: IslandController.welcomedKey), ProcessInfo.processInfo.environment["LEANLAMP_OPEN_WINDOW"] == nil {
      UserDefaults.standard.set(true, forKey: IslandController.welcomedKey)
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.openWindow(.sessions) }
    }
    if ProcessInfo.processInfo.environment["LEANLAMP_START_EXPANDED"] == "1" {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.island?.toggle() }
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    store.stop()
    island?.close()
    strip?.close()
    engine.stop()
  }

  @objc private func screensChanged() { rebuildIsland() }

  /// The island lives on the first screen with a notch; without one, the menu-bar glyph is the whole shell.
  func rebuildIsland() {
    if let layout = NSScreen.notchLayout() {
      if let island { island.relayout(layout) } else { island = IslandController(store: store, actions: actions, layout: layout) }
    } else {
      island?.close()
      island = nil
    }
  }

  func toggleIsland() { island?.toggle() }

  /// Steer and hold reach a session only through the companion hook. Adding it
  /// changes the user's Claude settings for every session on this Mac, so it
  /// happens only after this explicit question, never on its own.
  func connect() {
    actions.refreshHookStatus { [weak self] in
      guard let self else { return }
      let files = self.actions.hookTargets
      let alert = NSAlert()
      if self.actions.hooksInstalled == true {
        alert.messageText = "leanlamp is connected"
        alert.informativeText = "The companion hook is in \(files.joined(separator: ", ")). Sessions started since then can be steered and held.\n\nDisconnect removes it again (a backup of each file is kept)."
        alert.addButton(withTitle: "Keep")
        alert.addButton(withTitle: "Disconnect")
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertSecondButtonReturn { self.actions.uninstallHooks() }
        return
      }
      alert.messageText = "Connect leanlamp to your agents?"
      alert.informativeText = """
      This adds one hook to \(files.isEmpty ? "your Claude settings" : files.joined(separator: ", ")) (a backup goes to ~/.project-brain/backups; leanlamp init --undo takes it out again). It runs on every tool call of every Claude Code session on this Mac, about 27 ms each (nearly all of it Node starting), and:

      · delivers the notes you steer with,
      · holds edits under globs you hold, waiting for your answer (45 s, then Claude Code asks as usual),
      · tells the companion which sessions it can reach.

      It reads only the companion's local files. Nothing leaves this Mac. Sessions pick it up at their next start.
      """
      alert.addButton(withTitle: "Connect")
      alert.addButton(withTitle: "Not now")
      NSApp.activate(ignoringOtherApps: true)
      if alert.runModal() == .alertFirstButtonReturn { self.actions.installHooks() }
    }
  }

  func openWindow(_ tab: WindowTab = .sessions) {
    island?.collapse()
    window.show(tab: tab)
  }
}

extension NSScreen {
  /// The first display with a notch, if any.
  /// LEANLAMP_NO_NOTCH=1 behaves like a Mac without one (tests of the strip, the glyph and the first launch).
  static var notchIgnored: Bool { ProcessInfo.processInfo.environment["LEANLAMP_NO_NOTCH"] == "1" }

  static func notchScreen() -> NSScreen? {
    if notchIgnored { return nil }
    return NSScreen.screens.first { $0.auxiliaryTopLeftArea != nil && $0.auxiliaryTopRightArea != nil }
  }

  /// Geometry of the first notch display, in global AppKit coordinates.
  static func notchLayout() -> NotchLayout? {
    if notchIgnored { return nil }
    for screen in NSScreen.screens {
      // NSMenu's instance property reports the main screen's menu bar height; an accessory app has no main menu, so any instance will do.
      if let layout = NotchLayout.make(screenFrame: screen.frame, visibleFrame: screen.visibleFrame, auxiliaryTopLeft: screen.auxiliaryTopLeftArea, auxiliaryTopRight: screen.auxiliaryTopRightArea, menuBarHeight: NSMenu().menuBarHeight) {
        return layout
      }
    }
    return nil
  }
}

extension Notification.Name {
  /// Posted by the island's "Open ↗" and the menu; the object is an optional WindowTab.
  static let leanlampOpenWindow = Notification.Name("leanlamp.openWindow")
  /// Posted by "Connect" in the wall and the menu.
  static let leanlampConnect = Notification.Name("leanlamp.connect")
}
