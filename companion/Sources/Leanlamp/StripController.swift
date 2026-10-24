import AppKit
import Combine
import SwiftUI
import LeanlampCore

/// The strip: when an edit waits for you and you are not looking at the
/// notch — an external display, clamshell, a Mac without a notch — the same
/// orange line appears top right on the screen your pointer is on. Only for
/// decisions; news stays on the island and the glyph.
final class StripController {
  private let store: StateStore
  private let actions: Actions
  private let notchScreen: () -> NSScreen?
  private let panel: IslandPanel
  private let model = StripModel()
  private var timer: Timer?

  static let width: CGFloat = 640
  static let margin: CGFloat = 10

  init(store: StateStore, actions: Actions, notchScreen: @escaping () -> NSScreen?) {
    self.store = store
    self.actions = actions
    self.notchScreen = notchScreen
    panel = IslandPanel(frame: NSRect(x: 0, y: 0, width: Self.width, height: ToastRow.height))
    let host = FirstMouseHostingView(rootView: StripView(model: model, actions: actions))
    host.sizingOptions = []
    host.frame = NSRect(x: 0, y: 0, width: Self.width, height: ToastRow.height)
    host.autoresizingMask = [.width, .height]
    panel.contentView = host
    let t = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in self?.tick() }
    RunLoop.main.add(t, forMode: .common)
    timer = t
  }

  func close() { timer?.invalidate(); panel.orderOut(nil) }

  /// The screen the pointer is on.
  static func pointerScreen() -> NSScreen? {
    let p = NSEvent.mouseLocation
    return NSScreen.screens.first { NSMouseInRect(p, $0.frame, false) } ?? NSScreen.main
  }

  private func tick() {
    guard let toast = Toast.pick(store.fresh, dismissed: actions.dismissedKeys), toast.attention, let screen = Self.pointerScreen() else { hide(); return }
    if let id = toast.pendingId, actions.answered.contains(id) { hide(); return } // answered here: gone at once
    // the island already shows it there (LEANLAMP_STRIP_ALWAYS=1 shows the strip anyway, for screenshots)
    if let notch = notchScreen(), notch == screen, ProcessInfo.processInfo.environment["LEANLAMP_STRIP_ALWAYS"] != "1" { hide(); return }
    model.toast = toast
    let vf = screen.visibleFrame
    let frame = NSRect(x: vf.maxX - Self.width - Self.margin, y: vf.maxY - ToastRow.height - Self.margin, width: Self.width, height: ToastRow.height)
    if panel.frame != frame { panel.setFrame(frame, display: true) }
    if !panel.isVisible { panel.orderFrontRegardless() }
  }

  private func hide() {
    if panel.isVisible { panel.orderOut(nil) }
    model.toast = nil
  }
}

final class StripModel: ObservableObject {
  @Published var toast: Toast?
}

struct StripView: View {
  @ObservedObject var model: StripModel
  @ObservedObject var actions: Actions

  var body: some View {
    if let t = model.toast {
      ToastRow(toast: t, actions: actions)
        .overlay(Rectangle().stroke(Theme.ink, lineWidth: 2))
    } else {
      Color.clear
    }
  }
}
