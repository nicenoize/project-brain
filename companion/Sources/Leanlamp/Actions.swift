import Foundation
import LeanlampCore

/// Every click goes through the same CLI a person would type
/// (`brain:companion steer|hold|release|approve|deny`), so the bus format
/// lives in one tested place. Calls run off the main thread; the result
/// comes back on it.
final class Actions: ObservableObject {
  /// Ids of pending edits we already answered, so the toast does not offer the buttons twice.
  @Published private(set) var answered: Set<String> = []
  @Published private(set) var lastMessage: String?
  /// Commands in flight: busy while any runs (a quick approve must not end a long receipt's busy state).
  @Published private(set) var inFlight = 0
  var busy: Bool { inFlight > 0 }

  private let script: String?
  private let statePath: String

  init(script: String?, statePath: String) {
    self.script = script
    self.statePath = statePath
  }

  var available: Bool { script != nil }

  /// Shown as SENT at once; taken back if the command fails, so the buttons return.
  func approve(_ id: String) { answer(id, "approve") }
  func deny(_ id: String) { answer(id, "deny") }
  private func answer(_ id: String, _ verb: String) {
    answered.insert(id)
    run([verb, id]) { [weak self] ok in if !ok { self?.answered.remove(id) } }
  }
  func steer(session: String, text: String, done: ((Bool) -> Void)? = nil) {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty else { done?(false); return }
    run(["steer", session, "--", t], done: done) // the note is literal: "--no-verify" stays text
  }
  func holdAll(minutes: Int = 30) { run(["hold", "--all", "--for", "\(minutes)m"]) }
  func releaseAll() { run(["release", "--all"]) }
  /// Recompute the receipt now (the engine also does it hourly); ~10 s for 2 GB of transcripts.
  @Published private(set) var computingReceipt = false
  func recomputeReceipt() {
    guard !computingReceipt else { return } // one scan of the transcripts at a time
    computingReceipt = true
    run(["receipt", "--write"]) { [weak self] _ in self?.computingReceipt = false }
  }

  /// Sessions being parked right now: their rows show PARKING until the next state.
  @Published private(set) var parking: Set<String> = []
  /// Write the card, then end the session (sessions.mjs refuses a working one).
  func park(_ sessionId: String) {
    parking.insert(sessionId)
    run(["park", sessionId]) { [weak self] _ in self?.parking.remove(sessionId) }
  }
  func parkAll(_ ids: [String]) { for id in ids { park(id) } }
  /// Open a parked session again in a new Terminal window (`claude --resume`).
  func resume(_ sessionId: String) { run(["resume", sessionId]) }

  /// Stop orphaned helpers (their agent is gone). Nothing else is touched.
  func reclaim() { run(["reclaim"]) }

  /// "Later" on an interruption: the same toast stays away for an hour.
  @Published private(set) var snoozed: [String: Date] = [:]
  func snooze(_ key: String, for seconds: TimeInterval = 3600) { snoozed[key] = Date().addingTimeInterval(seconds) }
  var dismissedKeys: Set<String> { Set(snoozed.filter { $0.value > Date() }.keys) }

  /// Whether the companion hook is in every settings file running sessions use, and which files those are.
  @Published private(set) var hookTargets: [String] = []
  @Published private(set) var hooksInstalled: Bool?

  func refreshHookStatus(done: (() -> Void)? = nil) {
    run(["install-hooks", "--dry-run"], quiet: true) { [weak self] ok, out in
      if ok, let data = out.data(using: .utf8), let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
        self?.hooksInstalled = j["installed"] as? Bool
        self?.hookTargets = ((j["targets"] as? [[String: Any]]) ?? []).compactMap { $0["file"] as? String }
      }
      done?()
    }
  }
  func installHooks(done: ((Bool) -> Void)? = nil) { run(["install-hooks"], quiet: false) { [weak self] ok, _ in self?.refreshHookStatus(); self?.runCheck(); done?(ok) } }

  /// The setup check (`check --json`): exit 1 just means a ✗ row, the report is on stdout either way.
  @Published private(set) var setup: SetupReport?
  @Published private(set) var setupAt: Date?
  @Published private(set) var checking = false
  func runCheck() {
    guard !checking else { return }
    checking = true
    run(["check"], quiet: true) { [weak self] _, out in
      guard let self else { return }
      self.checking = false
      if let r = SetupReport.decode(Data(out.utf8)) { self.setup = r; self.setupAt = Date() }
    }
  }
  func uninstallHooks(done: ((Bool) -> Void)? = nil) { run(["uninstall-hooks"], quiet: false) { [weak self] ok, _ in self?.refreshHookStatus(); done?(ok) } }

  private func run(_ args: [String], done: ((Bool) -> Void)? = nil) {
    run(args, quiet: false) { ok, _ in done?(ok) }
  }

  /// `quiet`: no busy flag and no error line (status probes).
  private func run(_ args: [String], quiet: Bool, done: ((Bool, String) -> Void)?) {
    guard let script else {
      if !quiet { lastMessage = "no engine script — set LEANLAMP_ENGINE" }
      done?(false, "")
      return
    }
    if !quiet { inFlight += 1 }
    let statePath = self.statePath
    DispatchQueue.global(qos: .userInitiated).async {
      let p = Process()
      let (exe, argv) = NodeLocator.command(script, ["--state", statePath, "--json"] + args) // flags first: whatever follows `--` is literal
      p.executableURL = exe
      p.arguments = argv
      var env = ProcessInfo.processInfo.environment
      env["PATH"] = NodeLocator.childPath(env["PATH"])
      env["BRAIN_COMPANION_FROM"] = "app"
      env["BRAIN_USAGE_LOG"] = "0"
      p.environment = env
      let out = Pipe(), err = Pipe()
      p.standardOutput = out
      p.standardError = err
      var ok = false
      var message = ""
      var stdout = ""
      do {
        try p.run()
        // Read both pipes at once (a full stderr pipe must never stall the child), and give up after 60 s.
        var errData = Data()
        let errDone = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .utility).async { errData = err.fileHandleForReading.readDataToEndOfFile(); errDone.signal() }
        let killer = DispatchWorkItem { if p.isRunning { p.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + 60, execute: killer)
        let outData = out.fileHandleForReading.readDataToEndOfFile()
        errDone.wait()
        p.waitUntilExit()
        killer.cancel()
        ok = p.terminationStatus == 0
        stdout = String(data: outData, encoding: .utf8) ?? ""
        message = (String(data: ok ? outData : errData, encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if p.terminationReason == .uncaughtSignal && !ok { message = "timed out after 60 s" }
      } catch {
        message = "\(error)"
      }
      DispatchQueue.main.async {
        if !quiet {
          self.inFlight = max(0, self.inFlight - 1)
          self.lastMessage = ok ? nil : message.replacingOccurrences(of: "[brain:companion] ", with: "")
        }
        if !ok && args.first != "check" { NSLog("leanlamp: \(args.first ?? "") failed: \(message)") } // a ✗ in check is a report, not a failure
        done?(ok, stdout)
      }
    }
  }
}
