import Foundation
import Testing

@testable import RectoSync

/// A misspelt function name only fails against the live server, as "function
/// not found". Convex addresses `convex/<module>.ts`'s `export const <name>`
/// as `module:name`, so each name is checked against the backend source in
/// this repository.
@Suite("Convex function names")
struct ConvexFunctionNameTests {
  private static let convexDirectory = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()  // ConvexFunctionNameTests.swift
    .deletingLastPathComponent()  // RectoSyncTests
    .deletingLastPathComponent()  // Tests
    .deletingLastPathComponent()  // RectoSync
    .deletingLastPathComponent()  // Packages
    .deletingLastPathComponent()  // apple
    .appendingPathComponent("convex")

  @Test("every name is module:function and exists in convex/", arguments: ConvexFunction.all)
  func nameExists(name: String) throws {
    let parts = name.split(separator: ":")
    try #require(parts.count == 2, "\(name) must be module:function")
    let file = Self.convexDirectory.appendingPathComponent("\(parts[0]).ts")
    let source = try String(contentsOf: file, encoding: .utf8)
    #expect(source.contains("export const \(parts[1]) = "), "\(name) not exported by \(file.path)")
  }
}
