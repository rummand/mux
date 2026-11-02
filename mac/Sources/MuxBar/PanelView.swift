import AppKit
import ServiceManagement
import SwiftUI

/// What opens from the menu bar: the agent first, then the machines and what wants attention.
struct PanelView: View {
  @Bindable var monitor: Monitor
  @Bindable var agent: Agent
  @State private var tab: Tab
  @State private var settings = false

  init(monitor: Monitor, agent: Agent, initialTab: Tab = .agent) {
    self.monitor = monitor; self.agent = agent
    _tab = State(initialValue: initialTab)
  }

  enum Tab: String, CaseIterable { case agent = "Agent", machines = "Machines", attention = "Attention" }

  var body: some View {
    VStack(spacing: 0) {
      Header(monitor: monitor, settings: $settings)
      Divider()
      if settings {
        SettingsView(monitor: monitor, done: { settings = false })
      } else {
        Strip(monitor: monitor).padding(.horizontal, 12).padding(.vertical, 10)
        Picker("", selection: $tab) {
          ForEach(Tab.allCases, id: \.self) { t in
            Text(t == .attention && attention > 0 ? "Attention (\(attention))" : t.rawValue).tag(t)
          }
        }
        .pickerStyle(.segmented).labelsHidden().padding(.horizontal, 12).padding(.bottom, 8)
        Divider()
        Group {
          switch tab {
          case .agent: AgentView(monitor: monitor, agent: agent)
          case .machines: MachinesView(monitor: monitor)
          case .attention: AttentionView(monitor: monitor, ask: ask)
          }
        }
        .frame(height: 430)
      }
      Divider()
      Footer(monitor: monitor)
    }
    .frame(width: 420)
    .onAppear { monitor.panelOpen = true; Task { await monitor.refresh() } }
    .onDisappear { monitor.panelOpen = false }
  }

  private var attention: Int { monitor.incidents.count + monitor.lensNew.count + monitor.nodesDown.count }

  private func ask(_ q: String) {
    tab = .agent
    agent.send(q, via: monitor.api, open: { monitor.open($0) })
  }
}

/* ── Header and strip ───────────────────────────────────────────────────────────────────────────────────────── */

struct Header: View {
  @Bindable var monitor: Monitor
  @Binding var settings: Bool
  var body: some View {
    HStack(spacing: 10) {
      MuxMark().frame(width: 26, height: 26)
      VStack(alignment: .leading, spacing: 1) {
        Menu {
          ForEach(monitor.connections) { c in
            Button { monitor.select(c) } label: { Text(c.id == monitor.current?.id ? "✓ \(c.name)" : c.name) }
          }
          Divider()
          Button("Add a mux…") { settings = true }
        } label: {
          Text(monitor.current?.name ?? "No mux").font(.headline)
        }
        .menuStyle(.borderlessButton).fixedSize()
        Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
      }
      Spacer()
      HealthBadge(health: monitor.health)
      Button { monitor.open("/") } label: { Image(systemName: "macwindow") }.buttonStyle(.borderless).help("Open the dashboard")
      Button { settings.toggle() } label: { Image(systemName: settings ? "xmark" : "gearshape") }.buttonStyle(.borderless).help("Muxes and settings")
    }
    .padding(.horizontal, 12).padding(.vertical, 10)
  }
  private var subtitle: String {
    if let e = monitor.error, monitor.system == nil { return e }
    let s = monitor.system
    let role = s?.role == "gateway" ? "gateway" : s?.role == "node" ? "node" : "gateway + models"
    return [s?.name, s?.system?.chip, role, monitor.current?.url.host].compactMap { $0 }.joined(separator: " · ")
  }
}

/// mux's mark: the white M on blue, as on the dashboard and the app icon.
struct MuxMark: View {
  var body: some View {
    RoundedRectangle(cornerRadius: 6).fill(Color(red: 0.165, green: 0.47, blue: 0.84))
      .overlay(
        Canvas { ctx, size in
          let k = size.width / 32
          var p = Path()
          p.move(to: CGPoint(x: 9.5 * k, y: 20.5 * k)); p.addLine(to: CGPoint(x: 9.5 * k, y: 11.5 * k)); p.addLine(to: CGPoint(x: 13.25 * k, y: 16.75 * k))
          p.addLine(to: CGPoint(x: 16 * k, y: 11.5 * k)); p.addLine(to: CGPoint(x: 18.75 * k, y: 16.75 * k)); p.addLine(to: CGPoint(x: 22.5 * k, y: 11.5 * k)); p.addLine(to: CGPoint(x: 22.5 * k, y: 20.5 * k))
          ctx.stroke(p, with: .color(.white), style: StrokeStyle(lineWidth: 2.2 * k, lineCap: .round, lineJoin: .round))
        }
      )
  }
}

struct HealthBadge: View {
  let health: Monitor.Health
  var body: some View {
    HStack(spacing: 4) {
      Circle().fill(color).frame(width: 7, height: 7)
      Text(text).font(.caption).foregroundStyle(.secondary)
    }
  }
  private var color: Color { switch health { case .ok: .green; case .busy: .blue; case .warn: .orange; case .bad, .offline: .red } }
  private var text: String { switch health { case .ok: "healthy"; case .busy: "working"; case .warn: "look"; case .bad: "problem"; case .offline: "offline" } }
}

struct Strip: View {
  let monitor: Monitor
  var body: some View {
    HStack(alignment: .top, spacing: 14) {
      if let b = monitor.system?.budget, !monitor.isGateway {
        Stat(label: "Model memory", value: String(format: "%.0f / %.0f GB", b.usedGb, b.budgetGb)) {
          ProgressView(value: min(b.usedGb, b.budgetGb), total: max(b.budgetGb, 1)).tint(b.usedGb / b.budgetGb > 0.9 ? .red : b.usedGb / b.budgetGb > 0.7 ? .orange : .accentColor)
        }
      } else {
        Stat(label: "Nodes", value: "\(monitor.nodes.filter { $0.status == "online" }.count) / \(monitor.nodes.count) online")
      }
      Stat(label: "Requests 1h", value: fmt(monitor.totals?.requests))
      Stat(label: "Errors", value: monitor.totals.map { "\(fmt($0.errors)) · \(String(format: "%.1f%%", ($0.errorRate ?? 0) * 100))" } ?? "—", bad: (monitor.totals?.errors ?? 0) > 0)
      Stat(label: "Tokens/s", value: monitor.totals?.tpsAvg.map { String(format: "%.0f", $0) } ?? "—")
    }
  }
}

struct Stat<Extra: View>: View {
  let label: String; let value: String; var bad = false
  @ViewBuilder var extra: () -> Extra
  init(label: String, value: String, bad: Bool = false, @ViewBuilder extra: @escaping () -> Extra = { EmptyView() }) { self.label = label; self.value = value; self.bad = bad; self.extra = extra }
  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(label.uppercased()).font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
      Text(value).font(.system(size: 12.5, weight: .medium)).monospacedDigit().foregroundStyle(bad ? .red : .primary).lineLimit(1)
      extra()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

func fmt(_ x: Double?) -> String { x.map { $0 >= 10_000 ? String(format: "%.1fk", $0 / 1000) : String(Int($0)) } ?? "—" }

/* ── Agent ──────────────────────────────────────────────────────────────────────────────────────────────────── */

struct AgentView: View {
  @Bindable var monitor: Monitor
  @Bindable var agent: Agent
  @State private var input = ""
  @FocusState private var focused: Bool

  static let suggestions = ["What is wrong right now?", "What is this machine doing, and is it the right work?", "Free up memory: what can be unloaded?", "How did the last hour go?"]

  var body: some View {
    VStack(spacing: 0) {
      ScrollViewReader { proxy in
        ScrollView {
          VStack(alignment: .leading, spacing: 8) {
            if agent.messages.isEmpty && !agent.busy { empty }
            ForEach(agent.items) { item in row(item) }
            if agent.busy {
              if agent.live.isEmpty {
                HStack(spacing: 6) { ProgressView().controlSize(.small); Text(agent.liveModel.map { "thinking with \($0)" } ?? "working…").font(.caption).foregroundStyle(.secondary) }
              } else { Markdown(text: agent.live) }
            }
            if agent.pending.count > 1 && !agent.busy {
              HStack {
                Button("Approve all \(agent.pending.count)") { agent.answer(true, via: monitor.api, open: { monitor.open($0) }) }.buttonStyle(.borderedProminent)
                Button("Decline all") { agent.answer(false, via: monitor.api, open: { monitor.open($0) }) }
              }.controlSize(.small)
            }
            if let e = agent.error { Text(e).font(.caption).foregroundStyle(.red) }
            Color.clear.frame(height: 1).id("end")
          }
          .padding(12)
        }
        .onChange(of: agent.messages.count) { proxy.scrollTo("end") }
        .onChange(of: agent.live) { proxy.scrollTo("end") }
        .onAppear { proxy.scrollTo("end") }
      }
      Divider()
      HStack(alignment: .bottom, spacing: 6) {
        TextField(agent.pending.isEmpty ? "Ask mux, or tell it what to fix…" : "Or say what to do instead…", text: $input, axis: .vertical)
          .textFieldStyle(.plain).lineLimit(1...4).focused($focused)
          .onSubmit(send)
        if agent.busy { Button("Stop") { agent.stop() }.controlSize(.small) }
        else { Button(action: send) { Image(systemName: "arrow.up.circle.fill").font(.title2) }.buttonStyle(.borderless).disabled(input.trimmingCharacters(in: .whitespaces).isEmpty) }
        Menu { Button("New conversation") { agent.reset() } ; Button("Open in the dashboard") { monitor.open("/") } } label: { Image(systemName: "ellipsis.circle") }
          .menuStyle(.borderlessButton).fixedSize()
      }
      .padding(10)
    }
    .onAppear { focused = true }
  }

  private var empty: some View {
    VStack(alignment: .leading, spacing: 8) {
      Label("The mux agent", systemImage: "sparkles").font(.headline).foregroundStyle(Color.accentColor)
      Text("It reads models, routes, tenants, nodes, requests and logs on its own, remembers what it learns in mux's brain, and asks here before it changes anything.")
        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      ForEach(Self.suggestions, id: \.self) { s in
        Button { input = s; send() } label: { Text(s).frame(maxWidth: .infinity, alignment: .leading) }
          .buttonStyle(.bordered).controlSize(.regular)
      }
    }
  }

  @ViewBuilder private func row(_ item: Agent.Item) -> some View {
    switch item {
    case .user(_, let text, let recalled):
      VStack(alignment: .trailing, spacing: 3) {
        Text(text).padding(.horizontal, 10).padding(.vertical, 6).background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 8)).textSelection(.enabled)
        if !recalled.isEmpty { Text("🧠 " + recalled.joined(separator: " · ")).font(.caption2).foregroundStyle(.secondary).lineLimit(1) }
      }
      .frame(maxWidth: .infinity, alignment: .trailing).padding(.leading, 40)
    case .answer(_, let text):
      Markdown(text: text)
    case .call(let id, let label, let why, let body, let status):
      CallRow(label: label, why: why, body: body, status: status,
              approve: { agent.answer(true, only: agent.pending.count > 1 ? id : nil, via: monitor.api, open: { monitor.open($0) }) },
              decline: { agent.answer(false, only: agent.pending.count > 1 ? id : nil, via: monitor.api, open: { monitor.open($0) }) },
              busy: agent.busy)
    }
  }

  private func send() {
    let t = input
    input = ""
    agent.send(t, via: monitor.api, open: { monitor.open($0) })
  }
}

struct CallRow: View {
  let label: String; let why: String?; let body_: String?; let status: Agent.CallStatus
  let approve: () -> Void; let decline: () -> Void; let busy: Bool
  init(label: String, why: String?, body: String?, status: Agent.CallStatus, approve: @escaping () -> Void, decline: @escaping () -> Void, busy: Bool) {
    self.label = label; self.why = why; self.body_ = body; self.status = status; self.approve = approve; self.decline = decline; self.busy = busy
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(label).font(.system(size: 11, design: .monospaced)).lineLimit(1).truncationMode(.middle)
        Spacer()
        switch status {
        case .running: ProgressView().controlSize(.mini)
        case .done: Image(systemName: "checkmark").foregroundStyle(.green)
        case .failed: Image(systemName: "xmark").foregroundStyle(.red)
        case .declined: Text("declined").font(.caption2).foregroundStyle(.secondary)
        case .waiting: Text("needs approval").font(.caption2).foregroundStyle(.orange)
        case .notRun: Text("not run").font(.caption2).foregroundStyle(.secondary)
        }
      }
      if status == .waiting {
        if let why { Text(why).font(.caption).fixedSize(horizontal: false, vertical: true) }
        if let b = body_ { Text(b).font(.system(size: 10, design: .monospaced)).lineLimit(6).foregroundStyle(.secondary) }
        HStack { Button("Approve", action: approve).buttonStyle(.borderedProminent); Button("Decline", action: decline) }.controlSize(.small).disabled(busy)
      }
    }
    .padding(.horizontal, 8).padding(.vertical, 5)
    .background(RoundedRectangle(cornerRadius: 6).fill(status == .waiting ? Color.orange.opacity(0.08) : Color.primary.opacity(0.04)))
    .overlay(RoundedRectangle(cornerRadius: 6).stroke(status == .waiting ? Color.orange.opacity(0.6) : Color.primary.opacity(0.1)))
  }
}

/// Answers are Markdown: inline styles per line, headings bold, list markers kept.
struct Markdown: View {
  let text: String
  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      ForEach(Array(text.split(separator: "\n", omittingEmptySubsequences: true).enumerated()), id: \.offset) { _, line in
        let s = String(line)
        let heading = s.hasPrefix("#")
        let clean = heading ? s.drop(while: { $0 == "#" || $0 == " " }).description : s
        Text((try? AttributedString(markdown: clean, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(clean))
          .font(heading ? .system(size: 12.5, weight: .semibold) : .system(size: 12.5))
          .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/* ── Machines ───────────────────────────────────────────────────────────────────────────────────────────────── */

struct MachinesView: View {
  let monitor: Monitor
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        if let s = monitor.system?.system, !monitor.isGateway {
          Section2(title: monitor.system?.name ?? "This mux") {
            HStack(spacing: 14) {
              Stat(label: "Memory", value: String(format: "%.0f / %.0f GB", s.memUsedGb ?? 0, s.memTotalGb ?? 0))
              Stat(label: "Pressure", value: ["", "normal", "warn", "", "critical"][min(Int(s.pressure ?? 1), 4)], bad: (s.pressure ?? 1) >= 2)
              Stat(label: "Swap", value: String(format: "%.1f GB", s.swapGb ?? 0))
              Stat(label: "Load", value: String(format: "%.1f / %.0f", s.load1 ?? 0, s.cores ?? 0))
            }
            if monitor.instances.isEmpty { Text("No models loaded.").font(.caption).foregroundStyle(.secondary) }
            ForEach(monitor.instances) { i in ModelRow(i: i, unload: i.state == "ready" ? { Task { await monitor.unload(i.id) } } : nil) }
          }
        }
        if !monitor.nodes.isEmpty || monitor.isGateway {
          Section2(title: "Nodes") {
            if monitor.nodes.isEmpty { Text("No mux nodes have joined this gateway yet.").font(.caption).foregroundStyle(.secondary) }
            ForEach(monitor.nodes) { n in NodeRow(n: n) }
          }
        }
      }
      .padding(12)
    }
  }
}

struct Section2<Content: View>: View {
  let title: String
  @ViewBuilder var content: () -> Content
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title.uppercased()).font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
      content()
    }
  }
}

struct ModelRow: View {
  let i: SystemInfo.Instance
  var unload: (() -> Void)?
  var body: some View {
    HStack(spacing: 8) {
      Circle().fill(i.state == "ready" ? Color.green : i.state == "loading" ? .blue : i.state == "failed" ? .red : .gray).frame(width: 7, height: 7)
      VStack(alignment: .leading, spacing: 1) {
        Text(i.id).font(.system(size: 12, weight: .medium)).lineLimit(1)
        Text(detail).font(.caption2).foregroundStyle(.secondary).monospacedDigit()
      }
      Spacer()
      if let unload { Button("Unload", action: unload).controlSize(.small).help("Unload \(i.id) to free its memory; mux loads it again when it is asked for") }
    }
  }
  private var detail: String {
    var parts = [i.state]
    if let g = i.estimateGb { parts.append(String(format: "%.1f GB", g)) }
    if let n = i.inflight, n > 0 { parts.append("\(Int(n)) running") } else if let m = i.idleMin { parts.append("idle \(Int(m)) min") }
    if let r = i.requests { parts.append("\(Int(r)) requests") }
    return parts.joined(separator: " · ")
  }
}

struct NodeRow: View {
  let n: Provider
  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(spacing: 8) {
        Circle().fill(n.status == "online" ? Color.green : n.enabled ? .red : .gray).frame(width: 7, height: 7)
        Text(n.name).font(.system(size: 12, weight: .medium))
        Spacer()
        Text(n.enabled ? n.status : "disabled").font(.caption).foregroundStyle(.secondary)
      }
      if let info = n.info {
        let loaded = (info.instances ?? []).filter { $0.state == "ready" }.map(\.id)
        Text([info.system?.chip, info.system.map { String(format: "%.0f GB free of %.0f", $0.memFreeGb ?? 0, $0.memTotalGb ?? 0) }, info.latencyMs.map { "\(Int($0)) ms" }].compactMap { $0 }.joined(separator: " · "))
          .font(.caption2).foregroundStyle(.secondary)
        Text(loaded.isEmpty ? "nothing loaded" : "loaded: \(loaded.joined(separator: ", "))").font(.caption2).foregroundStyle(.secondary).lineLimit(2)
      } else if let e = n.error { Text(e).font(.caption2).foregroundStyle(.red).lineLimit(2) }
    }
    .padding(8).background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.04)))
  }
}

/* ── Attention ──────────────────────────────────────────────────────────────────────────────────────────────── */

struct AttentionView: View {
  let monitor: Monitor
  let ask: (String) -> Void
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        if monitor.incidents.isEmpty && monitor.lensNew.isEmpty && monitor.nodesDown.isEmpty {
          Label("Nothing needs a look.", systemImage: "checkmark.circle").foregroundStyle(.green)
          if let r = monitor.lens { Text("Lens last looked \(ago(r.ts / 1000)): “\(r.title)”, \(r.findings.count) findings, none new.").font(.caption).foregroundStyle(.secondary) }
        }
        if !monitor.nodesDown.isEmpty {
          Section2(title: "Nodes") {
            ForEach(monitor.nodesDown) { n in
              AskRow(title: "\(n.name) is \(n.status)", detail: n.error, tone: .red) { ask("The node \(n.name) (\(n.id)) is \(n.status). Why, and how do we get it back?") }
            }
          }
        }
        if !monitor.incidents.isEmpty {
          Section2(title: "Incidents") {
            ForEach(monitor.incidents) { i in
              AskRow(title: i.title, detail: "\(i.severity) · \(i.kind) · \(i.status)", tone: i.severity == "high" ? .red : .orange) { ask("Incident \(i.id) is open: “\(i.title)”. What caused it, and fix it.") }
            }
          }
        }
        if let r = monitor.lens, !monitor.lensNew.isEmpty {
          Section2(title: "Lens · \(r.title)") {
            ForEach(monitor.lensNew, id: \.title) { f in
              AskRow(title: f.title, detail: "\(f.priority) · \(f.kind) · new", tone: f.priority == "high" ? .red : .orange) { ask("Lens (investigation \(r.id)) found: “\(f.title)”. Read the finding and its evidence, find the cause and propose the fix.") }
            }
            Button("Open Lens") { monitor.open("/lens") }.controlSize(.small)
          }
        }
      }
      .padding(12)
    }
  }
}

struct AskRow: View {
  let title: String; let detail: String?; let tone: Color; let ask: () -> Void
  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      Circle().fill(tone).frame(width: 7, height: 7).padding(.top, 5)
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
        if let detail { Text(detail).font(.caption2).foregroundStyle(.secondary) }
      }
      Spacer()
      Button("Ask", action: ask).controlSize(.small).help("Ask the agent about it")
    }
  }
}

func ago(_ seconds: Double) -> String {
  let s = Date().timeIntervalSince1970 - seconds
  return s < 90 ? "just now" : s < 5400 ? "\(Int(s / 60)) min ago" : s < 129_600 ? "\(Int(s / 3600)) h ago" : "\(Int(s / 86400)) days ago"
}

/* ── Footer and settings ────────────────────────────────────────────────────────────────────────────────────── */

struct Footer: View {
  let monitor: Monitor
  var body: some View {
    HStack {
      Button("Lens") { monitor.open("/lens") }
      Button("Brain") { monitor.open("/brain") }
      Button("Health") { monitor.open("/health") }
      Spacer()
      if let u = monitor.updated { Text("updated \(Int(Date().timeIntervalSince(u)))s ago").font(.caption2).foregroundStyle(.tertiary) }
      Button("Quit") { NSApp.terminate(nil) }
    }
    .buttonStyle(.borderless).font(.caption).padding(.horizontal, 12).padding(.vertical, 8)
  }
}

struct SettingsView: View {
  @Bindable var monitor: Monitor
  let done: () -> Void
  @State private var name = ""
  @State private var url = ""
  @State private var token = ""
  @State private var message: String?
  @State private var testing = false
  @State private var login = SMAppService.mainApp.status == .enabled

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        Section2(title: "Muxes") {
          ForEach(monitor.connections) { c in
            HStack {
              Image(systemName: c.source == .thisMac ? "desktopcomputer" : c.source == .gateway ? "cloud" : "network")
              VStack(alignment: .leading, spacing: 0) {
                Text(c.name).font(.system(size: 12, weight: .medium))
                Text(c.url.absoluteString + (c.source == .saved ? "" : c.source == .thisMac ? " · from ~/.mux/mux.env" : " · from ~/.mux/railway.env")).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
              }
              Spacer()
              if c.id == monitor.current?.id { Image(systemName: "checkmark").foregroundStyle(.green) } else { Button("Use") { monitor.select(c); done() }.controlSize(.small) }
              if c.source == .saved { Button { Connections.remove(c); monitor.reloadConnections() } label: { Image(systemName: "trash") }.buttonStyle(.borderless) }
            }
          }
        }
        Section2(title: "Add a mux") {
          Text("Another Mac in the house (http://studio.local:7070), over Tailscale (https://name.tailnet.ts.net/mux) or the internet (the gateway's URL). The admin token is MUX_ADMIN_TOKEN in that machine's ~/.mux/mux.env; it is kept in your keychain.")
            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
          TextField("Name, e.g. MacBook Pro", text: $name).textFieldStyle(.roundedBorder)
          TextField("URL", text: $url).textFieldStyle(.roundedBorder)
          SecureField("Admin token", text: $token).textFieldStyle(.roundedBorder)
          HStack {
            Button(testing ? "Checking…" : "Add") { Task { await add() } }.buttonStyle(.borderedProminent).disabled(testing || url.isEmpty || token.isEmpty)
            if let message { Text(message).font(.caption).foregroundStyle(message.hasPrefix("✓") ? .green : .red) }
          }
        }
        Section2(title: "This Mac") {
          Toggle("Open Mux at login", isOn: $login)
            .onChange(of: login) { _, on in
              do { if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() } }
              catch { message = error.localizedDescription; login = SMAppService.mainApp.status == .enabled }
            }
        }
      }
      .padding(12)
    }
    .frame(height: 520)
  }

  private func add() async {
    guard let u = URL(string: url.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "/"))), u.scheme != nil else { message = "That is not a URL."; return }
    testing = true; defer { testing = false }
    do {
      let s: SystemInfo = try await API(url: u, token: token).get("/system", ["range": "15m"])
      let c = Connections.add(name: name.isEmpty ? (s.name ?? u.host ?? "mux") : name, url: u, token: token)
      monitor.reloadConnections(); monitor.select(c)
      message = "✓ \(s.name ?? "mux") (\(s.role ?? "?")) answered"
      name = ""; url = ""; token = ""
    } catch { message = error.localizedDescription }
  }
}
