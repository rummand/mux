import AppKit
import Foundation
import Observation

/// The mux assistant from the menu bar: the same agent as the dashboard's, over the same streaming API. It reads mux on
/// its own; a change it wants waits here for Approve. Its conversations show in the dashboard's list too.
@Observable @MainActor
final class Agent {
  var messages: [JSON] = []
  var conversation = ""
  var live = ""
  var liveModel: String?
  var busy = false
  var pending: [String] = []
  var error: String?

  private var task: Task<Void, Never>?
  private let defaults = UserDefaults.standard

  init() {
    if let d = defaults.data(forKey: "agent.messages"), let m = try? JSONDecoder().decode([JSON].self, from: d) { messages = m }
    conversation = defaults.string(forKey: "agent.conversation") ?? ""
    pending = Agent.unanswered(messages)
  }

  private func save() {
    defaults.set(try? JSONEncoder().encode(messages), forKey: "agent.messages")
    defaults.set(conversation, forKey: "agent.conversation")
  }

  func reset() { task?.cancel(); messages = []; conversation = ""; pending = []; error = nil; live = ""; save() }
  func stop() { task?.cancel() }

  func send(_ text: String, via api: API?, open: @escaping (String) -> Void) {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty, !busy, let api else { return }
    run(messages + [.object(["role": .string("user"), "content": .string(t)])], api: api, open: open)
  }

  func answer(_ approve: Bool, only: String? = nil, via api: API?, open: @escaping (String) -> Void) {
    guard let api else { return }
    let approvals = Dictionary(uniqueKeysWithValues: pending.map { id in (id, JSON.bool(only.map { $0 == id && approve } ?? approve)) })
    run(messages, approvals: approvals, api: api, open: open)
  }

  private func run(_ msgs: [JSON], approvals: [String: JSON]? = nil, api: API, open: @escaping (String) -> Void) {
    task?.cancel()
    busy = true; error = nil; pending = []; live = ""; liveModel = nil
    messages = msgs
    save()
    task = Task { [weak self] in
      guard let self else { return }
      var shown = msgs
      var text = "", calls: [JSON] = []
      func flush() {
        guard !text.isEmpty || !calls.isEmpty else { return }
        var m: [String: JSON] = ["role": .string("assistant"), "content": text.isEmpty ? .null : .string(text)]
        if !calls.isEmpty { m["tool_calls"] = .array(calls) }
        shown.append(.object(m)); text = ""; calls = []
      }
      do {
        var body: [String: JSON] = ["messages": .array(msgs), "page": .string("the menu bar")]
        if !conversation.isEmpty { body["conversation"] = .string(conversation) }
        if let approvals { body["approvals"] = .object(approvals) }
        var req = api.request("/assistant", method: "POST", body: try JSONEncoder().encode(JSON.object(body)))
        req.timeoutInterval = 900
        let (bytes, res) = try await URLSession.shared.bytes(for: req)
        guard (res as? HTTPURLResponse)?.statusCode == 200 else { throw API.Failure(status: (res as? HTTPURLResponse)?.statusCode ?? 0, message: "mux did not start") }
        var event = ""
        for try await line in bytes.lines {
          if line.hasPrefix("event: ") { event = String(line.dropFirst(7)); continue }
          guard line.hasPrefix("data: "), let d = JSON.parse(String(line.dropFirst(6))) else { continue }
          switch event {
          case "delta": text += d["text"]?.string ?? ""; live = text
          case "meta": liveModel = d["model"]?.string
          case "call":
            calls.append(.object(["id": d["id"] ?? .null, "type": .string("function"),
              "function": .object(["name": d["name"] ?? .null, "arguments": .string((d["args"] ?? .object([:])).text)])]))
          case "result":
            flush()
            shown.append(.object(["role": .string("tool"), "tool_call_id": d["id"] ?? .null, "content": d["content"] ?? .null]))
            messages = shown; live = ""
          case "recall":
            if let i = shown.lastIndex(where: { $0["role"]?.string == "user" }) { shown[i] = shown[i].with("recalled", d["pages"] ?? .array([])); messages = shown }
          case "pending": pending = (d["ids"]?.array ?? []).compactMap(\.string)
          case "navigate": if let p = d["path"]?.string { open(p) }
          case "error": error = d["message"]?.string
          case "messages":
            messages = d["messages"]?.array ?? shown
            if let c = d["conversation"]?.string { conversation = c }
          default: break
          }
        }
      } catch {
        if !Task.isCancelled { self.error = error.localizedDescription }
      }
      if Task.isCancelled { flush(); messages = shown }
      busy = false; live = ""
      save()
    }
  }

  /* ── Reading the transcript ───────────────────────────────────────────────────────────────────────────────── */

  enum Item: Identifiable {
    case user(id: Int, text: String, recalled: [String])
    case answer(id: Int, text: String)
    case call(id: String, label: String, why: String?, body: String?, status: CallStatus)
    var id: String {
      switch self { case .user(let i, _, _): return "u\(i)"; case .answer(let i, _): return "a\(i)"; case .call(let i, _, _, _, _): return i }
    }
  }
  enum CallStatus { case running, done, failed, declined, waiting, notRun }

  var items: [Item] {
    var results: [String: String] = [:]
    for m in messages where m["role"]?.string == "tool" { if let id = m["tool_call_id"]?.string { results[id] = m["content"]?.string ?? "" } }
    var out: [Item] = []
    for (i, m) in messages.enumerated() {
      switch m["role"]?.string {
      case "user": out.append(.user(id: i, text: m["content"]?.string ?? "", recalled: (m["recalled"]?.array ?? []).compactMap { $0["title"]?.string }))
      case "assistant":
        if let t = m["content"]?.string, !t.isEmpty { out.append(.answer(id: i, text: t)) }
        for c in m["tool_calls"]?.array ?? [] {
          let id = c["id"]?.string ?? UUID().uuidString
          let a = JSON.parse(c["function"]?["arguments"]?.string ?? "{}") ?? .object([:])
          out.append(.call(id: id, label: Agent.label(c["function"]?["name"]?.string ?? "", a), why: a["why"]?.string, body: a["body"].map { $0.text }, status: status(id, results[id])))
        }
      default: break
      }
    }
    return out
  }

  private func status(_ id: String, _ result: String?) -> CallStatus {
    guard let r = result else { return pending.contains(id) ? .waiting : busy ? .running : .notRun }
    let j = JSON.parse(r)
    if let e = j?["error"]?.string, e == "the user declined this change" || e.hasPrefix("not run") { return .declined }
    if j?["error"] != nil { return .failed }
    if case .number(let s)? = j?["status"], s >= 400 { return .failed }
    return .done
  }

  static func label(_ name: String, _ a: JSON) -> String {
    switch name {
    case "mux_api": return "\((a["method"]?.string ?? "GET").uppercased()) \(a["path"]?.string ?? "")"
    case "read_log": return "log \(a["source"]?.string == "model" ? a["model"]?.string ?? "" : "mux")\(a["grep"]?.string.map { " | grep \($0)" } ?? "")"
    case "test_request": return "test \(a["model"]?.string ?? "auto"): “\((a["prompt"]?.string ?? "").prefix(40))”"
    case "open_page": return "open \(a["path"]?.string ?? "")"
    case "brain_search": return "recall “\(a["query"]?.string ?? "")”"
    case "brain_write": return "remember “\(a["title"]?.string ?? "")”"
    case "brain_forget": return "forget \(a["id"]?.string ?? "")"
    default: return name
    }
  }

  /// The changes a transcript ended on that nobody has answered yet (after a restart, say).
  static func unanswered(_ msgs: [JSON]) -> [String] {
    guard let last = msgs.last(where: { $0["role"]?.string != "tool" }), last["role"]?.string == "assistant" else { return [] }
    let done = Set(msgs.compactMap { $0["role"]?.string == "tool" ? $0["tool_call_id"]?.string : nil })
    return (last["tool_calls"]?.array ?? []).filter { c in
      let name = c["function"]?["name"]?.string ?? ""
      let a = JSON.parse(c["function"]?["arguments"]?.string ?? "{}")
      let change = name == "brain_forget" || (name == "mux_api" && (a?["method"]?.string ?? "GET").uppercased() != "GET"
        && !(a?["path"]?.string ?? "").contains("/routes/explain") && !(a?["path"]?.string ?? "").hasPrefix("/lens"))
      return change && !done.contains(c["id"]?.string ?? "")
    }.compactMap { $0["id"]?.string }
  }
}

@MainActor func NSWorkspaceOpen(_ url: URL) { NSWorkspace.shared.open(url) }
