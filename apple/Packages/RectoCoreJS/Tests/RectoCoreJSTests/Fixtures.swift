import Foundation
import Testing

@testable import RectoCoreJS

/// The shared parity corpus in `packages/editor-fixtures`, read from the source
/// tree rather than copied into the test bundle.
///
/// Copying would mean a second place for the JSON to go stale, and the whole
/// point of these files is that the web and the native ports run *the same*
/// bytes. `#filePath` is resolved at compile time, so this finds the checkout
/// the tests were built from.
enum Fixtures {
    static let repositoryRoot: URL = {
        // …/apple/Packages/RectoCoreJS/Tests/RectoCoreJSTests/Fixtures.swift
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        return url.deletingLastPathComponent()
    }()

    static func url(_ name: String) -> URL {
        repositoryRoot.appending(path: "packages/editor-fixtures/\(name)")
    }

    static func load<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        let data = try Data(contentsOf: url(name))
        return try JSONDecoder().decode(type, from: data)
    }

    /// A `RectoCore` over the built bundle, or a skip when it has not been built.
    ///
    /// Failing here would make "you forgot `bun run core:build`" look like a
    /// parity regression; the Swift-port tests below do not need the bundle and
    /// still run.
    static func core() throws -> RectoCore {
        let bundle = repositoryRoot.appending(path: "packages/recto-core-js/dist/recto-core.js")
        guard FileManager.default.fileExists(atPath: bundle.path) else {
            throw SkipBundle()
        }
        return try RectoCore(bundleURL: bundle)
    }

    struct SkipBundle: Error, CustomStringConvertible {
        var description: String {
            "packages/recto-core-js/dist/recto-core.js is missing — run `bun run core:build`"
        }
    }
}

// MARK: - Fixture shapes

struct CorpusCase: Decodable {
    let id: Int
    let name: String
    let input: String
    let normalized: String
    let words: Int
    let outline: [OutlineHeading]
}

struct Corpus: Decodable {
    let cases: [CorpusCase]
    let unicode: [CorpusCase]
}

struct WordCountFixture: Decodable {
    struct Case: Decodable {
        let name: String
        let markdown: String
        let words: Int
    }
    let cases: [Case]
}

struct OutlineFixture: Decodable {
    struct Case: Decodable {
        let name: String
        let markdown: String
        let outline: [OutlineHeading]
    }
    let cases: [Case]
}

struct StreakFixture: Decodable {
    struct Case: Decodable {
        let name: String
        let days: [WritingDay]
        let today: String
        let streak: Int
    }
    let cases: [Case]
}

// MARK: - Comparison

/// Compare by UTF-16 code unit, never with `==`.
///
/// Swift's `String ==` is canonical equivalence — `"e\u{301}" == "é"` is `true` —
/// so `==` would wave through a port that emitted NFD where the web emits NFC.
/// The first two entries of the corpus's `unicode` array are exactly that pair,
/// and `harness proves its own comparison` below fails if this ever weakens.
func sameCodeUnits(_ a: String, _ b: String) -> Bool {
    a.utf16.elementsEqual(b.utf16)
}

/// Emoji and combining marks print unreadably in a failure line; show the code
/// units too, so a mismatch in invisible characters is diagnosable.
func describe(_ value: String) -> String {
    let units = value.utf16.map { String(format: "%04x", $0) }.joined(separator: " ")
    return "\(value.debugDescription) [\(units)]"
}

func expectSameCodeUnits(
    _ actual: String, _ expected: String, _ what: @autoclosure () -> String,
    sourceLocation: SourceLocation = #_sourceLocation
) {
    #expect(
        sameCodeUnits(actual, expected),
        "\(what()): got \(describe(actual)), expected \(describe(expected))",
        sourceLocation: sourceLocation)
}
