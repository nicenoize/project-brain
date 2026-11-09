import Foundation

/// Where `node` is. A Finder or login launch gets a minimal PATH, so the app
/// does not rely on it: LEANLAMP_NODE, else the path the bundler found
/// (Info.plist LeanlampNode), else the usual install places, newest nvm first.
enum NodeLocator {
  static let path: String? = locate()

  static func locate(env: [String: String] = ProcessInfo.processInfo.environment) -> String? {
    let fm = FileManager.default
    let ok = { (p: String) -> Bool in fm.isExecutableFile(atPath: p) }
    if let p = env["LEANLAMP_NODE"], ok(p) { return p }
    if let p = Bundle.main.object(forInfoDictionaryKey: "LeanlampNode") as? String, ok(p) { return p }
    let home = NSHomeDirectory()
    var candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "\(home)/.local/bin/node", "\(home)/.volta/bin/node", "\(home)/.asdf/shims/node", "/usr/bin/node"]
    let nvm = "\(home)/.nvm/versions/node"
    if let versions = try? fm.contentsOfDirectory(atPath: nvm) {
      // newest first, and only versions the engine runs on (package.json: node >= 20)
      let usable = versions.filter { v in Int(v.drop(while: { !$0.isNumber }).prefix(while: { $0.isNumber })).map { $0 >= 20 } ?? false }
      let newest = usable.sorted { $0.compare($1, options: .numeric) == .orderedDescending }
      candidates.insert(contentsOf: newest.map { "\(nvm)/\($0)/bin/node" }, at: 0)
    }
    for dir in (env["PATH"] ?? "").split(separator: ":") { candidates.append("\(dir)/node") }
    return candidates.first(where: ok)
  }

  /// PATH for child processes: node's own directory and the usual tool places first.
  static func childPath(_ inherited: String?) -> String {
    var dirs: [String] = []
    if let p = path { dirs.append((p as NSString).deletingLastPathComponent) }
    dirs += ["/opt/homebrew/bin", "/usr/local/bin", NSHomeDirectory() + "/.local/bin"]
    return (dirs + [inherited ?? "/usr/bin:/bin:/usr/sbin:/sbin"]).joined(separator: ":")
  }

  /// The executable and its arguments to run a node script (node flags before the script).
  static func command(_ script: String, _ args: [String], nodeFlags: [String] = []) -> (URL, [String]) {
    if let p = path { return (URL(fileURLWithPath: p), nodeFlags + [script] + args) }
    return (URL(fileURLWithPath: "/usr/bin/env"), ["node"] + nodeFlags + [script] + args)
  }
}
