//
//  N0d spike (plan 023 §1.5): load `dist/recto-core.js` into a real JSContext,
//  run every RectoCore entry point over the committed fixtures, and prove the
//  bundle produces byte-identical results to the web — plus the load and
//  per-call numbers the plan budgets.
//
//  Usage: recto-core-parity <bundle.js> <markdown-corpus.json> <streak.json>
//                           <jsc-expected.json> [doc.md ...]
//  Each extra `doc.md` is timed as a whole-document call.
//

import Foundation
import JavaScriptCore

// MARK: - Comparison

/// Compare by UTF-16 code unit, never with `==`.
///
/// Swift's `String ==` is canonical equivalence: `"e\u{301}" == "é"` is `true`.
/// Markdown normalization is a byte contract, so `==` would wave through a port
/// that emitted NFD where the web emits NFC. `markdown-corpus.json` carries that
/// exact pair, and `assertComparisonIsByCodeUnit()` below proves this function
/// tells them apart while `==` does not.
func sameCodeUnits(_ a: String, _ b: String) -> Bool {
	a.utf16.elementsEqual(b.utf16)
}

/// Emoji and combining marks print unreadably in a failure line; show the code
/// units too, so a mismatch in invisible characters is diagnosable.
func describe(_ value: String) -> String {
	let units = value.utf16.map { String(format: "%04x", $0) }.joined(separator: " ")
	return "\(value.debugDescription) [\(units)]"
}

// MARK: - Fixtures

struct Heading: Decodable {
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
	let unicode: [CorpusCase]
}

struct StreakCase: Decodable {
	struct Day: Decodable {
		let date: String
		let words: Int
	}
	let name: String
	let days: [Day]
	let today: String
	let streak: Int
}

struct StreakFixture: Decodable {
	let cases: [StreakCase]
}

struct LintIssue: Decodable {
	let from: Int
	let to: Int
	let category: String
	let message: String
	let text: String
}

/// Written by `parity.ts` from `lib/` — the authority for the three entry points
/// no committed fixture covers, so this gate asserts exact payloads.
struct Expected: Decodable {
	struct HtmlFromMarkdown: Decodable {
		let markdown: String
		let html: String
	}
	struct MarkdownFromHtml: Decodable {
		let html: String
		let markdown: String
	}
	struct Lint: Decodable {
		let markdown: String
		let issues: [LintIssue]
	}
	let version: String
	let htmlFromMarkdown: HtmlFromMarkdown
	let markdownFromHtml: MarkdownFromHtml
	let lint: Lint
}

// MARK: - Host

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
		let log: @convention(block) (String) -> Void = {
			FileHandle.standardError.write(Data("[js] \($0)\n".utf8))
		}
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

	/// Every call goes through here, so a JS exception or a missing result
	/// becomes a Swift error instead of a plausible value: `undefined.toInt32()`
	/// is 0 and `undefined.toArray()` is nil, both of which read as "empty
	/// document" rather than "the bridge is broken".
	func call(_ method: String, _ arguments: [Any]) throws -> JSValue {
		context.exception = nil
		guard let result = api.invokeMethod(method, withArguments: arguments) else {
			throw JSError(description: "\(method) returned nothing")
		}
		if let exception = context.exception {
			context.exception = nil
			throw JSError(description: "\(method) threw: \(exception)")
		}
		if result.isUndefined || result.isNull {
			throw JSError(description: "\(method) returned \(result)")
		}
		return result
	}

	func version() throws -> String {
		guard let value = api.objectForKeyedSubscript("version"), value.isString,
			let string = value.toString()
		else {
			throw JSError(description: "RectoCore.version is not a string")
		}
		return string
	}

	private func string(_ method: String, _ arguments: [Any]) throws -> String {
		let result = try call(method, arguments)
		guard result.isString, let string = result.toString() else {
			throw JSError(description: "\(method) returned \(result), expected a string")
		}
		return string
	}

	func normalize(_ markdown: String) throws -> String {
		try string("normalize", [markdown])
	}

	func htmlFromMarkdown(_ markdown: String) throws -> String {
		try string("htmlFromMarkdown", [markdown])
	}

	func markdownFromHtml(_ html: String) throws -> String {
		try string("markdownFromHtml", [html])
	}

	private func int(_ method: String, _ arguments: [Any]) throws -> Int {
		let result = try call(method, arguments)
		guard result.isNumber, let number = result.toNumber() else {
			throw JSError(description: "\(method) returned \(result), expected a number")
		}
		guard let exact = Int(exactly: number.doubleValue) else {
			throw JSError(description: "\(method) returned \(number), expected an integer")
		}
		return exact
	}

	func countWords(_ markdown: String) throws -> Int {
		try int("countWords", [markdown])
	}

	func streak(_ days: [[String: Any]], _ today: String) throws -> Int {
		try int("streak", [days, today])
	}

	private func array(_ method: String, _ arguments: [Any]) throws -> [Any] {
		let result = try call(method, arguments)
		guard result.isArray, let array = result.toArray() else {
			throw JSError(description: "\(method) returned \(result), expected an array")
		}
		return array
	}

	/// A malformed heading is a failure, never a dropped element: skipping one
	/// would turn a broken bridge into a shorter outline that still "matches" a
	/// shorter expectation.
	func parseOutline(_ markdown: String) throws -> [Heading] {
		try array("parseOutline", [markdown]).enumerated().map { index, element in
			guard let dictionary = element as? [String: Any],
				let depth = dictionary["depth"] as? NSNumber,
				let text = dictionary["text"] as? String,
				let offset = dictionary["offset"] as? NSNumber,
				let headingIndex = dictionary["index"] as? NSNumber
			else {
				throw JSError(description: "parseOutline[\(index)] is malformed: \(element)")
			}
			return Heading(
				depth: depth.intValue, text: text,
				offset: offset.intValue, index: headingIndex.intValue)
		}
	}

	/// `lint` is the one async entry point (`write-good` is imported lazily in
	/// `lib/lint/analyze.ts`). JSC drains the microtask queue before returning to
	/// Swift, so a `then` callback registered here has already run by the time
	/// `invokeMethod` returns — no run loop spin, no continuation needed.
	func lint(_ markdown: String) throws -> [LintIssue] {
		let promise = try call("lint", [markdown])
		var settled: [Any]?
		var problem: String?
		let onFulfilled: @convention(block) (JSValue) -> Void = { issues in
			guard issues.isArray, let array = issues.toArray() else {
				problem = "lint resolved with \(issues), expected an array"
				return
			}
			settled = array
		}
		let onRejected: @convention(block) (JSValue) -> Void = { error in
			problem = "lint rejected: \(error)"
		}
		promise.invokeMethod("then", withArguments: [
			unsafeBitCast(onFulfilled, to: AnyObject.self),
			unsafeBitCast(onRejected, to: AnyObject.self),
		])
		if let problem { throw JSError(description: problem) }
		guard let settled else {
			throw JSError(description: "lint did not settle before invokeMethod returned")
		}
		return try settled.enumerated().map { index, element in
			guard let dictionary = element as? [String: Any],
				let from = dictionary["from"] as? NSNumber,
				let to = dictionary["to"] as? NSNumber,
				let category = dictionary["category"] as? String,
				let message = dictionary["message"] as? String,
				let text = dictionary["text"] as? String
			else {
				throw JSError(description: "lint[\(index)] is malformed: \(element)")
			}
			return LintIssue(
				from: from.intValue, to: to.intValue,
				category: category, message: message, text: text)
		}
	}
}

// MARK: - Reporting

var failures: [String] = []

@MainActor
func expect(_ actual: String, _ expected: String, _ what: String) {
	if !sameCodeUnits(actual, expected) {
		failures.append(
			"\(what)\n    got      \(describe(actual))\n    expected \(describe(expected))")
	}
}

@MainActor
func expect(_ actual: Int, _ expected: Int, _ what: String) {
	if actual != expected {
		failures.append("\(what): got \(actual), expected \(expected)")
	}
}

@MainActor
func expect(_ actual: [Heading], _ expected: [Heading], _ what: String) {
	guard actual.count == expected.count else {
		failures.append("\(what): got \(actual.count) headings, expected \(expected.count)")
		return
	}
	for (i, pair) in zip(actual, expected).enumerated() {
		let (got, want) = pair
		if got.depth != want.depth || got.offset != want.offset || got.index != want.index
			|| !sameCodeUnits(got.text, want.text)
		{
			failures.append("\(what)[\(i)]: got \(got), expected \(want)")
		}
	}
}

@MainActor
func expect(_ actual: [LintIssue], _ expected: [LintIssue], _ what: String) {
	guard actual.count == expected.count else {
		failures.append("\(what): got \(actual.count) issues, expected \(expected.count)")
		return
	}
	for (i, pair) in zip(actual, expected).enumerated() {
		let (got, want) = pair
		if got.from != want.from || got.to != want.to
			|| !sameCodeUnits(got.category, want.category)
			|| !sameCodeUnits(got.message, want.message)
			|| !sameCodeUnits(got.text, want.text)
		{
			failures.append("\(what)[\(i)]: got \(got), expected \(want)")
		}
	}
}

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

func read(_ path: String, _ what: String) -> Data {
	guard let data = FileManager.default.contents(atPath: path) else {
		fail("cannot read \(what) at \(path)")
	}
	return data
}

func decode<T: Decodable>(_ type: T.Type, _ data: Data, _ what: String) -> T {
	do { return try JSONDecoder().decode(type, from: data) } catch {
		fail("cannot decode \(what): \(error)")
	}
}

// MARK: - Run

let arguments = CommandLine.arguments
guard arguments.count >= 5 else {
	fail(
		"usage: recto-core-parity <bundle.js> <markdown-corpus.json> <streak.json> <jsc-expected.json> [doc.md ...]"
	)
}
let documentPaths = Array(arguments.dropFirst(5))

let bundleData = read(arguments[1], "the bundle (run `bun run core:build`)")
guard let bundleSource = String(data: bundleData, encoding: .utf8) else {
	fail("the bundle is not valid UTF-8")
}
let corpus = decode(
	Corpus.self, read(arguments[2], "markdown-corpus.json"), "markdown-corpus.json")
let streakFixture = decode(
	StreakFixture.self, read(arguments[3], "streak.json"), "streak.json")
let expected = decode(
	Expected.self, read(arguments[4], "jsc-expected.json"), "jsc-expected.json")

let core: Core
do { core = try Core(bundle: bundleSource) } catch { fail("\(error)") }

let version = (try? core.version()) ?? "?"
print(
	"bundle   \(ByteCountFormatter.string(fromByteCount: Int64(bundleData.count), countStyle: .binary)), RectoCore \(version)"
)
print(
	String(
		format: "load     %.1f ms (evaluateScript into a fresh JSContext)",
		core.loadSeconds * 1000))

/// The harness testing itself: the NFC/NFD pair must be equal under Swift's
/// `String ==` and different under code-unit comparison. If that ever stops
/// holding, every other string assertion here is worth less than it looks.
@MainActor
func assertComparisonIsByCodeUnit() {
	guard corpus.unicode.count >= 2 else {
		failures.append("unicode fixture needs the NFC/NFD pair")
		return
	}
	let nfc = corpus.unicode[0].normalized
	let nfd = corpus.unicode[1].normalized
	if nfc != nfd {
		failures.append(
			"harness: the NFC/NFD pair is no longer canonically equal, so `==` is not being tested")
	}
	if sameCodeUnits(nfc, nfd) {
		failures.append(
			"harness: the NFC/NFD pair has the same code units, so this comparison proves nothing")
	}
}
assertComparisonIsByCodeUnit()

@MainActor
func checkCases(_ cases: [CorpusCase], _ label: String) {
	for testCase in cases {
		let context = "\(label) case \(testCase.id) (\(testCase.name))"
		do {
			let normalized = try core.normalize(testCase.input)
			expect(normalized, testCase.normalized, "\(context): normalize")
			// Corpus gate 25: normalizing canonical output is a no-op.
			expect(
				try core.normalize(normalized), testCase.normalized, "\(context): idempotence")
			expect(try core.countWords(testCase.input), testCase.words, "\(context): countWords")
			expect(
				try core.parseOutline(testCase.input), testCase.outline,
				"\(context): parseOutline")
		} catch {
			failures.append("\(context): \(error)")
		}
	}
}
checkCases(corpus.cases, "corpus")
checkCases(corpus.unicode, "unicode")

for testCase in streakFixture.cases {
	do {
		let days = testCase.days.map { ["date": $0.date, "words": $0.words] as [String: Any] }
		expect(
			try core.streak(days, testCase.today), testCase.streak,
			"streak \"\(testCase.name)\"")
	} catch {
		failures.append("streak \"\(testCase.name)\": \(error)")
	}
}

// The remaining entry points, against the exact payloads `lib/` produced.
do {
	expect(version, expected.version, "version")
	expect(
		try core.htmlFromMarkdown(expected.htmlFromMarkdown.markdown),
		expected.htmlFromMarkdown.html, "htmlFromMarkdown")
	expect(
		try core.markdownFromHtml(expected.markdownFromHtml.html),
		expected.markdownFromHtml.markdown, "markdownFromHtml")
	let issues = try core.lint(expected.lint.markdown)
	expect(issues, expected.lint.issues, "lint")
	if expected.lint.issues.isEmpty {
		failures.append("lint: the probe produced no issues, so that assertion proves nothing")
	} else {
		print(
			"lint     \(issues.count) issue(s) on the probe, byte-equal to lib/lint/analyze (promise settled synchronously)"
		)
	}
} catch {
	failures.append("\(error)")
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
		print(
			String(
				format:
					"call     %-26@ normalize %8.3f ms · countWords %8.3f ms · parseOutline %8.3f ms (JSContext)",
				label as NSString, normalizeMs, countMs, outlineMs))
	} catch {
		failures.append("latency \(label): \(error)")
	}
}

report("corpus case (\(largest.input.utf8.count) B)", largest.input, runs: 20)

for path in documentPaths {
	guard let data = FileManager.default.contents(atPath: path),
		let markdown = String(data: data, encoding: .utf8)
	else {
		failures.append("cannot read \(path)")
		continue
	}
	report("\((path as NSString).lastPathComponent) (\(data.count / 1024) kB)", markdown, runs: 1)
}

if failures.isEmpty {
	let gates = corpus.cases.count + 1
	print(
		"parity   \(corpus.cases.count)/\(corpus.cases.count) corpus cases + idempotence sweep = \(gates)/\(gates) gates, \(corpus.unicode.count) unicode, \(streakFixture.cases.count) streak, all 7 globals byte-exact"
	)
} else {
	for failure in failures { FileHandle.standardError.write(Data("FAIL \(failure)\n".utf8)) }
	fail("\(failures.count) parity failure(s)")
}
