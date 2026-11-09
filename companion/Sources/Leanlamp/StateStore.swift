import Foundation
import Combine
import LeanlampCore

/// Watches the engine's state file and publishes the decoded state. Polling a
/// small file twice a second costs nothing measurable and needs no FSEvents;
/// `stale` turns true when the engine stopped writing (10 s without a heartbeat).
final class StateStore: ObservableObject {
  @Published private(set) var state: CompanionState?
  @Published private(set) var stale = true
  @Published private(set) var lastError: String?
  /// Set by the launcher: the first pass over the transcripts takes a few seconds.
  @Published var engineStartedAt: Date?

  enum EngineStatus { case live, starting, off }

  /// What the ears say about the engine: live, starting (its first pass is running), or off.
  var engineStatus: EngineStatus {
    if !stale { return state?.engine.starting == true ? .starting : .live }
    if let t = engineStartedAt, Date().timeIntervalSince(t) < 30 { return .starting }
    return .off
  }

  /// The state when the engine is writing it — holds and pending edits are valid even while it starts.
  var fresh: CompanionState? { stale ? nil : state }

  let path: String
  private var timer: Timer?
  private var dirSource: DispatchSourceFileSystemObject?
  private var lastStatus: EngineStatus = .off
  private var lastModified: Date?
  private var lastSize: UInt64 = 0

  /// Same resolution as the engine: BRAIN_COMPANION_STATE, else BRAIN_HOME/companion/state.json, else ~/.project-brain/companion/state.json.
  static func defaultPath(env: [String: String] = ProcessInfo.processInfo.environment) -> String {
    if let p = env["BRAIN_COMPANION_STATE"], !p.isEmpty { return p }
    let home = (env["BRAIN_HOME"].flatMap { $0.isEmpty ? nil : $0 }) ?? (NSHomeDirectory() + "/.project-brain")
    return home + "/companion/state.json"
  }

  init(path: String = StateStore.defaultPath()) {
    self.path = path
  }

  /// The engine replaces state.json by renaming a temp file into the bus
  /// directory; watching the directory makes that visible at once. The timer
  /// is the fallback, and what ages the "stale" verdict.
  func start(interval: TimeInterval = 1.0) {
    stop()
    poll()
    let t = Timer(timeInterval: interval, repeats: true) { [weak self] _ in self?.poll() }
    RunLoop.main.add(t, forMode: .common)
    timer = t
  }

  func stop() {
    timer?.invalidate()
    timer = nil
    dirSource?.cancel()
    dirSource = nil
  }

  private func watchDirectory() {
    guard dirSource == nil else { return }
    let dir = (path as NSString).deletingLastPathComponent
    let fd = open(dir, O_EVTONLY)
    guard fd >= 0 else { return } // not there yet: the next poll tries again
    let src = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .link, .delete], queue: .main)
    src.setEventHandler { [weak self] in
      guard let self else { return }
      if src.data.contains(.delete) { self.dirSource?.cancel(); self.dirSource = nil }
      self.poll()
    }
    src.setCancelHandler { close(fd) }
    src.resume()
    dirSource = src
  }

  /// For the rendered demo: a scripted state, live, no file behind it.
  func injectForDemo(_ s: CompanionState, now: Double) {
    state = s
    stale = false
  }

  func poll() {
    watchDirectory()
    let fm = FileManager.default
    guard let attrs = try? fm.attributesOfItem(atPath: path), let modified = attrs[.modificationDate] as? Date else {
      if state != nil { state = nil }
      if !stale { stale = true }
      return
    }
    let size = (attrs[.size] as? NSNumber)?.uint64Value ?? 0
    if modified != lastModified || size != lastSize {
      lastModified = modified
      lastSize = size
      if let data = fm.contents(atPath: path) {
        do {
          let decoded = try CompanionState.decode(data)
          if decoded != state { state = decoded }
          lastError = nil
        } catch {
          lastError = "\(error)" // a torn write is rewritten within a second; keep the last good state
        }
      }
    }
    let nowStale = state?.isStale() ?? true
    if nowStale != stale { stale = nowStale }
    // engineStatus also depends on time (STARTING turns into ENGINE OFF after 30 s): say so when it flips
    let status = engineStatus
    if status != lastStatus { lastStatus = status; objectWillChange.send() }
  }
}
