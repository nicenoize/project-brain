import Foundation

/// Open sessions with their RAM, and the parked ones with what they were
/// about (scripts/sessions.mjs `parkingView`). Field by field and forgiving,
/// like the rest of the state: a bad row costs that row, never the state.
public struct Parking: Codable, Equatable {
  public var at: Double?
  public var idleHours: Double?
  public var openMb: Double
  public var idleMb: Double
  public var open: [Open]
  public var parked: [Card]

  public struct Open: Codable, Equatable, Identifiable {
    public var pid: Int
    public var sessionId: String
    public var title: String
    public var project: String?
    public var cwd: String?
    public var mb: Double
    public var helpers: Int?
    public var status: String?
    public var lastMessageMs: Double?
    public var park: Bool
    public var why: String?
    public var id: String { sessionId }

    public init(pid: Int, sessionId: String, title: String, mb: Double, park: Bool, lastMessageMs: Double? = nil, why: String? = nil) {
      self.pid = pid; self.sessionId = sessionId; self.title = title; self.mb = mb; self.park = park; self.lastMessageMs = lastMessageMs; self.why = why
    }
  }

  public struct Card: Codable, Equatable, Identifiable {
    public var sessionId: String
    public var title: String
    public var project: String?
    public var cwd: String?
    public var branch: String?
    public var goal: String?
    public var lastAsk: String?
    public var lastAgent: String?
    public var edited: [String]?
    public var lastMessageMs: Double?
    public var parkedAt: Double?
    public var freedMb: Double?
    public var resume: String?
    public var id: String { sessionId }

    public init(sessionId: String, title: String, goal: String? = nil, resume: String? = nil) {
      self.sessionId = sessionId; self.title = title; self.goal = goal; self.resume = resume
    }
  }

  public init(openMb: Double = 0, idleMb: Double = 0, open: [Open] = [], parked: [Card] = []) {
    self.openMb = openMb; self.idleMb = idleMb; self.open = open; self.parked = parked
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    at = (try? c.decodeIfPresent(Double.self, forKey: .at)) ?? nil
    idleHours = (try? c.decodeIfPresent(Double.self, forKey: .idleHours)) ?? nil
    openMb = ((try? c.decodeIfPresent(Double.self, forKey: .openMb)) ?? nil) ?? 0
    idleMb = ((try? c.decodeIfPresent(Double.self, forKey: .idleMb)) ?? nil) ?? 0
    open = ((try? c.decodeIfPresent([Lenient<Open>].self, forKey: .open)) ?? nil)?.compactMap { $0.value } ?? []
    parked = ((try? c.decodeIfPresent([Lenient<Card>].self, forKey: .parked)) ?? nil)?.compactMap { $0.value } ?? []
  }
  enum CodingKeys: String, CodingKey { case at, idleHours, openMb, idleMb, open, parked }

  /// Sessions quiet long enough to park.
  public var quiet: [Open] { open.filter { $0.park } }
}

/// "3 h ago" for a millisecond timestamp.
public func agoText(_ ms: Double?, now: Date = Date()) -> String {
  guard let ms else { return "—" }
  let m = Int(((now.timeIntervalSince1970 * 1000 - ms) / 60_000).rounded())
  if m < 60 { return "\(max(0, m)) min ago" }
  let h = Int((Double(m) / 60).rounded())
  if h < 48 { return "\(h) h ago" }
  return "\(Int((Double(h) / 24).rounded())) days ago"
}

public func mbText(_ mb: Double) -> String { mb >= 1024 ? String(format: "%.1f GB", mb / 1024) : "\(Int(mb.rounded())) MB" }
