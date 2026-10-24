import XCTest
@testable import LeanlampCore

final class GaugeTests: XCTestCase {
  func testFilledSegments() {
    XCTAssertEqual(Gauge.filled(fraction: 0), 0)
    XCTAssertEqual(Gauge.filled(fraction: 0.01), 1)
    XCTAssertEqual(Gauge.filled(fraction: 0.655), 5)
    XCTAssertEqual(Gauge.filled(fraction: 1), 8)
    XCTAssertEqual(Gauge.filled(fraction: 3), 8)
  }

  func testHot() {
    XCTAssertFalse(Gauge.isHot(fraction: 0.5))
    XCTAssertTrue(Gauge.isHot(fraction: 0.75))
    XCTAssertTrue(Gauge.isHot(fraction: 0.1, needsYou: true))
  }

  func testK() {
    XCTAssertEqual(Gauge.k(211_400), "211k")
    XCTAssertEqual(Gauge.k(1_234_000), "1.2M")
    XCTAssertEqual(Gauge.k(1_000_000), "1M")
    XCTAssertEqual(Gauge.k(0), "0k")
  }
}

final class NotchLayoutTests: XCTestCase {
  // The 14-inch MacBook Pro at 1512 × 982 pt, as NSScreen reports it.
  let screen = CGRect(x: 0, y: 0, width: 1512, height: 982)
  let visible = CGRect(x: 0, y: 0, width: 1512, height: 982 - 38)
  let left = CGRect(x: 0, y: 950, width: 663, height: 32)
  let right = CGRect(x: 848, y: 950, width: 664, height: 32)

  func testGeometryFromScreen() throws {
    let l = try XCTUnwrap(NotchLayout.make(screenFrame: screen, visibleFrame: visible, auxiliaryTopLeft: left, auxiliaryTopRight: right))
    XCTAssertEqual(l.notch, CGRect(x: 663, y: 950, width: 185, height: 32))
    XCTAssertEqual(l.menuBarHeight, 38)
    XCTAssertEqual(l.islandFrame, CGRect(x: 755.5 - 232.5, y: 982 - 38, width: 465, height: 38))
    XCTAssertEqual(l.panelFrame(contentHeight: 300), CGRect(x: 755.5 - 320, y: 982 - 338, width: 640, height: 338))
    XCTAssertEqual(l.panelEarWidth, 227.5)
    XCTAssertEqual(l.hotZone, CGRect(x: 663, y: 944, width: 185, height: 38))
  }

  func testNoNotch() {
    XCTAssertNil(NotchLayout.make(screenFrame: screen, visibleFrame: visible, auxiliaryTopLeft: nil, auxiliaryTopRight: nil))
  }

  func testHiddenMenuBarStillCoversTheNotch() throws {
    let l = try XCTUnwrap(NotchLayout.make(screenFrame: screen, visibleFrame: screen, auxiliaryTopLeft: left, auxiliaryTopRight: right))
    XCTAssertEqual(l.menuBarHeight, 37)
  }

  func testSystemMenuBarHeightWinsWhenItCoversTheNotch() throws {
    let l = try XCTUnwrap(NotchLayout.make(screenFrame: screen, visibleFrame: visible, auxiliaryTopLeft: left, auxiliaryTopRight: right, menuBarHeight: 37))
    XCTAssertEqual(l.menuBarHeight, 37)
    // a figure from a screen without a notch (24 pt) cannot be right here
    let m = try XCTUnwrap(NotchLayout.make(screenFrame: screen, visibleFrame: visible, auxiliaryTopLeft: left, auxiliaryTopRight: right, menuBarHeight: 24))
    XCTAssertEqual(m.menuBarHeight, 38)
  }
}

final class StateTests: XCTestCase {
  func testDecodeAndDerive() throws {
    let json = """
    {"v":1,"at":"2026-10-22T10:00:00.000Z","atMs":1792656000000,"engine":{"pid":1,"intervalMs":1000,"roots":["/r"]},
     "machine":{"totalGb":24,"freePct":23,"pressure":"warn","swapUsedGb":1.2,"agentProcesses":3,"agentRssGb":1.1,"orphans":0},
     "sessions":[
      {"id":"a","title":"Billing","project":"shop-app","cwd":"/c","gitBranch":"main","model":"claude-fable-5-1","ctx":196400,"limit":300000,"limitSource":"settings","ratio":0.655,"burnPerMin":250,"requests":10,"outputTokens":5,"compactions":2,"lastCompaction":null,"state":"tool","label":"Bash · npm test","last":{"kind":"tool_use","tool":{"name":"Bash","text":"npm test"},"text":"","atMs":1792655990000},"lastActivityMs":1792655990000,"startedMs":1,"pid":42,"rssMb":200,"transcript":"/t/a.jsonl"},
      {"id":"b","title":"Old","project":null,"cwd":null,"gitBranch":null,"model":null,"ctx":500000,"limit":1000000,"limitSource":"model","ratio":0.5,"burnPerMin":0,"requests":0,"outputTokens":0,"compactions":0,"lastCompaction":null,"state":"idle","label":"idle for 3 h","last":{"kind":null,"tool":null,"text":"","atMs":null},"lastActivityMs":null,"startedMs":null,"pid":null,"rssMb":null,"transcript":null}
     ]}
    """
    let s = try CompanionState.decode(Data(json.utf8))
    XCTAssertEqual(s.sessions.count, 2)
    XCTAssertEqual(s.live.map(\.id), ["a"])
    XCTAssertEqual(s.busiest?.title, "Billing")
    XCTAssertEqual(s.sessions[0].fraction, 196400.0 / 300000.0, accuracy: 0.0001)
    XCTAssertEqual(s.sessions[1].id, "b")
    XCTAssertTrue(s.isStale(now: Date(timeIntervalSince1970: 1792656020)))
    XCTAssertFalse(s.isStale(now: Date(timeIntervalSince1970: 1792656005)))
  }
}
