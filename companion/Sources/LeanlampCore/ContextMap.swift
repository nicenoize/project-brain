import Foundation

/// What fills a session's context window, as the engine estimates it
/// (scripts/context-map.mjs): `base` is measured (system prompt, tools,
/// CLAUDE.md), the parts are estimated from the transcript and scaled to the
/// real context by `scale`.
public struct ContextMap: Codable, Equatable {
  public struct Part: Codable, Equatable { public var kind: String; public var tokens: Int; public init(kind: String, tokens: Int) { self.kind = kind; self.tokens = tokens } }
  public struct Item: Codable, Equatable { public var kind: String; public var label: String; public var tokens: Int; public init(kind: String, label: String, tokens: Int) { self.kind = kind; self.label = label; self.tokens = tokens } }
  public var ctx: Int
  public var base: Int?
  public var scale: Double
  public var since: String
  public var parts: [Part]
  public var top: [Item]

  public init(ctx: Int, base: Int?, scale: Double = 1, since: String = "start", parts: [Part], top: [Item] = []) {
    self.ctx = ctx; self.base = base; self.scale = scale; self.since = since; self.parts = parts; self.top = top
  }

  /// Words for a part, as the wall shows it.
  public static func name(_ kind: String) -> String {
    switch kind {
    case "base": return "system + tools"
    case "bash": return "command output"
    case "read": return "file reads"
    case "search": return "search results"
    case "web": return "web pages"
    case "mcp": return "MCP results"
    case "agents": return "subagent reports"
    case "edits": return "edits"
    case "assistant": return "agent's writing"
    case "you": return "your prompts"
    case "hooks": return "hook notes"
    case "summary": return "compaction summary"
    default: return "other"
    }
  }

  /// The biggest part the agent can change by working differently, when it is
  /// at least a quarter of the context: what it is, and a note to steer with. PURE.
  public var advice: (part: Part, note: String)? {
    guard ctx > 0 else { return nil }
    let notes: [String: String] = [
      "bash": "Keep command output short: pipe long runs through tail or grep, run only the failing tests.",
      "read": "Read files in ranges (offset/limit) and search before reading whole files.",
      "search": "Narrow searches with a path or glob and head_limit before listing matches.",
      "web": "Summarize fetched pages in a few lines instead of keeping them whole.",
      "mcp": "Ask MCP tools for less: narrower queries, fewer fields.",
      "agents": "Ask subagents for short reports: findings and file paths, no transcripts.",
      "assistant": "Write shorter: edit files with small replacements, no long heredocs or recaps."
    ]
    guard let p = parts.first(where: { notes[$0.kind] != nil }), Double(p.tokens) >= 0.25 * Double(ctx), let note = notes[p.kind] else { return nil }
    return (p, note)
  }
}
