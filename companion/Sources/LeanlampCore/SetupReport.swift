import Foundation

/// `brain:companion check --json`: what `leanlamp init` sets up and whether it
/// works. Read-only on the engine side; the app shows it in the Machine tab.
public struct SetupReport: Decodable, Equatable {
  public struct Check: Decodable, Equatable, Identifiable {
    public enum Status: String, Decodable { case ok, warn, fail }
    public let id: String
    public let status: Status
    public let text: String
    public let fix: String?
    /// Several checks share an id (one hook row per settings file).
    public var rowKey: String { "\(id)|\(text)" }
    public var mark: String { status == .ok ? "✓" : status == .fail ? "✗" : "·" }
  }

  public let ok: Bool
  public let checks: [Check]

  enum Keys: String, CodingKey { case ok, checks }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    checks = ((try? c.decode([Lenient<Check>].self, forKey: .checks)) ?? []).compactMap { $0.value }
    ok = (try? c.decode(Bool.self, forKey: .ok)) ?? !checks.contains { $0.status == .fail }
  }

  public init(ok: Bool, checks: [Check]) { self.ok = ok; self.checks = checks }

  public static func decode(_ data: Data) -> SetupReport? {
    guard let r = try? JSONDecoder().decode(SetupReport.self, from: data), !r.checks.isEmpty else { return nil }
    return r
  }

  public var failures: Int { checks.filter { $0.status == .fail }.count }
  /// The hook is missing or stale somewhere: Connect fixes it.
  public var needsConnect: Bool { checks.contains { $0.id == "hook" && $0.status == .fail } }
}
