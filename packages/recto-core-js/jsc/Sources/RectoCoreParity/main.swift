//
//  N0d spike (plan 023 §1.5): load `dist/recto-core.js` into a real JSContext,
//  run it over `packages/editor-fixtures/markdown-corpus.json`, and prove the
//  bundle produces byte-identical results to the web — plus the load and
//  per-call numbers the plan budgets ("calls are sync and small, documents
//  <= 950 kB").
//
//  Usage: recto-core-parity <bundle.js> <markdown-corpus.json> [doc.md ...]
//  Each extra `doc.md` is timed as a whole-document call.
//

import Foundation
import JavaScriptCore

// MARK: - Fixtures

struct Heading: Decodable, Equatable {
	let depth: Int
	let text: String
	let offset: Int
	let index: Int
}

struct CorpusCase: Decodable {
	let id: Int
	let name: String
	let input: String
	let normalized: String
	let words: Int
	let outline: [Heading]
}

struct Corpus: Decodable {
	let cases: [CorpusCase]
}

// MARK: - Host

/// Thin wrapper that turns a JS exception into a Swift error instead of leaving
/// a `JSValue` of `undefined` to be silently compared against a fixture.
struct JSError: Error, CustomStringConvertible {
	let description: String
}

final class Core {
	private let context = JSContext()!
	private let api: JSValue
	let loadSeconds: Double

	init(bundle: String) throws {
		// A bare JSContext has no console; the bundle's prelude installs a no-op
		// one. Replacing it here proves a host is free to route logging itself.
		let log: @convention(block) (String) -> Void = { FileHandle.standardError.write(Data("[js] \($0)\n".utf8)) }
		let console = JSValue(newObjectIn: context)!
		for name in ["log", "info", "warn", "error", "debug"] {
			console.setValue(log, forProperty: name)
		}
		context.setObject(console, forKeyedSubscript: "console" as NSString)

		let start = CFAbsoluteTimeGetCurrent()
		context.evaluateScript(bundle)
		loadSeconds = CFAbsoluteTimeGetCurrent() - start

		if let exception = context.exception {
			throw JSError(description: "evaluating the bundle threw: \(exception)")
		}
		guard let core = context.objectForKeyedSubscript("RectoCore"), !core.isUndefined else {
			throw JSError(description: "globalThis.RectoCore is undefined after loading the bundle")
		}
		api = core
	}

	var version: String { api.objectForKeyedSubscript("version").toString() ?? "?" }

	func call(_ method: String, _ arguments: [Any]) throws -> JSValue {
		context.exception = nil
		guard let result = api.invokeMethod(method, withArguments: arguments) else {
			throw JSError(description: "\(method) returned nothing")
		}
		if let exception = context.exception {
			context.exception = nil
			throw JSError(description: "\(method) threw: \(exception)")
		}
		return result
	}

	func normalize(_ markdown: String) throws -> String {
		try call("normalize", [markdown]).toString() ?? ""
	}

	func countWords(_ markdown: String) throws -> Int {
		Int(try call("countWords", [markdown]).toInt32())
	}

	func parseOutline(_ markdown: String) throws -> [Heading] {
		let raw = try call("parseOutline", [markdown]).toArray() ?? []
		return raw.compactMap { element in
			guard let dict = element as? [String: Any],
				let depth = dict["depth"] as? NSNumber,
				let text = dict["text"] as? String,
				let offset = dict["offset"] as? NSNumber,
				let index = dict["index"] as? NSNumber
			else { return nil }
			return Heading(
				depth: depth.intValue, text: text,
				offset: offset.intValue, index: index.intValue)
		}
	}

	/// `lint` is the one async entry point (`write-good` is imported lazily in
	/// `lib/lint/analyze.ts`). JSC drains the microtask queue before returning to
	/// Swift, so a `then` callback registered here has already run by the time
	/// `invokeMethod` returns — no run loop spin, no continuation needed.
	func lintIssueCount(_ markdown: String) throws -> Int {
		// One argument = every category (an empty array would mean "no categories"
		// and legitimately return no issues).
		let promise = try call("lint", [markdown])
		var count = -1
		let onFulfilled: @convention(block) (JSValue) -> Void = { issues in
			count = Int(issues.objectForKeyedSubscript("length").toInt32())
		}
		let onRejected: @convention(block) (JSValue) -> Void = { error in
			FileHandle.standardError.write(Data("lint rejected: \(error)\n".utf8))
		}
		promise.invokeMethod("then", withArguments: [
			unsafeBitCast(onFulfilled, to: AnyObject.self),
			unsafeBitCast(onRejected, to: AnyObject.self),
		])
		return count
	}
}

// MARK: - Reporting

func milliseconds(_ body: () throws -> Void, runs: Int) rethrows -> Double {
	var best = Double.greatestFiniteMagnitude
	for _ in 0..<runs {
		let start = CFAbsoluteTimeGetCurrent()
		try body()
		best = min(best, (CFAbsoluteTimeGetCurrent() - start) * 1000)
	}
	return best
}

func fail(_ message: String) -> Never {
	FileHandle.standardError.write(Data("recto-core-parity: \(message)\n".utf8))
	exit(1)
}

// MARK: - Run

let arguments = CommandLine.arguments
guard arguments.count >= 3 else {
	fail("usage: recto-core-parity <bundle.js> <markdown-corpus.json> [doc.md ...]")
}
let bundlePath = arguments[1]
let corpusPath = arguments[2]
let documentPaths = Array(arguments.dropFirst(3))

guard let bundleData = FileManager.default.contents(atPath: bundlePath),
	let bundleSource = String(data: bundleData, encoding: .utf8)
else { fail("cannot read \(bundlePath) — run `bun run core:build` first") }

guard let corpusData = FileManager.default.contents(atPath: corpusPath) else {
	fail("cannot read \(corpusPath) — run `bun run fixtures:build` first")
}

let corpus: Corpus
do { corpus = try JSONDecoder().decode(Corpus.self, from: corpusData) } catch {
	fail("cannot decode \(corpusPath): \(error)")
}

let core: Core
do { core = try Core(bundle: bundleSource) } catch { fail("\(error)") }

print("bundle   \(ByteCountFormatter.string(fromByteCount: Int64(bundleData.count), countStyle: .binary)), RectoCore \(core.version)")
print(String(format: "load     %.1f ms (evaluateScript into a fresh JSContext)", core.loadSeconds * 1000))

var failures: [String] = []
for testCase in corpus.cases {
	do {
		let normalized = try core.normalize(testCase.input)
		if normalized != testCase.normalized {
			failures.append("case \(testCase.id) \(testCase.name): normalize mismatch")
		}
		// Corpus gate 25: normalizing canonical output is a no-op.
		if try core.normalize(normalized) != testCase.normalized {
			failures.append("case \(testCase.id) \(testCase.name): normalize is not idempotent")
		}
		let words = try core.countWords(testCase.input)
		if words != testCase.words {
			failures.append("case \(testCase.id) \(testCase.name): countWords \(words) != \(testCase.words)")
		}
		let outline = try core.parseOutline(testCase.input)
		if outline != testCase.outline {
			failures.append("case \(testCase.id) \(testCase.name): outline mismatch")
		}
	} catch {
		failures.append("case \(testCase.id) \(testCase.name): \(error)")
	}
}

do {
	// The lint path is what pulls `write-good` (and its `debug`/`console` use)
	// into the bundle; run it once so a load-time regression there is caught too.
	let issues = try core.lintIssueCount("The report was written by the committee.")
	if issues < 0 {
		failures.append("lint: the promise did not settle before invokeMethod returned")
	} else {
		print("lint     \(issues) issue(s) on the passive-voice probe (promise settled synchronously)")
	}
} catch {
	failures.append("lint: \(error)")
}

// MARK: - Latency

guard let largest = corpus.cases.max(by: { $0.input.utf8.count < $1.input.utf8.count }) else {
	fail("empty corpus")
}

@MainActor
func report(_ label: String, _ markdown: String, runs: Int) {
	do {
		let normalizeMs = try milliseconds({ _ = try core.normalize(markdown) }, runs: runs)
		let countMs = try milliseconds({ _ = try core.countWords(markdown) }, runs: runs)
		let outlineMs = try milliseconds({ _ = try core.parseOutline(markdown) }, runs: runs)
		print(String(
			format: "call     %-34@ normalize %8.3f ms · countWords %8.3f ms · parseOutline %8.3f ms (best of %d)",
			label as NSString, normalizeMs, countMs, outlineMs, runs))
	} catch {
		failures.append("latency \(label): \(error)")
	}
}

report("largest corpus case (\(largest.input.utf8.count) B)", largest.input, runs: 20)

for path in documentPaths {
	guard let data = FileManager.default.contents(atPath: path),
		let markdown = String(data: data, encoding: .utf8)
	else {
		failures.append("cannot read \(path)")
		continue
	}
	let name = (path as NSString).lastPathComponent
	report("\(name) (\(data.count / 1024) kB)", markdown, runs: 1)
}

if failures.isEmpty {
	print("parity   \(corpus.cases.count)/\(corpus.cases.count) corpus cases + idempotence sweep = \(corpus.cases.count + 1)/\(corpus.cases.count + 1) gates green")
} else {
	for failure in failures { FileHandle.standardError.write(Data("FAIL \(failure)\n".utf8)) }
	fail("\(failures.count) parity failure(s)")
}
