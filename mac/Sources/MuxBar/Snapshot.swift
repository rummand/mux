import AppKit
import SwiftUI

/// `MuxBar --snapshot out.png [--tab agent|machines|attention] [--connection name] [--ask question] [--wait seconds]`: draw the panel as it opens from the
/// menu bar, after a first look at mux, into a PNG — to check the panel without a screen to look at.
@MainActor
enum Snapshot {
  static func runIfAsked() {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count else { return }
    let out = URL(fileURLWithPath: args[i + 1])
    let tab = args.firstIndex(of: "--tab").flatMap { $0 + 1 < args.count ? PanelView.Tab(rawValue: args[$0 + 1].capitalized) : nil } ?? .agent
    let wait = args.firstIndex(of: "--wait").flatMap { $0 + 1 < args.count ? Double(args[$0 + 1]) : nil } ?? 4
    Task { @MainActor in
      let monitor = Monitor(), agent = Agent()
      if let j = args.firstIndex(of: "--connection"), j + 1 < args.count, let c = monitor.connections.first(where: { $0.name == args[j + 1] }) { monitor.select(c) }
      let host = NSHostingView(rootView: PanelView(monitor: monitor, agent: agent, initialTab: tab).background(Color(nsColor: .windowBackgroundColor)))
      let window = NSWindow(contentRect: NSRect(x: -4000, y: 0, width: 420, height: 640), styleMask: [.borderless], backing: .buffered, defer: false)
      window.contentView = host
      window.orderFrontRegardless()
      try? await Task.sleep(for: .seconds(wait))
      if let j = args.firstIndex(of: "--ask"), j + 1 < args.count {
        agent.reset()
        agent.send(args[j + 1], via: monitor.api, open: { _ in })
        for _ in 0..<300 where agent.busy { try? await Task.sleep(for: .seconds(1)) }
      }
      host.layoutSubtreeIfNeeded()
      let size = host.fittingSize
      window.setContentSize(size); host.frame = NSRect(origin: .zero, size: size)
      try? await Task.sleep(for: .milliseconds(300))
      guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { exit(1) }
      host.cacheDisplay(in: host.bounds, to: rep)
      try? rep.representation(using: .png, properties: [:])?.write(to: out)
      exit(0)
    }
  }
}
