// Renders the app icon: the brand mark (eight segments, five lit) on black,
// zero radius. Usage: swift make-icon.swift <out.iconset>
import AppKit

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.iconset"
try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)

let accent = NSColor(srgbRed: 1.0, green: 90.0 / 255, blue: 31.0 / 255, alpha: 1)
let dim = NSColor(srgbRed: 58.0 / 255, green: 58.0 / 255, blue: 58.0 / 255, alpha: 1)

func render(_ px: Int) -> Data? {
  let s = CGFloat(px)
  guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  // macOS icon grid: the tile fills ~80 % of the canvas; transparent margin around it.
  let inset = s * 0.1
  let tile = NSRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
  NSColor.black.setFill()
  tile.fill()
  // eight segments, bottom-aligned, five lit (orange) — the brand's gauge
  let n = 8, lit = 5
  let gap = tile.width * 0.035
  let w = (tile.width * 0.66 - gap * CGFloat(n - 1)) / CGFloat(n)
  let h = tile.height * 0.5
  let x0 = tile.midX - (w * CGFloat(n) + gap * CGFloat(n - 1)) / 2
  let y0 = tile.minY + tile.height * 0.25
  for i in 0..<n {
    (i < lit ? accent : dim).setFill()
    NSRect(x: x0 + CGFloat(i) * (w + gap), y: y0, width: w, height: h).fill()
  }
  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])
}

for base in [16, 32, 128, 256, 512] {
  for scale in [1, 2] {
    let name = scale == 1 ? "icon_\(base)x\(base).png" : "icon_\(base)x\(base)@2x.png"
    if let d = render(base * scale) { try d.write(to: URL(fileURLWithPath: out).appendingPathComponent(name)) }
  }
}
print("iconset → \(out)")
