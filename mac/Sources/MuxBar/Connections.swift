import Foundation
import Security

/// A mux to watch: the one on this Mac, the gateway, or any other — in the house, over Tailscale or the internet.
struct Connection: Codable, Identifiable, Hashable, Sendable {
  enum Source: String, Codable, Sendable { case thisMac, gateway, saved }
  var name: String
  var url: URL
  var source: Source
  var id: String { url.absoluteString }
}

enum Connections {
  static var home: String { ProcessInfo.processInfo.environment["MUX_HOME"] ?? NSHomeDirectory() + "/.mux" }

  /// KEY=value lines, as install.sh writes ~/.mux/mux.env and ~/.mux/railway.env.
  static func envFile(_ name: String) -> [String: String] {
    guard let text = try? String(contentsOfFile: "\(home)/\(name)", encoding: .utf8) else { return [:] }
    var env: [String: String] = [:]
    for raw in text.split(separator: "\n") {
      let line = raw.trimmingCharacters(in: .whitespaces)
      guard !line.hasPrefix("#"), let eq = line.firstIndex(of: "=") else { continue }
      env[String(line[..<eq]).replacingOccurrences(of: "export ", with: "")] = String(line[line.index(after: eq)...]).trimmingCharacters(in: CharacterSet(charactersIn: "\"' "))
    }
    return env
  }

  /// Every mux this Mac knows of: its own (mux.env), its gateway (railway.env), and the ones added by hand.
  static func all() -> [Connection] {
    var out: [Connection] = []
    let local = envFile("mux.env")
    if local["MUX_ADMIN_TOKEN"] != nil, let u = URL(string: "http://127.0.0.1:\(local["MUX_PORT"] ?? "7070")") {
      out.append(Connection(name: "This Mac", url: u, source: .thisMac))
    }
    let gw = envFile("railway.env")
    if gw["MUX_GATEWAY_ADMIN_TOKEN"] != nil, let s = gw["MUX_GATEWAY_URL"], let u = URL(string: s) {
      out.append(Connection(name: "Gateway", url: u, source: .gateway))
    }
    for c in saved() where !out.contains(where: { $0.id == c.id }) { out.append(c) }
    return out
  }

  static func token(for c: Connection) -> String? {
    switch c.source {
    case .thisMac: return envFile("mux.env")["MUX_ADMIN_TOKEN"]
    case .gateway: return envFile("railway.env")["MUX_GATEWAY_ADMIN_TOKEN"]
    case .saved: return Keychain.get(c.id)
    }
  }

  static func saved() -> [Connection] {
    guard let d = UserDefaults.standard.data(forKey: "connections") else { return [] }
    return (try? JSONDecoder().decode([Connection].self, from: d)) ?? []
  }

  static func add(name: String, url: URL, token: String) -> Connection {
    let c = Connection(name: name, url: url, source: .saved)
    Keychain.set(c.id, token)
    let list = saved().filter { $0.id != c.id } + [c]
    UserDefaults.standard.set(try? JSONEncoder().encode(list), forKey: "connections")
    return c
  }

  static func remove(_ c: Connection) {
    Keychain.delete(c.id)
    UserDefaults.standard.set(try? JSONEncoder().encode(saved().filter { $0.id != c.id }), forKey: "connections")
  }
}

/// Admin tokens of the muxes added by hand live in the login keychain, not in preferences.
enum Keychain {
  private static func query(_ account: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.mux.menubar", kSecAttrAccount as String: account]
  }
  static func get(_ account: String) -> String? {
    var q = query(account)
    q[kSecReturnData as String] = true
    var out: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
    return String(data: d, encoding: .utf8)
  }
  static func set(_ account: String, _ value: String) {
    delete(account)
    var q = query(account)
    q[kSecValueData as String] = Data(value.utf8)
    SecItemAdd(q as CFDictionary, nil)
  }
  static func delete(_ account: String) { SecItemDelete(query(account) as CFDictionary) }
}
