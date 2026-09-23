import Foundation
import RectoSync

/// A `RectoAPI` that records every call and answers with JSON scripted per
/// function name, decoded the way the SDK decodes Convex results. For the
/// features that talk to the server (versions, sharing, comments, AI).
actor ScriptedAPI: RectoAPI {
    struct Call: Equatable {
        let name: String
        let args: [String: ConvexValue]
    }

    private(set) var calls: [Call] = []
    private var responses: [String: String] = [:]
    private var failures: [String: RemoteCallError] = [:]

    /// `json` is the function's return value, e.g. `"null"` or `#"{"versionId":"v1"}"#`.
    func respond(_ name: String, json: String) {
        responses[name] = json
    }

    func fail(_ name: String, _ error: RemoteCallError) {
        failures[name] = error
    }

    func calls(to name: String) -> [Call] {
        calls.filter { $0.name == name }
    }

    private func answer<T: Decodable>(_ name: String, _ args: [String: ConvexValue]) throws -> T {
        calls.append(Call(name: name, args: args))
        if let failure = failures[name] { throw failure }
        let json = responses[name] ?? "null"
        if T.self == ConvexVoid.self { return ConvexVoid() as! T }
        return try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    func query<T: Decodable & Sendable>(_ name: String, args: [String: ConvexValue]) async throws -> T {
        try answer(name, args)
    }

    func subscribe<T: Decodable & Sendable>(_ name: String, args: [String: ConvexValue])
        -> AsyncThrowingStream<T, any Error>
    {
        let result: Result<T, any Error> = Result { try answer(name, args) }
        return AsyncThrowingStream { continuation in
            switch result {
            case .success(let value): continuation.yield(value)
            case .failure(let error): continuation.finish(throwing: error)
            }
        }
    }

    func mutation<T: Decodable & Sendable>(_ name: String, args: [String: ConvexValue]) async throws -> T {
        try answer(name, args)
    }

    func action<T: Decodable & Sendable>(_ name: String, args: [String: ConvexValue]) async throws -> T {
        try answer(name, args)
    }
}
