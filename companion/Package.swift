// swift-tools-version:5.9
// The companion app: a notch island and menu-bar glyph for the agents on this
// machine. It reads ONE file the Node engine keeps current
// (`brain:companion --watch`) and never parses a transcript itself.
import PackageDescription

let package = Package(
  name: "Leanlamp",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "leanlamp", targets: ["Leanlamp"]),
    .executable(name: "leanlamp-selftest", targets: ["LeanlampSelfTest"])
  ],
  targets: [
    // Pure: the state contract, the gauge maths, the notch geometry. No AppKit.
    .target(name: "LeanlampCore", path: "Sources/LeanlampCore"),
    // The shell: AppKit panel + SwiftUI views, status item, state file watcher.
    .executableTarget(name: "Leanlamp", dependencies: ["LeanlampCore"], path: "Sources/Leanlamp", resources: [.copy("Resources/Fonts")]),
    // `swift run leanlamp-selftest`: the core checks without Xcode's XCTest.
    .executableTarget(name: "LeanlampSelfTest", dependencies: ["LeanlampCore"], path: "Sources/LeanlampSelfTest"),
    .testTarget(name: "LeanlampCoreTests", dependencies: ["LeanlampCore"], path: "Tests/LeanlampCoreTests")
  ]
)
