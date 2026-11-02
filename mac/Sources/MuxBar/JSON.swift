import Foundation

/// Any JSON value: the assistant's transcript goes back to mux exactly as mux sent it.
enum JSON: Codable, Equatable, Sendable {
  case null, bool(Bool), number(Double), string(String), array([JSON]), object([String: JSON])

  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() { self = .null }
    else if let b = try? c.decode(Bool.self) { self = .bool(b) }
    else if let n = try? c.decode(Double.self) { self = .number(n) }
    else if let s = try? c.decode(String.self) { self = .string(s) }
    else if let a = try? c.decode([JSON].self) { self = .array(a) }
    else { self = .object(try c.decode([String: JSON].self)) }
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .bool(let b): try c.encode(b)
    case .number(let n): try c.encode(n)
    case .string(let s): try c.encode(s)
    case .array(let a): try c.encode(a)
    case .object(let o): try c.encode(o)
    }
  }

  subscript(key: String) -> JSON? { if case .object(let o) = self { return o[key] }; return nil }
  var string: String? { if case .string(let s) = self { return s }; return nil }
  var array: [JSON]? { if case .array(let a) = self { return a }; return nil }
  var object: [String: JSON]? { if case .object(let o) = self { return o }; return nil }

  /// This object with `key` set.
  func with(_ key: String, _ value: JSON) -> JSON {
    guard case .object(var o) = self else { return self }
    o[key] = value
    return .object(o)
  }

  static func parse(_ s: String) -> JSON? { try? JSONDecoder().decode(JSON.self, from: Data(s.utf8)) }
  var text: String { (try? String(data: JSONEncoder().encode(self), encoding: .utf8)) ?? "null" }
}
