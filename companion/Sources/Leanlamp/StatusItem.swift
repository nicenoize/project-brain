import AppKit
import ServiceManagement
import Combine
import SwiftUI
import LeanlampCore

/// The menu-bar glyph: the same gauge as the island, for Macs and displays
/// without a notch, and the home of the app menu (expand, engine, quit).
final class StatusItemController: NSObject {
  let item: NSStatusItem
  private let hosting: NSHostingView<GlyphView>
  private weak var app: AppDelegate?
  private var cancellables = Set<AnyCancellable>()

  static let width: CGFloat = 84

  init(store: StateStore, app: AppDelegate) {
    item = NSStatusBar.system.statusItem(withLength: StatusItemController.width)
    hosting = NSHostingView(rootView: GlyphView(store: store))
    super.init()
    self.app = app
    if let button = item.button {
      hosting.frame = button.bounds
      hosting.autoresizingMask = [.width, .height]
      button.addSubview(hosting)
      button.toolTip = "leanlamp — the agents on this machine"
    }
    item.menu = makeMenu()
    store.$stale.sink { [weak self] stale in self?.engineItem?.title = stale ? "Engine: not running" : "Engine: running" }.store(in: &cancellables)
  }

  private var engineItem: NSMenuItem?

  private func makeMenu() -> NSMenu {
    let menu = NSMenu()
    let open = NSMenuItem(title: "Open window", action: #selector(openWindow), keyEquivalent: "o")
    open.target = self
    menu.addItem(open)
    let receipt = NSMenuItem(title: "Receipt", action: #selector(openReceipt), keyEquivalent: "r")
    receipt.target = self
    menu.addItem(receipt)
    let expand = NSMenuItem(title: "Expand island  ⌥⌘L", action: #selector(toggleIsland), keyEquivalent: "")
    expand.target = self
    menu.addItem(expand)
    let engine = NSMenuItem(title: "Engine: …", action: nil, keyEquivalent: "")
    engine.isEnabled = false
    menu.addItem(engine)
    engineItem = engine
    let connect = NSMenuItem(title: "Connect to agents…", action: #selector(connectAgents), keyEquivalent: "")
    connect.target = self
    menu.addItem(connect)
    let state = NSMenuItem(title: "Show state file", action: #selector(revealState), keyEquivalent: "")
    state.target = self
    menu.addItem(state)
    let sound = NSMenuItem(title: "Sound for decisions", action: #selector(toggleSound(_:)), keyEquivalent: "")
    sound.target = self
    sound.state = IslandController.soundForDecisions ? .on : .off
    menu.addItem(sound)
    if LoginItem.available {
      let login = NSMenuItem(title: "Open at login", action: #selector(toggleLogin(_:)), keyEquivalent: "")
      login.target = self
      login.state = LoginItem.enabled ? .on : .off
      menu.addItem(login)
    }
    menu.addItem(.separator())
    let quit = NSMenuItem(title: "Quit leanlamp", action: #selector(quit), keyEquivalent: "q")
    quit.target = self
    menu.addItem(quit)
    return menu
  }

  @objc private func toggleIsland() { app?.toggleIsland() }
  @objc private func openWindow() { app?.openWindow(.sessions) }
  @objc private func connectAgents() { app?.connect() }
  @objc private func openReceipt() { app?.openWindow(.receipt) }
  @objc private func revealState() {
    if let path = app?.store.path { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
  }
  @objc private func quit() { NSApp.terminate(nil) }
  @objc private func toggleSound(_ sender: NSMenuItem) {
    IslandController.soundForDecisions.toggle()
    sender.state = IslandController.soundForDecisions ? .on : .off
    if IslandController.soundForDecisions { NSSound(named: NSSound.Name("Tink"))?.play() }
  }
  @objc private func toggleLogin(_ sender: NSMenuItem) {
    LoginItem.set(!LoginItem.enabled)
    sender.state = LoginItem.enabled ? .on : .off
  }
}

/// Start at login, through the system's own switch (System Settings ▸ General ▸
/// Login Items lists it). Only an app bundle can register itself.
enum LoginItem {
  static var available: Bool { Bundle.main.bundleURL.pathExtension == "app" }
  static var enabled: Bool { SMAppService.mainApp.status == .enabled }
  static func set(_ on: Bool) {
    do {
      if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    } catch {
      NSLog("leanlamp: login item \(on ? "on" : "off") failed: \(error)")
    }
  }
}

struct GlyphView: View {
  @ObservedObject var store: StateStore

  var body: some View {
    let live = store.engineStatus == .live
    let state = live ? store.state : nil
    let busiest = state?.busiest
    let fraction = busiest?.fraction ?? 0
    let pending = store.fresh?.openPending.count ?? 0
    let needsYou = pending > 0 || !(state?.waiting.isEmpty ?? true)
    let hot = Gauge.isHot(fraction: fraction, needsYou: needsYou)
    HStack(spacing: 6) {
      Segments(filled: live ? Gauge.filled(fraction: fraction) : 0, on: hot ? Theme.accent : Color.primary, off: Color.primary.opacity(0.25), height: 11)
      Text(busiest == nil ? "—" : Gauge.k(busiest!.ctx))
        .font(Theme.number(13))
        .foregroundStyle(hot ? Theme.accent : Color.primary)
      if needsYou, case let n = pending + (state?.waiting.count ?? 0), n > 0 {
        Text("\(n)").font(Theme.label(10)).foregroundStyle(Theme.ink)
          .padding(.horizontal, 4).frame(height: 14).background(Theme.accent)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}
