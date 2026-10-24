import Foundation

/// The wall by keyboard: ⌥⌘L opens it with the focus, then
///
///   ↑ ↓ / k j   move the cursor over the sessions
///   1 … 6       jump to a session
///   ⏎           steer the session under the cursor
///   A / D       approve / deny the oldest held edit
///   H           hold all edits, or release them
///   O           open the window
///   esc         fold (the panel handles it)
///
/// PURE: the mapping and the cursor maths, so the self-test covers them.
public enum WallKey: Equatable {
  case move(Int)
  case jump(Int)
  case steer
  case approve
  case deny
  case hold
  case open

  /// Arrow key codes are the same on every layout; letters come as characters.
  public static func from(keyCode: UInt16, characters: String?, modifiers: Bool) -> WallKey? {
    if modifiers { return nil } // ⌘A, ⌥D … belong to the system
    switch keyCode {
    case 126: return .move(-1)
    case 125: return .move(1)
    case 36, 76: return .steer
    default: break
    }
    switch characters?.lowercased() {
    case "k": return .move(-1)
    case "j": return .move(1)
    case "a": return .approve
    case "d": return .deny
    case "h": return .hold
    case "o": return .open
    case let c? where c.count == 1:
      if let n = Int(c), n >= 1, n <= 9 { return .jump(n - 1) }
      return nil
    default: return nil
    }
  }

  /// The cursor after a key, over `count` rows; nil when there is nothing to point at.
  public static func cursor(_ current: Int?, _ key: WallKey, count: Int) -> Int? {
    guard count > 0 else { return nil }
    switch key {
    case .move(let d):
      guard let c = current else { return d > 0 ? 0 : count - 1 }
      return min(count - 1, max(0, c + d))
    case .jump(let i):
      return i < count ? i : current
    default:
      return current.map { min($0, count - 1) }
    }
  }

  /// One line for the footer while the wall has the keyboard.
  public static let legend = "↑↓ select · ⏎ steer · A/D answer · H hold · esc"
}
