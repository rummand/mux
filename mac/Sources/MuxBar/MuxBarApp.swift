import AppKit
import SwiftUI

@main
struct MuxBarApp: App {
  @State private var monitor = Monitor()
  @State private var agent = Agent()

  init() { Snapshot.runIfAsked() }

  var body: some Scene {
    MenuBarExtra {
      PanelView(monitor: monitor, agent: agent)
    } label: {
      StatusLabel(monitor: monitor, agent: agent)
    }
    .menuBarExtraStyle(.window)
  }
}

/// The M in the menu bar, with a dot for how mux is: none when all is well, blue when it works, purple when the agent
/// thinks, orange when something wants a look, red when something is wrong or mux cannot be reached.
struct StatusLabel: View {
  let monitor: Monitor
  let agent: Agent
  var body: some View {
    HStack(spacing: 3) {
      Image(nsImage: StatusIcon.image(dot: dot))
      if monitor.inflight > 0 { Text("\(monitor.inflight)").monospacedDigit() }
    }
  }
  private var dot: NSColor? {
    if agent.busy { return .systemPurple }
    if !agent.pending.isEmpty { return .systemOrange }
    switch monitor.health {
    case .offline, .bad: return .systemRed
    case .warn: return .systemOrange
    case .busy: return .systemBlue
    case .ok: return nil
    }
  }
}

enum StatusIcon {
  static func image(dot: NSColor?) -> NSImage {
    let img = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { _ in
      // mux's M, drawn in the menu bar's own text colour (it follows light and dark menu bars).
      let m = NSBezierPath()
      m.move(to: NSPoint(x: 3, y: 14)); m.line(to: NSPoint(x: 3, y: 4.5)); m.line(to: NSPoint(x: 7, y: 10))
      m.line(to: NSPoint(x: 9.5, y: 5.5)); m.line(to: NSPoint(x: 12, y: 10)); m.line(to: NSPoint(x: 16, y: 4.5)); m.line(to: NSPoint(x: 16, y: 14))
      m.lineWidth = 1.9; m.lineCapStyle = .round; m.lineJoinStyle = .round
      NSColor.labelColor.setStroke(); m.stroke()
      if let dot {
        NSColor.windowBackgroundColor.setFill(); NSBezierPath(ovalIn: NSRect(x: 11.5, y: 11.5, width: 7, height: 7)).fill()
        dot.setFill(); NSBezierPath(ovalIn: NSRect(x: 12.5, y: 12.5, width: 5, height: 5)).fill()
      }
      return true
    }
    img.isTemplate = dot == nil
    return img
  }
}
