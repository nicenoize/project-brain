import Foundation

/// What VoiceOver says: the facts the ears and rows show, in words. PURE.
public enum Speech {
  public enum Engine { case off, starting, live }

  public static func island(state: CompanionState?, engine: Engine, toast: Toast?) -> String {
    switch engine {
    case .off: return "leanlamp. The engine is not running."
    case .starting: return "leanlamp. Starting, reading the transcripts."
    case .live: break
    }
    guard let s = state else { return "leanlamp" }
    var parts = ["leanlamp", "\(s.live.count) live session\(s.live.count == 1 ? "" : "s")"]
    if let b = s.busiest {
      parts.append("fullest: \(b.title), \(Gauge.k(b.ctx)) of \(Gauge.k(b.limit)) context")
    }
    if let t = toast {
      parts.append(t.attention ? "needs you: \(t.subject) \(t.verb) \(t.text), \(t.number) left" : "\(t.kind): \(t.subject) \(t.text)")
    } else if !s.waiting.isEmpty {
      parts.append("\(s.waiting.count) waiting for you")
    }
    if !s.activeHolds.isEmpty { parts.append("\(s.activeHolds.count) hold\(s.activeHolds.count == 1 ? "" : "s") active") }
    return parts.joined(separator: ". ")
  }
}
