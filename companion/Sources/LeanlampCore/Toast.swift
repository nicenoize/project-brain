import Foundation

/// The line that hangs under the island. Orange only when you are needed
/// (an edit waits for your answer); everything else is white on black and
/// leaves after six seconds. Picked from the state alone, so it is PURE.
public struct Toast: Equatable {
  public var key: String
  public var kind: String
  /// Who it is about (a session title) — shown bold, cut first when space is short.
  public var subject: String
  /// A short verb kept whole between subject and text ("wants to edit").
  public var verb: String
  /// What happened — cut from the front when space is short (paths end in the file name).
  public var text: String
  public var number: String
  public var attention: Bool
  /// Set when the toast is a held edit: Approve / Deny act on this id.
  public var pendingId: String?
  /// A memory toast with something of ours to give back: Reclaim / Later.
  public var reclaimable: Bool = false
  public var isMemory: Bool { kind == "memory" }
  /// The one-time hello on first launch: what the island is, how to open it, Connect.
  public var welcome: Bool = false
  public static let welcomeKey = "welcome"
  public static let welcomeSeconds: Double = 20

  public init(key: String, kind: String, subject: String = "", verb: String = "", text: String, number: String = "", attention: Bool = false, pendingId: String? = nil) {
    self.key = key; self.kind = kind; self.subject = subject; self.verb = verb; self.text = text; self.number = number; self.attention = attention; self.pendingId = pendingId
  }

  public static let infoSeconds: Double = 6

  /// A title cut to `max` characters with an ellipsis, so the row can size it to its text.
  public static func short(_ s: String, _ max: Int) -> String {
    s.count <= max ? s : String(s.prefix(max - 1)).trimmingCharacters(in: .whitespaces) + "…"
  }

  public static func pick(_ state: CompanionState?, now: Date = Date(), dismissed: Set<String> = [], welcomeUntil: Date? = nil) -> Toast? {
    guard let state else { return nil }
    if let p = state.openPending.first {
      let what = p.shortFile ?? p.file ?? "a file"
      let more = state.openPending.count > 1 ? " · +\(state.openPending.count - 1) more" : ""
      return Toast(key: "pending|\(p.id)", kind: "held", subject: p.title ?? "an agent", verb: "wants to \((p.tool ?? "edit").lowercased())", text: "\(what)\(more)", number: "\(p.secondsLeft(now: now))s", attention: true, pendingId: p.id)
    }
    // The second and last interruption: memory pressure, but only when it is
    // critical, or when something of ours (orphaned helpers) can give memory back.
    if let m = state.machine as CompanionState.Machine?, let p = m.pressure, p == "critical" || (p == "warn" && (m.orphans ?? 0) > 0) {
      let n = m.orphans ?? 0
      let mb = Int(m.orphanMb ?? 0)
      let key = "memory|\(p)|\(n)"
      if !dismissed.contains(key) {
        let what = n > 0 ? "\(n) orphaned helper\(n == 1 ? "" : "s") hold \(mb >= 1024 ? String(format: "%.1f GB", Double(mb) / 1024) : "\(mb) MB")" : "nothing of ours to give back · brain:ps lists idle sessions"
        var t = Toast(key: key, kind: "memory", subject: "pressure \(p)", text: what, number: n > 0 ? (mb >= 1024 ? String(format: "%.1f GB", Double(mb) / 1024) : "\(mb) MB") : "", attention: true)
        t.reclaimable = n > 0
        return t
      }
    }
    let nowMs = now.timeIntervalSince1970 * 1000
    let fresh: (Double) -> Bool = { at in nowMs - at >= -2000 && nowMs - at < infoSeconds * 1000 }
    var candidates: [(Double, Toast)] = []
    for e in state.events ?? [] where fresh(e.at) {
      guard let t = info(for: e), !dismissed.contains(t.key) else { continue }
      candidates.append((e.at, t))
    }
    for s in state.sessions {
      guard let c = s.lastCompaction, let at = c.atMs, fresh(at) else { continue }
      let pre = c.preTokens.map(Gauge.k) ?? "?", post = c.postTokens.map(Gauge.k) ?? "?"
      let t = Toast(key: "compacted|\(s.id)|\(Int(at))", kind: "compacted", subject: s.title, text: "\(pre) → \(post)\(c.precomputed == true ? " · prepared in advance, no wait" : "")", number: post)
      if dismissed.contains(t.key) { continue }
      candidates.append((at, t))
    }
    if let t = candidates.max(by: { $0.0 < $1.0 })?.1 { return t }
    // Lowest of all: the first-launch hello, while nothing else has anything to say.
    if let until = welcomeUntil, now < until, !dismissed.contains(welcomeKey) { return welcomeToast(state) }
    return nil
  }

  static func welcomeToast(_ state: CompanionState) -> Toast {
    let n = state.live.count
    // short enough to fit whole next to Connect… and Got it (640 pt)
    var t = n == 0
      ? Toast(key: welcomeKey, kind: "hello", subject: "no session yet", text: "start claude · ⌥⌘L opens this")
      : Toast(key: welcomeKey, kind: "hello", subject: "\(n) session\(n == 1 ? "" : "s") here", text: "click or ⌥⌘L opens them")
    t.welcome = true
    return t
  }

  static func info(for e: CompanionState.Event) -> Toast? {
    let who = e.title ?? "an agent"
    let file = e.shortFile.map { ($0 as NSString).lastPathComponent } ?? e.file.map { ($0 as NSString).lastPathComponent } ?? ""
    let via = e.by == "app" ? " from the notch" : e.by == "cli" ? " from the terminal" : ""
    switch e.kind {
    case "steer-delivered":
      return Toast(key: e.key, kind: "steer delivered", subject: who, verb: "reads your note:", text: "“\(e.text ?? "")”")
    case "approved":
      return Toast(key: e.key, kind: "approved", subject: who, verb: "may edit", text: "\(file) · approved\(via)")
    case "denied":
      return Toast(key: e.key, kind: "denied", subject: who, verb: "may not edit", text: "\(file) · declined\(via), told why")
    case "reclaimed":
      return Toast(key: e.key, kind: "reclaimed", subject: "\(e.count ?? 0) orphaned helper\((e.count ?? 0) == 1 ? "" : "s") stopped", text: "\(Int(e.mb ?? 0)) MB back")
    case "held-ask" where e.why == "timeout":
      return Toast(key: e.key, kind: "no answer", subject: who, verb: "asks in the terminal:", text: "\(file) · nothing was blocked")
    default:
      return nil
    }
  }
}
