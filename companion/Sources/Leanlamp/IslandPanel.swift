import AppKit
import SwiftUI

/// The window around the notch. Borderless and non-activating, so a click on
/// it never takes focus from the terminal; above the menu bar on every Space
/// and over fullscreen apps; transparent, so only the black rectangle shows.
final class IslandPanel: NSPanel {
  var onEscape: (() -> Void)?
  var onMouseDown: (() -> Void)?
  var onResignKey: (() -> Void)?
  var onBecomeKey: (() -> Void)?
  /// Keys the text field did not take; true when handled.
  var onKey: ((NSEvent) -> Bool)?

  override func becomeKey() {
    super.becomeKey()
    onBecomeKey?()
  }

  override func resignKey() {
    super.resignKey()
    onResignKey?()
  }

  override func sendEvent(_ event: NSEvent) {
    if event.type == .leftMouseDown || event.type == .rightMouseDown { onMouseDown?() }
    super.sendEvent(event)
  }

  init(frame: NSRect) {
    super.init(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    isFloatingPanel = true
    level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.statusWindow)) + 1)
    collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
    isOpaque = false
    backgroundColor = .clear
    hasShadow = false
    hidesOnDeactivate = false
    isMovable = false
    isMovableByWindowBackground = false
    isReleasedWhenClosed = false
    animationBehavior = .none
    becomesKeyOnlyIfNeeded = true
    acceptsMouseMovedEvents = true
  }

  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }

  override func keyDown(with event: NSEvent) {
    if event.keyCode == 53 { onEscape?() } else if onKey?(event) == true { return } else { super.keyDown(with: event) }
  }

  override func cancelOperation(_ sender: Any?) { onEscape?() }
}

/// The first click on a non-key window must act, not merely focus.
final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}
