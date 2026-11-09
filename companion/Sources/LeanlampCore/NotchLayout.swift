import Foundation
import CoreGraphics

/// Where the island sits, in AppKit screen coordinates (origin bottom-left).
/// Pure maths over rectangles the shell reads from NSScreen, so it is
/// testable without a display: on a 14-inch MacBook Pro at the default
/// scaling the notch is 185 × 32 pt and the menu bar 37 pt (measured).
public struct NotchLayout: Equatable {
  public var screen: CGRect
  public var notch: CGRect
  public var menuBarHeight: CGFloat
  public var earWidth: CGFloat
  public var panelWidth: CGFloat

  public static let defaultEar: CGFloat = 140
  public static let defaultPanel: CGFloat = 640

  public init(screen: CGRect, notch: CGRect, menuBarHeight: CGFloat, earWidth: CGFloat = NotchLayout.defaultEar, panelWidth: CGFloat = NotchLayout.defaultPanel) {
    self.screen = screen
    self.notch = notch
    self.menuBarHeight = menuBarHeight
    self.earWidth = earWidth
    self.panelWidth = max(panelWidth, notch.width + 2 * earWidth)
  }

  /// From what NSScreen reports. Nil when the screen has no notch. `menuBarHeight`
  /// is the system's own figure (NSMenu.menuBarHeight) when the caller has it;
  /// else the gap between the frame and the visible frame stands in.
  public static func make(screenFrame: CGRect, visibleFrame: CGRect, auxiliaryTopLeft: CGRect?, auxiliaryTopRight: CGRect?, menuBarHeight: CGFloat? = nil) -> NotchLayout? {
    guard let left = auxiliaryTopLeft, let right = auxiliaryTopRight, right.minX > left.maxX else { return nil }
    let notch = CGRect(x: left.maxX, y: left.minY, width: right.minX - left.maxX, height: screenFrame.maxY - left.minY)
    var bar = menuBarHeight ?? 0
    if bar < notch.height { bar = screenFrame.maxY - visibleFrame.maxY }
    if bar < notch.height { bar = notch.height + 5 } // menu bar hidden (auto-hide, fullscreen): keep the notch covered
    return NotchLayout(screen: screenFrame, notch: notch, menuBarHeight: bar)
  }

  public var islandHeight: CGFloat { menuBarHeight }
  public var islandWidth: CGFloat { notch.width + 2 * earWidth }

  /// Compact: the ears and the notch between them, flush with the top edge.
  public var islandFrame: CGRect {
    CGRect(x: notch.midX - islandWidth / 2, y: screen.maxY - islandHeight, width: islandWidth, height: islandHeight)
  }

  /// Expanded: a rectangle of `panelWidth` hanging from the top edge, containing the notch.
  public func panelFrame(contentHeight: CGFloat) -> CGRect {
    let h = islandHeight + contentHeight
    return CGRect(x: notch.midX - panelWidth / 2, y: screen.maxY - h, width: panelWidth, height: h)
  }

  /// Ear width when the top row spans the whole panel.
  public var panelEarWidth: CGFloat { (panelWidth - notch.width) / 2 }

  /// The hot zone: only the notch itself, never the menu bar beside it.
  public var hotZone: CGRect { CGRect(x: notch.minX, y: screen.maxY - menuBarHeight, width: notch.width, height: menuBarHeight) }
}
