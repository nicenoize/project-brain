import AppKit

// `leanlamp --render-demo <dir>`: render the ten-second demo offscreen and exit.
if let i = CommandLine.arguments.firstIndex(of: "--render-demo") {
  let dir = CommandLine.arguments.count > i + 1 ? CommandLine.arguments[i + 1] : "demo-frames"
  let status = MainActor.assumeIsolated { DemoRenderer.run(outDir: dir) }
  exit(status)
}

// `leanlamp --render-wall <png>`: the open wall with the demo's sessions, keyboard cursor on row 2.
if let i = CommandLine.arguments.firstIndex(of: "--render-wall") {
  let out = CommandLine.arguments.count > i + 1 ? CommandLine.arguments[i + 1] : "wall.png"
  let status = MainActor.assumeIsolated { DemoRenderer.renderWall(to: out) }
  exit(status)
}

// `leanlamp --render-parked <png>`: the PARKED tab with made-up sessions.
if let i = CommandLine.arguments.firstIndex(of: "--render-parked") {
  let out = CommandLine.arguments.count > i + 1 ? CommandLine.arguments[i + 1] : "parked.png"
  let status = MainActor.assumeIsolated { DemoRenderer.renderParked(to: out) }
  exit(status)
}

if let i = CommandLine.arguments.firstIndex(of: "--render-quiet") {
  let out = CommandLine.arguments.count > i + 1 ? CommandLine.arguments[i + 1] : "quiet.png"
  let status = MainActor.assumeIsolated { DemoRenderer.renderQuiet(to: out) }
  exit(status)
}

// A menu-bar / notch app: no Dock icon, no main window, never steals focus
// from the terminal the agent runs in.
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)

// `kill -TERM` and ^C go through the normal quit path, so the engine we
// started is stopped with us (the engine also watches our pid, belt and braces).
let signals = [SIGTERM, SIGINT].map { sig -> DispatchSourceSignal in
  signal(sig, SIG_IGN)
  let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  source.setEventHandler { NSApp.terminate(nil) }
  source.resume()
  return source
}

app.run()
