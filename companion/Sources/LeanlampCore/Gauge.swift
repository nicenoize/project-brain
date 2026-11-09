import Foundation

/// The eight-segment gauge and the number next to it. Same rules as the mockups:
/// filled = round(ratio × 8), at least one segment once anything is in the
/// context; orange when a session is near its compaction mark or needs you.
public enum Gauge {
  public static let segments = 8
  public static let hotRatio = 0.75

  public static func filled(fraction: Double) -> Int {
    if fraction <= 0 { return 0 }
    return max(1, min(segments, Int((fraction * Double(segments)).rounded())))
  }

  public static func isHot(fraction: Double, needsYou: Bool = false) -> Bool {
    needsYou || fraction >= hotRatio
  }

  /// 211400 → "211k", 1_234_000 → "1.2M", 999 → "1k", 0 → "0k".
  public static func k(_ n: Int) -> String {
    if n >= 1_000_000 {
      let m = Double(n) / 1_000_000
      return m == m.rounded() ? "\(Int(m))M" : String(format: "%.1fM", m)
    }
    return "\(Int((Double(n) / 1000).rounded()))k"
  }

  /// "2 min", "1 h 05 min"; nil when unknown.
  public static func age(ms: Double?, now: Date = Date()) -> String? {
    guard let ms else { return nil }
    let minutes = Int(((now.timeIntervalSince1970 * 1000 - ms) / 60_000).rounded(.down))
    if minutes < 1 { return "now" }
    if minutes < 60 { return "\(minutes) min" }
    return String(format: "%d h %02d min", minutes / 60, minutes % 60)
  }
}
