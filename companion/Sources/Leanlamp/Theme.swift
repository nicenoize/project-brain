import AppKit
import CoreText
import SwiftUI

/// Direction D "Flutlicht": black, white, one orange. Zero radius everywhere.
/// Type is the brand's: Doto (dot-matrix numerals), JetBrains Mono (text),
/// Bricolage Grotesque (titles) — bundled, OFL, registered for this process
/// only. If registration fails the system's monospaced face stands in.
enum Theme {
  static let accent = Color(red: 1.0, green: 90.0 / 255, blue: 31.0 / 255)        // #ff5a1f
  static let ink = Color(red: 11.0 / 255, green: 11.0 / 255, blue: 11.0 / 255)     // #0b0b0b
  static let dim = Color(red: 58.0 / 255, green: 58.0 / 255, blue: 58.0 / 255)     // #3a3a3a — empty segments
  static let rule = Color(red: 42.0 / 255, green: 42.0 / 255, blue: 42.0 / 255)    // #2a2a2a — hairlines on black
  static let gray = Color(red: 107.0 / 255, green: 107.0 / 255, blue: 107.0 / 255) // #6b6b6b — idle shapes (not text)
  static let grayText = Color(red: 138.0 / 255, green: 138.0 / 255, blue: 138.0 / 255) // #8a8a8a — small text on black, 6.1:1
  static let muted = Color(red: 184.0 / 255, green: 184.0 / 255, blue: 184.0 / 255) // #b8b8b8 — secondary text on black

  static func number(_ size: CGFloat) -> Font { Fonts.font("Doto", size: size, weight: 900, fallback: .heavy) }
  static func label(_ size: CGFloat = 10) -> Font { Fonts.font("JetBrains Mono", size: size, weight: 700, fallback: .bold) }
  static func body(_ size: CGFloat = 12) -> Font { Fonts.font("JetBrains Mono", size: size, weight: 400, fallback: .regular) }
  static func strong(_ size: CGFloat = 12) -> Font { Fonts.font("JetBrains Mono", size: size, weight: 700, fallback: .bold) }
  static func title(_ size: CGFloat = 20) -> Font { Fonts.font("Bricolage Grotesque", size: size, weight: 800, opticalSize: true, fallback: .heavy, design: .default) }
}

/// System accessibility settings the app follows.
enum Motion {
  /// "Reduce motion": no blinking, no sliding — state changes land in place.
  static var reduced: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
  /// The island's shape: calm for news and folding, a short bounce when something needs you.
  static let shape = Animation.spring(response: 0.38, dampingFraction: 0.86)
  static let urgent = Animation.spring(response: 0.34, dampingFraction: 0.58)
  /// How long the window waits before shrinking to the folded shape (the spring has settled by then).
  static let settle: TimeInterval = 0.5
  /// Room under the shape for the urgent spring's overshoot.
  static let slack: CGFloat = 14
}

enum Fonts {
  private static let wght = NSNumber(value: 0x7767_6874) // 'wght'
  private static let opsz = NSNumber(value: 0x6F70_737A) // 'opsz'
  private(set) static var registered: [String] = []
  static let plainCode: [[NSFontDescriptor.FeatureKey: Int]] = [
    [.typeIdentifier: kContextualAlternatesType, .selectorIdentifier: kContextualAlternatesOffSelector],
    [.typeIdentifier: kLigaturesType, .selectorIdentifier: kCommonLigaturesOffSelector]
  ]
  private static var cache: [String: Font] = [:]

  /// Register the bundled fonts for this process. Safe to call more than once.
  static func register() {
    guard registered.isEmpty else { return }
    // In Leanlamp.app the fonts sit in Contents/Resources/Fonts; from `swift run`
    // they come from SwiftPM's resource bundle (Bundle.module traps if it is
    // missing, so it is only asked when the app bundle has none).
    var urls: [URL] = []
    if let res = Bundle.main.resourceURL?.appendingPathComponent("Fonts"),
       let found = try? FileManager.default.contentsOfDirectory(at: res, includingPropertiesForKeys: nil) {
      urls = found.filter { $0.pathExtension == "ttf" }
    }
    if urls.isEmpty {
      urls = Bundle.module.urls(forResourcesWithExtension: "ttf", subdirectory: "Fonts") ?? []
    }
    for url in urls {
      var error: Unmanaged<CFError>?
      if CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) {
        registered.append(url.deletingPathExtension().lastPathComponent)
      } else if let e = error?.takeRetainedValue() {
        // already registered (a second app instance in the same session) is fine
        NSLog("leanlamp: font \(url.lastPathComponent): \(e)")
      }
    }
  }

  /// A variable font at an exact weight (and optical size), cached.
  static func font(_ family: String, size: CGFloat, weight: CGFloat, opticalSize: Bool = false, fallback: Font.Weight, design: Font.Design = .monospaced) -> Font {
    let key = "\(family)|\(size)|\(weight)|\(opticalSize)"
    if let f = cache[key] { return f }
    var axes: [NSNumber: NSNumber] = [wght: NSNumber(value: Double(weight))]
    if opticalSize { axes[opsz] = NSNumber(value: Double(size)) }
    var attributes: [NSFontDescriptor.AttributeName: Any] = [.family: family, .variation: axes]
    // JetBrains Mono draws "--" as one long dash through contextual alternates:
    // in a command ("-- --watch", "--check") that reads as an em-dash. Off for mono text.
    if family.contains("Mono") { attributes[.featureSettings] = Fonts.plainCode }
    let descriptor = NSFontDescriptor(fontAttributes: attributes)
    let font: Font
    if let ns = NSFont(descriptor: descriptor, size: size), ns.familyName == family {
      font = Font(ns)
    } else {
      font = .system(size: size, weight: fallback, design: design)
    }
    cache[key] = font
    return font
  }
}
