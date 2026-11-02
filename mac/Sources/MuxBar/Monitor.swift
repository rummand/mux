import Foundation
import Observation
import UserNotifications

/// Watches one mux: the machine, its models, traffic, incidents, Lens and — on a gateway — its nodes.
@Observable @MainActor
final class Monitor {
  enum Health { case offline, bad, warn, busy, ok }

  var connections: [Connection] = Connections.all()
  var current: Connection?
  var system: SystemInfo?
  var totals: Overview.Totals?
  var incidents: [Incident] = []
  var lens: LensRun?
  var nodes: [Provider] = []
  var error: String?
  var updated: Date?
  var panelOpen = false

  private var seen: Set<String>? // incident ids and Lens finding keys already told about; nil until the first look
  private var loop: Task<Void, Never>?
  private var report: Task<Void, Never>?

  /// Every 5 s, to this Mac's own mux (whichever mux the panel shows): a fullscreen app, a call — what the node cannot see.
  func reportSignals() async {
    guard let me = connections.first(where: { $0.source == .thisMac }), let token = Connections.token(for: me) else { return }
    let body = JSON.object(["fullscreen": .bool(MacSignals.fullscreen()), "call": .bool(MacSignals.micInUse())])
    try? await API(url: me.url, token: token).send("/presence/signals", body: body)
  }

  init() {
    let pick = UserDefaults.standard.string(forKey: "connection")
    current = connections.first { $0.id == pick } ?? connections.first
    Notifier.setUp()
    loop = Task { [weak self] in
      while !Task.isCancelled {
        await self?.refresh()
        try? await Task.sleep(for: .seconds(self?.panelOpen == true ? 3 : 10))
      }
    }
    report = Task { [weak self] in
      while !Task.isCancelled {
        await self?.reportSignals()
        try? await Task.sleep(for: .seconds(5))
      }
    }
  }

  var api: API? { current.flatMap { c in Connections.token(for: c).map { API(url: c.url, token: $0) } } }
  var isGateway: Bool { system?.role == "gateway" }
  var instances: [SystemInfo.Instance] { system?.instances ?? [] }
  var inflight: Int { Int(instances.reduce(0) { $0 + ($1.inflight ?? 0) }) }
  var pressure: Int { Int(system?.system?.pressure ?? 1) }
  var lensNew: [LensRun.Finding] { (lens?.findings ?? []).filter { $0.status == "new" && ($0.priority == "high" || $0.kind == "needs-attention") } }
  var nodesDown: [Provider] { nodes.filter { $0.enabled && $0.status != "online" } }

  var health: Health {
    if current == nil || (error != nil && system == nil) { return .offline }
    if pressure >= 4 || incidents.contains(where: { $0.severity == "high" }) || !nodesDown.isEmpty { return .bad }
    if pressure >= 2 || !incidents.isEmpty || !lensNew.isEmpty { return .warn }
    if inflight > 0 || instances.contains(where: { $0.state == "loading" }) { return .busy }
    return .ok
  }

  func select(_ c: Connection) {
    current = c
    UserDefaults.standard.set(c.id, forKey: "connection")
    system = nil; totals = nil; incidents = []; lens = nil; nodes = []; error = nil; seen = nil
    Task { await refresh() }
  }

  func reloadConnections() {
    connections = Connections.all()
    if let c = current, !connections.contains(c) { current = connections.first }
    if current == nil { current = connections.first }
    Task { await refresh() }
  }

  func refresh() async {
    guard let api else { error = current == nil ? "No mux yet: add one." : "No admin token for \(current!.name)."; return }
    do {
      async let sys: SystemInfo = api.get("/system", ["range": "15m"])
      async let ov: Overview = api.get("/overview", ["range": "1h"])
      async let inc: [Incident] = api.get("/incidents", ["status": "open", "limit": "20"])
      async let runs: [LensRun] = api.get("/lens", ["limit": "5"])
      async let prov: [Provider] = api.get("/providers")
      system = try await sys
      totals = try? await ov.totals
      incidents = (try? await inc) ?? []
      lens = (try? await runs)?.first { $0.status == "done" }
      nodes = ((try? await prov) ?? []).filter { $0.kind == "mux" }
      error = nil
      updated = Date()
      tell()
    } catch {
      self.error = error.localizedDescription
    }
  }

  /// A notification for each new incident and each new serious Lens finding; nothing for what was there at the first look.
  private func tell() {
    let now = Set(incidents.map { "incident:\($0.id)" } + lensNew.map { "lens:\(lens?.id ?? ""):\($0.key ?? $0.title)" } + nodesDown.map { "node:\($0.id)" })
    defer { seen = (seen ?? []).union(now) }
    guard let seen else { return }
    for i in incidents where !seen.contains("incident:\(i.id)") { Notifier.post("mux · \(i.severity) incident", i.title) }
    for f in lensNew where !seen.contains("lens:\(lens?.id ?? ""):\(f.key ?? f.title)") { Notifier.post("mux · Lens found something new", f.title) }
    for n in nodesDown where !seen.contains("node:\(n.id)") { Notifier.post("mux · \(n.name) is \(n.status)", n.error ?? "The gateway cannot reach this node.") }
  }

  /// The owner's say: available, only when I'm away, or off; and "I'm using this Mac".
  func setPresence(mode: String? = nil, using: Bool? = nil) async {
    var b: [String: JSON] = [:]
    if let mode { b["mode"] = .string(mode) }
    if let using { b["using"] = .bool(using) }
    do { try await api?.send("/presence", method: "PUT", body: .object(b)); error = nil } catch { self.error = error.localizedDescription }
    await refresh()
  }

  func joinInfo() async -> JoinInfo? { try? await api?.get("/join") }

  /// Join this machine to a gateway; the answer says whether the gateway reached it.
  func join(gatewayUrl: String, gatewayToken: String, nodeUrl: String, name: String) async -> String {
    guard let api else { return "No mux." }
    do {
      var req = api.request("/join", method: "POST", body: try JSONEncoder().encode(JSON.object(["gatewayUrl": .string(gatewayUrl), "gatewayToken": .string(gatewayToken), "nodeUrl": .string(nodeUrl), "name": .string(name)])))
      req.timeoutInterval = 60
      let (data, res) = try await URLSession.shared.data(for: req)
      let j = JSON.parse(String(decoding: data, as: UTF8.self))
      guard (res as? HTTPURLResponse)?.statusCode == 200 else { return j?["error"]?.string ?? "The join failed." }
      let p = j?["provider"]
      return j?["ok"] == .bool(true) ? "✓ Joined as \(p?["id"]?.string ?? "?"): the gateway reaches this Mac" : "Joined, but the gateway says \(p?["status"]?.string ?? "?"): \(p?["error"]?.string ?? "")"
    } catch { return error.localizedDescription }
  }

  func unload(_ id: String) async {
    try? await api?.send("/models/\(id)/unload")
    await refresh()
  }

  func open(_ path: String = "/") {
    guard let c = current, let u = URL(string: c.url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path) else { return }
    NSWorkspaceOpen(u)
  }
}

/// macOS notifications, when the app runs as Mux.app (a bare `swift run` has no bundle to notify from).
@MainActor
enum Notifier {
  static var ok: Bool { Bundle.main.bundleIdentifier != nil && Bundle.main.bundleURL.pathExtension == "app" }
  static func setUp() {
    guard ok else { return }
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
  }
  static func post(_ title: String, _ body: String) {
    guard ok else { return }
    let c = UNMutableNotificationContent()
    c.title = title; c.body = body
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
  }
}
