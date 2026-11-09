import Foundation

/// Starts `brain:companion --watch` when no engine is writing the state file.
/// The engine refuses to run twice (pid file), so starting it is always safe.
final class EngineLauncher {
  private var process: Process?
  let script: String?

  init(env: [String: String] = ProcessInfo.processInfo.environment) {
    script = EngineLauncher.findScript(env: env)
  }

  /// LEANLAMP_ENGINE, else the path the bundler wrote into Info.plist, else the
  /// repo this binary was built in (.build/<config>/leanlamp → companion/ → repo/).
  static func findScript(env: [String: String]) -> String? {
    let fm = FileManager.default
    if let s = env["LEANLAMP_ENGINE"], fm.fileExists(atPath: s) { return s }
    if let s = Bundle.main.object(forInfoDictionaryKey: "LeanlampEngine") as? String, fm.fileExists(atPath: s) { return s }
    var url = Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0])
    url.resolveSymlinksInPath()
    for _ in 0..<6 {
      url.deleteLastPathComponent()
      let candidate = url.appendingPathComponent("scripts/brain-companion.mjs").path
      if fm.fileExists(atPath: candidate) { return candidate }
    }
    return nil
  }

  var isRunning: Bool { process?.isRunning ?? false }

  /// Start unless a fresh state file says an engine is already at work.
  func startIfNeeded(store: StateStore) {
    store.poll()
    if let s = store.state, !s.isStale() { return }
    guard let script else {
      NSLog("leanlamp: no engine found — set LEANLAMP_ENGINE=/path/to/scripts/brain-companion.mjs or run `npm run brain:companion -- --watch`")
      return
    }
    let p = Process()
    // A bounded heap keeps the footprint flat (≈ 90 MB instead of ≈ 150 MB after
    // the first read); the engine streams, so it never needs more.
    let heapFlag = "--max-old-space-size=\(ProcessInfo.processInfo.environment["LEANLAMP_ENGINE_HEAP_MB"] ?? "96")"
    let (exe, argv) = NodeLocator.command(script, ["--watch", "--parent", String(ProcessInfo.processInfo.processIdentifier)], nodeFlags: [heapFlag])
    p.executableURL = exe
    p.arguments = argv
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = NodeLocator.childPath(env["PATH"])
    p.environment = env
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.standardError
    do {
      try p.run()
      process = p
      store.engineStartedAt = Date()
      NSLog("leanlamp: engine started (pid \(p.processIdentifier)) — \(script)")
    } catch {
      NSLog("leanlamp: could not start the engine: \(error)")
    }
  }

  private var restarts: [Date] = []
  private var watchdog: Timer?

  /// If the engine we started dies and nothing else writes the state file,
  /// start it again — at most three times in ten minutes, then leave the
  /// island saying "no engine" rather than looping.
  func supervise(store: StateStore) {
    watchdog?.invalidate()
    // Whoever started the engine (this app, a terminal, a previous run of the
    // app), if nothing writes the state file any more, start one — at most
    // three times in ten minutes.
    let t = Timer(timeInterval: 5, repeats: true) { [weak self, weak store] _ in
      guard let self, let store, store.stale else { return }
      if let p = self.process, p.isRunning { return } // ours is alive (and still starting)
      let now = Date()
      self.restarts = self.restarts.filter { now.timeIntervalSince($0) < 600 }
      guard self.restarts.count < 3 else { return }
      self.restarts.append(now)
      if let p = self.process { NSLog("leanlamp: engine exited (status \(p.terminationStatus)) — restarting") }
      else { NSLog("leanlamp: no engine is writing the state file — starting one") }
      self.process = nil
      self.startIfNeeded(store: store)
    }
    RunLoop.main.add(t, forMode: .common)
    watchdog = t
  }

  func stop() {
    watchdog?.invalidate()
    guard let p = process, p.isRunning else { return }
    p.terminate()
    process = nil
  }
}
