import Foundation
import Testing

/// Fixtures are produced by `apple/tools/generate-history-fixtures.ts`, which
/// runs the ACTUAL web implementations in `lib/`. A Swift port that disagrees
/// with the web fails here rather than in a user's document.
enum Fixtures {
  static func load<T: Decodable>(_ name: String, as type: T.Type = T.self) throws -> T {
    let url = try #require(
      Bundle.module.url(forResource: "Fixtures/\(name)", withExtension: "json"),
      "missing fixture \(name).json — run apple/tools/generate-history-fixtures.ts")
    return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
  }
}
