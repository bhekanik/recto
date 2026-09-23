@preconcurrency import ConvexMobile
import Foundation

/// A JSON value the app can hand across actors. The SDK's `ConvexEncodable` is
/// not `Sendable`, which is why the typed transport methods build their
/// arguments inside the actor; this carries the same information to the generic
/// calls and is converted there.
public enum ConvexValue: Sendable, Equatable {
  case null
  case bool(Bool)
  /// Always a float on the wire: `v.number()` rejects Convex's `$integer`.
  case number(Double)
  case string(String)
  case array([ConvexValue])
  case object([String: ConvexValue])

  var encodable: ConvexEncodable? {
    switch self {
    case .null: nil
    case .bool(let value): value
    case .number(let value): value
    case .string(let value): value
    case .array(let values): values.map(\.encodable) as [ConvexEncodable?]
    case .object(let fields): fields.mapValues(\.encodable) as [String: ConvexEncodable?]
    }
  }

  /// Function arguments from optional fields. A `nil` drops the key: Convex's
  /// `v.optional()` means absent, and sending null fails validation.
  public static func arguments(_ fields: [String: ConvexValue?]) -> [String: ConvexValue] {
    fields.compactMapValues { $0 }
  }
}

extension ConvexValue: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral,
  ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral, ExpressibleByArrayLiteral,
  ExpressibleByDictionaryLiteral, ExpressibleByNilLiteral
{
  public init(stringLiteral value: String) { self = .string(value) }
  public init(booleanLiteral value: Bool) { self = .bool(value) }
  public init(integerLiteral value: Int) { self = .number(Double(value)) }
  public init(floatLiteral value: Double) { self = .number(value) }
  public init(arrayLiteral elements: ConvexValue...) { self = .array(elements) }
  public init(dictionaryLiteral elements: (String, ConvexValue)...) {
    self = .object(Dictionary(elements, uniquingKeysWith: { _, last in last }))
  }
  public init(nilLiteral: ()) { self = .null }
}

/// A `ConvexError` thrown by a function, whatever its code. `ServerRefusal`
/// covers the sync engine's retry policy; features need every code the server
/// uses (AI consent, sharing, rate limits) to tell the writer what happened.
public struct RemoteCallError: Error, Equatable, Sendable, LocalizedError {
  public var code: String?
  public var message: String

  public init(code: String?, message: String) {
    self.code = code
    self.message = message
  }

  public init?(convexErrorData data: String) {
    guard let parsed = try? JSONSerialization.jsonObject(
      with: Data(data.utf8), options: .fragmentsAllowed)
    else { return nil }
    if let text = parsed as? String {
      self.init(code: nil, message: text)
      return
    }
    guard let object = parsed as? [String: Any] else { return nil }
    let code = object["code"] as? String
    self.init(code: code, message: (object["message"] as? String) ?? code ?? data)
  }

  public var errorDescription: String? { message }
}

/// Queries, subscriptions, mutations and actions by function name, for the
/// app's features. A protocol so views can be tested against a fake.
public protocol RectoAPI: Actor {
  func query<T: Decodable & Sendable>(_ name: String, args: [String: ConvexValue]) async throws -> T
  func subscribe<T: Decodable & Sendable>(_ name: String, args: [String: ConvexValue])
    -> AsyncThrowingStream<T, any Error>
  func mutation<T: Decodable & Sendable>(_ name: String, args: [String: ConvexValue]) async throws -> T
  func action<T: Decodable & Sendable>(_ name: String, args: [String: ConvexValue]) async throws -> T
}

/// A function result the caller does not read (Convex `null`).
public struct ConvexVoid: Decodable, Sendable, Equatable {
  public init() {}
  public init(from decoder: any Decoder) throws {}
}

extension ConvexTransport: RectoAPI {
  public func query<T: Decodable & Sendable>(_ name: String, args: [String: ConvexValue])
    async throws -> T
  {
    for try await value in subscribe(name, args: args) as AsyncThrowingStream<T, any Error> {
      return value
    }
    throw RemoteCallError(code: nil, message: "\(name) returned no value.")
  }

  public func subscribe<T: Decodable & Sendable>(_ name: String, args: [String: ConvexValue])
    -> AsyncThrowingStream<T, any Error>
  {
    let publisher = client.subscribe(to: name, with: Self.encode(args), yielding: T.self)
    return AsyncThrowingStream { continuation in
      let subscription = CancellationBox(
        publisher.sink(
          receiveCompletion: { completion in
            switch completion {
            case .finished: continuation.finish()
            case .failure(let error): continuation.finish(throwing: Self.remote(error))
            }
          },
          receiveValue: { continuation.yield($0) }))
      continuation.onTermination = { _ in subscription.cancel() }
    }
  }

  public func mutation<T: Decodable & Sendable>(_ name: String, args: [String: ConvexValue])
    async throws -> T
  {
    do {
      if T.self == ConvexVoid.self {
        try await client.mutation(name, with: Self.encode(args))
        return ConvexVoid() as! T
      }
      return try await client.mutation(name, with: Self.encode(args))
    } catch {
      throw Self.remote(error)
    }
  }

  public func action<T: Decodable & Sendable>(_ name: String, args: [String: ConvexValue])
    async throws -> T
  {
    do {
      if T.self == ConvexVoid.self {
        try await client.action(name, with: Self.encode(args))
        return ConvexVoid() as! T
      }
      return try await client.action(name, with: Self.encode(args))
    } catch {
      throw Self.remote(error)
    }
  }

  private nonisolated static func encode(_ args: [String: ConvexValue]) -> [String: ConvexEncodable?] {
    args.mapValues(\.encodable)
  }

  private nonisolated static func remote(_ error: any Error) -> any Error {
    guard case ClientError.ConvexError(let data)? = error as? ClientError,
      let remote = RemoteCallError(convexErrorData: data)
    else { return error }
    return remote
  }
}
