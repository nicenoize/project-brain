import Foundation

/// The state file the engine writes (`scripts/brain-companion.mjs`, STATE_VERSION 1).
/// Every field the app shows comes from here; nothing is derived from transcripts in Swift.
public struct CompanionState: Codable, Equatable {
  public var v: Int
  public var at: String
  public var atMs: Double
  public var engine: Engine
  public var machine: Machine
  public var sessions: [Session]
  // The bus (additive in STATE_VERSION 1; absent from older engines).
  public var holds: [Hold]?
  public var pending: [Pending]?
  public var events: [Event]?
  /// What leanlamp did since local midnight (absent from older engines).
  public var today: Today?
  /// Open sessions with their RAM and the parked ones (sessions.mjs).
  public var parking: Parking?

  public struct Today: Codable, Equatable {
    public var sinceMs: Double
    public var compactions: Int
    public var prepared: Int
    public var waitedSeconds: Int
    public var held: Int
    public var approved: Int
    public var denied: Int
    public var steered: Int
    public var reclaimedMb: Int
    public init(sinceMs: Double = 0, compactions: Int = 0, prepared: Int = 0, waitedSeconds: Int = 0, held: Int = 0, approved: Int = 0, denied: Int = 0, steered: Int = 0, reclaimedMb: Int = 0) {
      self.sinceMs = sinceMs; self.compactions = compactions; self.prepared = prepared; self.waitedSeconds = waitedSeconds
      self.held = held; self.approved = approved; self.denied = denied; self.steered = steered; self.reclaimedMb = reclaimedMb
    }
  }

  public struct Hold: Codable, Equatable, Identifiable {
    public var id: String
    public var glob: String
    public var root: String?
    public var project: String?
    public var until: Double?
    public var minutesLeft: Int?
    /// How many checkouts of the repository the hold covers (all its worktrees).
    public var worktrees: Int?
    public init(id: String, glob: String, root: String? = nil, project: String? = nil, until: Double? = nil, minutesLeft: Int? = nil, worktrees: Int? = nil) {
      self.id = id; self.glob = glob; self.root = root; self.project = project; self.until = until; self.minutesLeft = minutesLeft; self.worktrees = worktrees
    }
    /// Every edit in every repo.
    public var isAll: Bool { root == nil && (glob == "**" || glob == "**/*") }
  }

  /// An edit the hook is holding until you answer (or its deadline passes).
  public struct Pending: Codable, Equatable, Identifiable {
    public var id: String
    public var session: String?
    public var title: String?
    public var tool: String?
    public var file: String?
    public var shortFile: String?
    public var glob: String?
    public var project: String?
    public var at: Double?
    public var deadline: Double?
    public var secondsLeft: Int?
    public init(id: String, session: String? = nil, title: String? = nil, tool: String? = nil, file: String? = nil, shortFile: String? = nil, glob: String? = nil, project: String? = nil, at: Double? = nil, deadline: Double? = nil, secondsLeft: Int? = nil) {
      self.id = id; self.session = session; self.title = title; self.tool = tool; self.file = file; self.shortFile = shortFile
      self.glob = glob; self.project = project; self.at = at; self.deadline = deadline; self.secondsLeft = secondsLeft
    }
    /// Seconds left at `now`, from the deadline when known (the state file is up to a second old).
    public func secondsLeft(now: Date = Date()) -> Int {
      if let d = deadline { return max(0, Int(((d - now.timeIntervalSince1970 * 1000) / 1000).rounded(.up))) }
      return secondsLeft ?? 0
    }
  }

  public struct Event: Codable, Equatable {
    public var kind: String
    public var at: Double
    public var session: String?
    public var title: String?
    public var id: String?
    public var file: String?
    public var shortFile: String?
    public var text: String?
    public var reason: String?
    public var why: String?
    /// Who answered a held edit: "app" (the notch) or "cli".
    public var by: String?
    /// reclaimed: how many helpers, how much memory.
    public var count: Int?
    public var mb: Double?
    public init(kind: String, at: Double, session: String? = nil, title: String? = nil, id: String? = nil, file: String? = nil, shortFile: String? = nil, text: String? = nil, reason: String? = nil, why: String? = nil, by: String? = nil) {
      self.kind = kind; self.at = at; self.session = session; self.title = title; self.id = id; self.file = file
      self.shortFile = shortFile; self.text = text; self.reason = reason; self.why = why; self.by = by
    }
    public var key: String { "\(kind)|\(id ?? "")|\(Int(at))" }
  }

  public struct Engine: Codable, Equatable {
    public var pid: Int?
    public var intervalMs: Double?
    public var roots: [String]?
    public var statePath: String?
    /// Written once at engine start, before the first pass over the transcripts.
    public var starting: Bool?

    public init(pid: Int? = nil, intervalMs: Double? = nil, roots: [String]? = nil, statePath: String? = nil, starting: Bool? = nil) {
      self.pid = pid; self.intervalMs = intervalMs; self.roots = roots; self.statePath = statePath; self.starting = starting
    }
  }

  public struct Machine: Codable, Equatable {
    public var totalGb: Double?
    public var freePct: Double?
    public var pressure: String?
    public var swapUsedGb: Double?
    public var agentProcesses: Int?
    public var agentRssGb: Double?
    public var orphans: Int?
    /// Memory held by orphaned helpers: what Reclaim would give back.
    public var orphanMb: Double?

    public init(totalGb: Double? = nil, freePct: Double? = nil, pressure: String? = nil, swapUsedGb: Double? = nil, agentProcesses: Int? = nil, agentRssGb: Double? = nil, orphans: Int? = nil, orphanMb: Double? = nil) {
      self.totalGb = totalGb; self.freePct = freePct; self.pressure = pressure; self.swapUsedGb = swapUsedGb
      self.agentProcesses = agentProcesses; self.agentRssGb = agentRssGb; self.orphans = orphans; self.orphanMb = orphanMb
    }
  }

  public struct Session: Codable, Equatable, Identifiable {
    /// What fills the context (scripts/context-map.mjs): the base measured, the parts estimated and scaled.
    public var contextMap: ContextMap?
    public var sessionId: String?
    public var title: String
    public var project: String?
    public var cwd: String?
    public var gitBranch: String?
    public var model: String?
    public var ctx: Int
    public var limit: Int
    public var limitSource: String?
    public var ratio: Double?
    public var burnPerMin: Int
    public var requests: Int?
    public var compactions: Int
    public var state: String
    public var label: String
    public var last: Last?
    public var lastActivityMs: Double?
    public var startedMs: Double?
    public var pid: Int?
    public var rssMb: Double?
    public var transcript: String?
    public var lastCompaction: Compaction?
    /// The companion hook ran for this session: steer and hold reach it.
    public var control: Bool?
    /// Steer notes waiting for its next tool call.
    public var inbox: Int?
    /// Edits of this session waiting for your answer.
    public var held: Int?
    /// What hooks put in front of this agent (counts, and the last few).
    public var injections: Injections?

    public struct Compaction: Codable, Equatable {
      public var trigger: String?
      public var preTokens: Int?
      public var postTokens: Int?
      public var durationMs: Double?
      public var precomputed: Bool?
      public var atMs: Double?
    }

    public var reachable: Bool { control ?? false }

    /// Field by field and forgiving: a field the engine got wrong (a null
    /// where a number belongs, a new shape) costs that field, never the
    /// session, and never the whole state.
    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      func opt<T: Decodable>(_ t: T.Type, _ k: CodingKeys) -> T? { (try? c.decodeIfPresent(t, forKey: k)) ?? nil }
      sessionId = opt(String.self, .sessionId)
      title = opt(String.self, .title) ?? (sessionId.map { String($0.prefix(8)) } ?? "session")
      project = opt(String.self, .project)
      cwd = opt(String.self, .cwd)
      gitBranch = opt(String.self, .gitBranch)
      model = opt(String.self, .model)
      ctx = opt(Int.self, .ctx) ?? 0
      limit = opt(Int.self, .limit) ?? 0
      limitSource = opt(String.self, .limitSource)
      ratio = opt(Double.self, .ratio)
      burnPerMin = opt(Int.self, .burnPerMin) ?? 0
      requests = opt(Int.self, .requests)
      compactions = opt(Int.self, .compactions) ?? 0
      state = opt(String.self, .state) ?? "idle"
      label = opt(String.self, .label) ?? ""
      last = opt(Last.self, .last)
      lastActivityMs = opt(Double.self, .lastActivityMs)
      startedMs = opt(Double.self, .startedMs)
      pid = opt(Int.self, .pid)
      rssMb = opt(Double.self, .rssMb)
      transcript = opt(String.self, .transcript)
      lastCompaction = opt(Compaction.self, .lastCompaction)
      control = opt(Bool.self, .control)
      inbox = opt(Int.self, .inbox)
      held = opt(Int.self, .held)
      injections = opt(Injections.self, .injections)
      contextMap = opt(ContextMap.self, .contextMap)
    }

    /// Stable identity for lists: the session id, else the transcript path, else the title.
    public var id: String { sessionId ?? transcript ?? title }
    public var isIdle: Bool { state == "idle" }
    public var isLive: Bool { !isIdle }
    public var fraction: Double { limit > 0 ? min(1, Double(ctx) / Double(limit)) : 0 }

    enum CodingKeys: String, CodingKey {
      case sessionId = "id", title, project, cwd, gitBranch, model, ctx, limit, limitSource, ratio, burnPerMin, requests, compactions, state, label, last, lastActivityMs, startedMs, pid, rssMb, transcript, lastCompaction, control, inbox, held, injections, contextMap
    }

    public struct Last: Codable, Equatable {
      public var kind: String?
      public var tool: Tool?
      public var text: String?
      public var atMs: Double?
      public struct Tool: Codable, Equatable {
        public var name: String
        public var text: String
      }
    }

    public init(sessionId: String? = nil, title: String, project: String? = nil, cwd: String? = nil, gitBranch: String? = nil, model: String? = nil, ctx: Int, limit: Int, limitSource: String? = nil, ratio: Double? = nil, burnPerMin: Int = 0, requests: Int? = nil, compactions: Int = 0, state: String, label: String, last: Last? = nil, lastActivityMs: Double? = nil, startedMs: Double? = nil, pid: Int? = nil, rssMb: Double? = nil, transcript: String? = nil) {
      self.sessionId = sessionId; self.title = title; self.project = project; self.cwd = cwd; self.gitBranch = gitBranch; self.model = model
      self.ctx = ctx; self.limit = limit; self.limitSource = limitSource; self.ratio = ratio; self.burnPerMin = burnPerMin; self.requests = requests
      self.compactions = compactions; self.state = state; self.label = label; self.last = last; self.lastActivityMs = lastActivityMs
      self.startedMs = startedMs; self.pid = pid; self.rssMb = rssMb; self.transcript = transcript
    }
  }

  public init(v: Int = 1, at: String = "", atMs: Double, engine: Engine = Engine(), machine: Machine = Machine(), sessions: [Session], holds: [Hold]? = nil, pending: [Pending]? = nil, events: [Event]? = nil, receipt: Receipt? = nil, today: Today? = nil) {
    self.v = v; self.at = at; self.atMs = atMs; self.engine = engine; self.machine = machine; self.sessions = sessions
    self.holds = holds; self.pending = pending; self.events = events; self.receipt = receipt; self.today = today
  }

  /// Context hooks injected: totals by source, and for a session the last few.
  public struct Injections: Codable, Equatable {
    public var count: Int
    public var estTokens: Int

    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      count = ((try? c.decodeIfPresent(Int.self, forKey: .count)) ?? nil) ?? 0
      estTokens = ((try? c.decodeIfPresent(Int.self, forKey: .estTokens)) ?? nil) ?? 0
      bySource = (try? c.decodeIfPresent([String: SourceTotals].self, forKey: .bySource)) ?? nil
      byKind = (try? c.decodeIfPresent([String: SourceTotals].self, forKey: .byKind)) ?? nil
      last = (try? c.decodeIfPresent([Lenient<Injection>].self, forKey: .last))??.compactMap { $0.value }
      byName = (try? c.decodeIfPresent([String: Lenient<Named>].self, forKey: .byName))??.compactMapValues { $0.value }
    }
    enum CodingKeys: String, CodingKey { case count, estTokens, bySource, byKind, last, byName }
    /// Every source by the name a person knows it by (a plugin, our brain, a hook's first line).
    public var byName: [String: Named]?
    public struct Named: Codable, Equatable {
      public var count: Int
      public var estTokens: Int?
      public var event: String?
      /// "vercel@claude-plugins-official" when a plugin's hook put it there.
      public var plugin: String?
    }
    /// The sources, biggest first.
    public var named: [(name: String, value: Named)] { (byName ?? [:]).map { ($0.key, $0.value) }.sorted { ($0.value.estTokens ?? 0) > ($1.value.estTokens ?? 0) } }
    public var bySource: [String: SourceTotals]?
    /// The brain's injections by kind: hint (asks for a command, scored), answer (before an edit), state (after a compaction).
    public var byKind: [String: SourceTotals]?
    public var last: [Injection]?

    public struct SourceTotals: Codable, Equatable {
      public var count: Int
      public var estTokens: Int?
      public var actionable: Int?
      public var followed: Int?
      public var followedShare: Double?
    }

    public struct Injection: Codable, Equatable {
      public var at: Double?
      public var source: String
      public var event: String
      public var chars: Int
      public var text: String
      public var commands: [String]?
      /// The command the agent ran within five calls; nil when it did not (or nothing was named).
      public var followedCommand: String?
      /// Whether "followed" applies at all (the text named a brain command).
      public var scored: Bool

      enum CodingKeys: String, CodingKey { case at, source, event, chars, text, commands, followed }

      public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = try c.decodeIfPresent(Double.self, forKey: .at)
        source = try c.decode(String.self, forKey: .source)
        event = try c.decode(String.self, forKey: .event)
        chars = try c.decode(Int.self, forKey: .chars)
        text = try c.decode(String.self, forKey: .text)
        commands = try c.decodeIfPresent([String].self, forKey: .commands)
        // `followed` is null (not scored), false (missed) or the command name (followed)
        if let s = try? c.decodeIfPresent(String.self, forKey: .followed) { followedCommand = s; scored = true }
        else if (try? c.decodeIfPresent(Bool.self, forKey: .followed)) != nil { followedCommand = nil; scored = true }
        else { followedCommand = nil; scored = false }
      }

      public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(at, forKey: .at)
        try c.encode(source, forKey: .source)
        try c.encode(event, forKey: .event)
        try c.encode(chars, forKey: .chars)
        try c.encode(text, forKey: .text)
        try c.encodeIfPresent(commands, forKey: .commands)
        if let f = followedCommand { try c.encode(f, forKey: .followed) } else if scored { try c.encode(false, forKey: .followed) } else { try c.encodeNil(forKey: .followed) }
      }
    }

    public var brain: SourceTotals? { bySource?["brain"] }
    /// The command hints alone; older receipts without kinds count every brain injection.
    public var hints: SourceTotals? { byKind?["hint"] ?? brain }
  }

  /// The hourly receipt (companion-receipt.mjs), when one has been computed.
  public var receipt: Receipt?
  /// Whether live transcripts still look like what the engine understands.
  public var format: Format?

  public struct Format: Codable, Equatable {
    public var ok: Bool
    public var versions: [String]
    public var newestTested: String?
    public var newerThanTested: Bool?
    public var issues: [Issue]?
    public struct Issue: Codable, Equatable { public var session: String?; public var title: String?; public var issues: [String] }

    /// One line for the machine view.
    public var line: String {
      if !ok, let first = issues?.first { return "transcript format changed: \(first.title ?? "a session"): \(first.issues.joined(separator: "; "))" }
      let v = versions.isEmpty ? "?" : versions.joined(separator: ", ")
      return "transcript format ok · Claude Code \(v)" + ((newerThanTested ?? false) ? " (newer than tested \(newestTested ?? ""))" : "")
    }
  }

  public struct Receipt: Codable, Equatable {
    public var atMs: Double
    public var days: Int
    public var source: Source
    public var trim: Trim
    public var projects: [Project]
    public var guardian: Guard
    public var steer: Steer
    /// What hooks injected over the period (absent from receipts before it was measured).
    public var got: Injections?

    enum CodingKeys: String, CodingKey { case atMs, days, source, trim, projects, guardian = "guard", steer, got }

    public struct Source: Codable, Equatable { public var transcripts: Int; public var bytes: Double; public var ms: Double }
    public struct Trim: Codable, Equatable {
      public var sessions: Int
      public var requests: Int
      public var contextP50: Int
      public var contextP90: Int
      public var contextMax: Int
      public var shareAbove500k: Double
      public var compactions: Int
      public var precomputedShare: Double
      public var avgWaitSeconds: Double?
      /// What the receipt shows (absent before it was kept): one long compaction does not move it.
      public var medianWaitSeconds: Double?
      public var waitSeconds: Double? { medianWaitSeconds ?? avgWaitSeconds }
    }
    public struct Project: Codable, Equatable, Identifiable {
      public var project: String
      public var cwd: String?
      public var window: Int?
      public var windowSource: String?
      public var sessions: Int
      public var requests: Int
      public var contextP50: Int
      public var contextP90: Int
      public var shareAbove500k: Double
      public var compactions: Int
      public var precomputedShare: Double
      public var avgWaitSeconds: Double?
      public var id: String { project + (cwd ?? "") }
    }
    public struct Guard: Codable, Equatable { public var held: Int; public var approved: Int; public var approvedFromNotch: Int; public var denied: Int; public var handedBack: Int }
    public struct Steer: Codable, Equatable { public var delivered: Int; public var medianWaitSeconds: Double? }
  }

  enum CodingKeys: String, CodingKey { case v, at, atMs, engine, machine, sessions, holds, pending, events, receipt, format, today }

  /// The envelope must be there (v, atMs, sessions); everything optional is
  /// read forgivingly, and one unreadable session is skipped, not fatal.
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    func opt<T: Decodable>(_ t: T.Type, _ k: CodingKeys) -> T? { (try? c.decodeIfPresent(t, forKey: k)) ?? nil }
    v = opt(Int.self, .v) ?? 1
    at = opt(String.self, .at) ?? ""
    atMs = try c.decode(Double.self, forKey: .atMs)
    engine = opt(Engine.self, .engine) ?? Engine()
    machine = opt(Machine.self, .machine) ?? Machine()
    sessions = (opt([Lenient<Session>].self, .sessions) ?? []).compactMap { $0.value }
    holds = opt([Lenient<Hold>].self, .holds)?.compactMap { $0.value }
    pending = opt([Lenient<Pending>].self, .pending)?.compactMap { $0.value }
    events = opt([Lenient<Event>].self, .events)?.compactMap { $0.value }
    receipt = opt(Receipt.self, .receipt)
    format = opt(Format.self, .format)
    today = opt(Today.self, .today)
  }

  public var openPending: [Pending] { pending ?? [] }
  public var activeHolds: [Hold] { holds ?? [] }
  public var holdsAll: Bool { activeHolds.contains { $0.isAll } }
  public var reachableCount: Int { sessions.filter { $0.reachable }.count }

  /// Sessions that are not idle, busiest first.
  public var live: [Session] { sessions.filter { $0.isLive }.sorted { $0.ctx > $1.ctx } }
  public var idle: [Session] { sessions.filter { $0.isIdle } }
  /// The session the island speaks for: the fullest live one, else the fullest of all.
  public var busiest: Session? { live.first ?? sessions.max { $0.ctx < $1.ctx } }
  public var waiting: [Session] { live.filter { $0.state == "waiting" } }

  /// Older than `maxAgeMs` means the engine stopped writing.
  public func isStale(now: Date = Date(), maxAgeMs: Double = 10_000) -> Bool {
    now.timeIntervalSince1970 * 1000 - atMs > maxAgeMs
  }

  public static func decode(_ data: Data) throws -> CompanionState {
    try JSONDecoder().decode(CompanionState.self, from: data)
  }
}

/// Decodes a value or nothing: one bad element in an array costs that element.
public struct Lenient<T: Decodable>: Decodable {
  public let value: T?
  public init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}
