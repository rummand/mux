import Foundation

/// mux's admin API, as the dashboard calls it.
struct API: Sendable {
  let url: URL
  let token: String

  struct Failure: LocalizedError { let status: Int; let message: String; var errorDescription: String? { status == 401 ? "The admin token was not accepted." : message } }

  func request(_ path: String, method: String = "GET", query: [String: String] = [:], body: Data? = nil) -> URLRequest {
    var c = URLComponents(url: url.appendingPathComponent("api/admin" + path), resolvingAgainstBaseURL: false)!
    if !query.isEmpty { c.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
    var r = URLRequest(url: c.url!, timeoutInterval: 15)
    r.httpMethod = method
    r.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    if let body { r.httpBody = body; r.setValue("application/json", forHTTPHeaderField: "content-type") }
    return r
  }

  func get<T: Decodable>(_ path: String, _ query: [String: String] = [:]) async throws -> T {
    let (data, res) = try await URLSession.shared.data(for: request(path, query: query))
    try check(res, data)
    return try JSONDecoder().decode(T.self, from: data)
  }

  func send(_ path: String, method: String = "POST", body: JSON? = nil) async throws {
    let (data, res) = try await URLSession.shared.data(for: request(path, method: method, body: try body.map { try JSONEncoder().encode($0) }))
    try check(res, data)
  }

  private func check(_ res: URLResponse, _ data: Data) throws {
    let status = (res as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      let msg = JSON.parse(String(decoding: data, as: UTF8.self)).flatMap { $0["error"]?.string ?? $0["error"]?["message"]?.string } ?? "mux answered \(status)"
      throw Failure(status: status, message: msg)
    }
  }
}

/* ── What the menu bar reads (only the fields it shows; all optional, so a newer or older mux still decodes) ── */

struct SystemInfo: Decodable {
  struct Sys: Decodable { var memTotalGb: Double?; var memUsedGb: Double?; var memFreeGb: Double?; var swapGb: Double?; var pressure: Double?; var chip: String?; var load1: Double?; var cores: Double? }
  struct Instance: Decodable, Identifiable { var id: String; var state: String; var backend: String?; var estimateGb: Double?; var inflight: Double?; var requests: Double?; var idleMin: Double? }
  struct Budget: Decodable { var budgetGb: Double; var usedGb: Double }
  var system: Sys?
  var instances: [Instance]?
  var budget: Budget?
  var role: String?
  var name: String?
  var version: String?
  var presence: Presence?
}

/// Whether a machine takes work now (free, polite, busy, away), what its owner set, and why.
struct Presence: Decodable {
  struct Signals: Decodable { var idleS: Double?; var onBattery: Bool?; var batteryPct: Double?; var thermal: String? }
  var state: String; var mode: String; var using: Bool; var `class`: String; var reasons: [String]; var since: Double; var signals: Signals?
}

/// How a gateway could reach this machine, and the gateways that already did.
struct JoinInfo: Decodable {
  struct Way: Decodable, Hashable { var label: String; var url: String; var note: String }
  struct Gateway: Decodable { var id: String; var name: String; var last_used: Double? }
  var role: String; var name: String; var id: String; var ways: [Way]; var gateways: [Gateway]
}

struct Overview: Decodable {
  struct Totals: Decodable { var requests: Double?; var errors: Double?; var errorRate: Double?; var latencyP50: Double?; var tpsAvg: Double?; var costUsd: Double? }
  var totals: Totals
}

struct Incident: Decodable, Identifiable { var id: String; var title: String; var severity: String; var status: String; var kind: String }

struct LensRun: Decodable, Identifiable {
  struct Finding: Decodable { var key: String?; var title: String; var priority: String; var kind: String; var status: String? }
  var id: String; var title: String; var status: String; var ts: Double; var findings: [Finding]
}

/// A provider; for a mux node, what the gateway last saw of the machine.
struct Provider: Decodable, Identifiable {
  struct Info: Decodable { var system: SystemInfo.Sys?; var instances: [SystemInfo.Instance]?; var budget: SystemInfo.Budget?; var latencyMs: Double?; var presence: Presence? }
  var id: String; var name: String; var kind: String; var status: String; var enabled: Bool; var error: String?; var info: Info?
}
