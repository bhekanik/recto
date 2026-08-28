import Foundation
import JavaScriptCore
import os

/// The shared JS core (`packages/recto-core-js`) running in a `JSContext`.
///
/// This is the *authority* for anything that has to match the web byte for byte:
/// canonical normalization, the preview HTML, smart paste, prose lint. It is not
/// a per-keystroke API — plan 023 §1.5 measured ~10 ms per kB of markdown per
/// whole-document call on a Mac, and iOS has no JIT for an in-process
/// `JSContext` at all (see `apple/Packages/README.md`). Call it at document
/// boundaries: open, paste, save, mode switch, export. `WordCount` and `Outline`
/// in this same module are the Swift ports for the typing path, and they are
/// pinned to these results by `RectoCoreJSTests`.
///
/// ## Threading
///
/// A `JSContext` is not thread-safe, so this owns a serial queue and a
/// `JSVirtualMachine` of its own and confines the context to that queue. Nothing
/// derived from a `JSValue` escapes: every call converts to a Swift value before
/// returning. Loading the bundle costs ~20 ms, so a second instance for a second
/// queue is affordable; sharing one instance across queues is what the design
/// forbids, and the `async` surface makes that impossible to do by accident.
///
/// ## Errors
///
/// Every entry point throws on bad input rather than returning a sentinel. The
/// bridge is equally strict reading results back, because `JSValue` coercion is
/// lossy in the direction that hides bugs: `undefined.toInt32()` is `0` and
/// `undefined.toArray()` is `nil`, both of which read as "empty document"
/// instead of "the bridge is broken".
public final class RectoCore: @unchecked Sendable {
    /// Not `Sendable`; only ever touched on `queue`.
    private final class Engine: @unchecked Sendable {
        let context: JSContext
        let api: JSValue

        init(context: JSContext, api: JSValue) {
            self.context = context
            self.api = api
        }
    }

    private let queue: DispatchQueue
    private let engine: Engine

    /// `<package version>+<git short sha>` of the bundle that is loaded.
    public let version: String

    /// How long `evaluateScript` took, for the perf tests and for a startup log.
    public let loadDuration: TimeInterval

    private static let log = Logger(subsystem: "com.bhekani.recto", category: "RectoCoreJS")

    /// Loads the bundle and blocks until it has evaluated (~20 ms).
    ///
    /// Deliberately synchronous: a half-initialised core that fails on first use
    /// would surface the "you did not run `bun run core:build`" error somewhere
    /// far from the cause.
    ///
    /// - Parameters:
    ///   - bundleURL: the script to evaluate. Defaults to the package resource.
    ///   - label: queue label, so two cores are distinguishable in Instruments.
    public init(bundleURL: URL? = nil, label: String = "com.bhekani.recto.core-js") throws {
        let url = try bundleURL ?? Self.bundledScriptURL()
        let source = try Self.readSource(at: url)

        // `.userInitiated`: these calls sit behind opening or saving a document,
        // so they are latency-sensitive without being interactive.
        let queue = DispatchQueue(label: label, qos: .userInitiated)
        self.queue = queue

        var built: Result<(Engine, String, TimeInterval), Error>!
        // The virtual machine is created on the queue that will use it, so the
        // context and its VM never see a second thread.
        queue.sync { built = Self.makeEngine(source: source, url: url) }
        let (engine, version, loadDuration) = try built.get()
        self.engine = engine
        self.version = version
        self.loadDuration = loadDuration
        Self.log.info(
            "loaded recto-core \(version, privacy: .public) in \(loadDuration * 1000, format: .fixed(precision: 1)) ms")
    }

    private static func makeEngine(
        source: String, url: URL
    ) -> Result<(Engine, String, TimeInterval), Error> {
        guard let context = JSContext(virtualMachine: JSVirtualMachine()) else {
            return .failure(RectoCoreError.bundleLoadFailed("JSContext() returned nil"))
        }

        // A bare JSContext has no console, and `write-good` reads `console.debug`
        // at module scope. The bundle installs a no-op one; replacing it first
        // routes anything the core logs to os_log instead of the void.
        let emit: @convention(block) (String) -> Void = { message in
            log.debug("[js] \(message, privacy: .public)")
        }
        if let console = JSValue(newObjectIn: context) {
            for name in ["log", "info", "warn", "error", "debug"] {
                console.setValue(emit, forProperty: name)
            }
            context.setObject(console, forKeyedSubscript: "console" as NSString)
        }

        var thrown: String?
        context.exceptionHandler = { _, value in
            thrown = value?.toString() ?? "unknown JS exception"
        }

        let start = DispatchTime.now()
        context.evaluateScript(source, withSourceURL: url)
        let elapsed = seconds(since: start)

        if let thrown {
            return .failure(RectoCoreError.bundleLoadFailed(thrown))
        }
        guard let api = context.objectForKeyedSubscript("RectoCore"), !api.isUndefined else {
            return .failure(RectoCoreError.missingGlobal)
        }
        guard let versionValue = api.objectForKeyedSubscript("version"), versionValue.isString,
            let version = versionValue.toString()
        else {
            return .failure(
                RectoCoreError.unexpectedResult(call: "version", detail: "a non-string"))
        }
        return .success((Engine(context: context, api: api), version, elapsed))
    }

    /// The bundle shipped in the package's resources.
    public static func bundledScriptURL() throws -> URL {
        guard
            let url = Bundle.module.url(
                forResource: "recto-core", withExtension: "js", subdirectory: "JS")
        else {
            throw RectoCoreError.bundleMissing(
                "Run `bun install && bun run core:build && apple/scripts/copy-js-bundles.sh`.")
        }
        return url
    }

    private static func readSource(at url: URL) throws -> String {
        do {
            return try String(contentsOf: url, encoding: .utf8)
        } catch {
            throw RectoCoreError.bundleLoadFailed("\(url.lastPathComponent): \(error)")
        }
    }

    // MARK: - API

    /// `serialize(parse(md))` with the canonical stringify options — the one
    /// MDAST↔string crossing, and the contract the web shares.
    public func normalize(_ markdown: String) async throws -> String {
        try await string("normalize", [markdown])
    }

    /// Prose words, markdown syntax excluded. The authority for `WordCount`.
    public func countWords(_ markdown: String) async throws -> Int {
        try await integer("countWords", [markdown])
    }

    /// Flat heading list in document order. The authority for `Outline`.
    public func parseOutline(_ markdown: String) async throws -> [OutlineHeading] {
        let elements = try await array("parseOutline", [markdown])
        return try elements.enumerated().map { index, element in
            guard let dictionary = element as? [String: Any],
                let depth = dictionary["depth"] as? NSNumber,
                let text = dictionary["text"] as? String,
                let offset = dictionary["offset"] as? NSNumber,
                let headingIndex = dictionary["index"] as? NSNumber
            else {
                // Never skip: a dropped element makes the outline shorter, which
                // reads as "no headings here" rather than "the bridge is broken".
                throw RectoCoreError.unexpectedResult(
                    call: "parseOutline", detail: "a malformed heading at \(index): \(element)")
            }
            return OutlineHeading(
                depth: depth.intValue, text: text,
                offset: offset.intValue, index: headingIndex.intValue)
        }
    }

    /// The **sanitized** preview pipeline (`lib/preview/render.ts`), not the
    /// export renderer — that one absolutizes URLs against `window.location` and
    /// stays on the web.
    public func htmlFromMarkdown(_ markdown: String) async throws -> String {
        try await string("htmlFromMarkdown", [markdown])
    }

    /// Smart paste: HTML in, canonical markdown out.
    public func markdownFromHtml(_ html: String) async throws -> String {
        try await string("markdownFromHtml", [html])
    }

    /// Prose lint. `categories: nil` enables all of them; `[]` returns nothing.
    ///
    /// This is the one async entry point in the bundle (`write-good` is imported
    /// lazily, because its transitive `adverb-where` builds a RegExp from
    /// concatenated template literals and minifiers have corrupted it). The
    /// import target is inside the bundle, so the promise is already resolved
    /// when it is returned, and JSC drains the microtask queue before returning
    /// to native code — a `then` registered here has therefore already run by
    /// the time `invokeMethod` returns. No run-loop spin, no continuation.
    public func lint(
        _ markdown: String, categories: [LintCategory]? = nil
    ) async throws -> [LintIssue] {
        let arguments = UncheckedBox<[Any]>(
            categories.map { [markdown, $0.map(\.rawValue)] } ?? [markdown])
        let boxed = try await run("lint") { engine -> UncheckedBox<[Any]> in
            let promise = try Self.call(engine, "lint", arguments.value)
            var settled: [Any]?
            var problem: String?
            let onFulfilled: @convention(block) (JSValue) -> Void = { issues in
                guard issues.isArray, let array = issues.toArray() else {
                    problem = "resolved with a non-array"
                    return
                }
                settled = array
            }
            let onRejected: @convention(block) (JSValue) -> Void = { error in
                problem = error.toString() ?? "an unknown rejection"
            }
            promise.invokeMethod(
                "then",
                withArguments: [
                    unsafeBitCast(onFulfilled, to: AnyObject.self),
                    unsafeBitCast(onRejected, to: AnyObject.self),
                ])
            if let problem {
                throw RectoCoreError.javaScript(call: "lint", message: problem)
            }
            guard let settled else {
                throw RectoCoreError.unexpectedResult(
                    call: "lint", detail: "a promise that had not settled when invokeMethod returned")
            }
            return UncheckedBox(settled)
        }
        let elements = boxed.value

        return try elements.enumerated().map { index, element in
            guard let dictionary = element as? [String: Any],
                let from = dictionary["from"] as? NSNumber,
                let to = dictionary["to"] as? NSNumber,
                let category = dictionary["category"] as? String,
                let message = dictionary["message"] as? String,
                let text = dictionary["text"] as? String
            else {
                throw RectoCoreError.unexpectedResult(
                    call: "lint", detail: "a malformed issue at \(index): \(element)")
            }
            return LintIssue(
                from: from.intValue, to: to.intValue,
                category: category, message: message, text: text)
        }
    }

    /// Consecutive written days counting back from `today`, which is a local
    /// calendar key (`"YYYY-MM-DD"`), not an instant.
    public func streak(_ days: [WritingDay], today: String) async throws -> Int {
        let payload = days.map { ["date": $0.date, "words": $0.words] as [String: Any] }
        return try await integer("streak", [payload, today])
    }

    // MARK: - Bridge

    private func run<T>(
        _ call: String, _ body: @escaping @Sendable (Engine) throws -> T
    ) async throws -> T where T: Sendable {
        let engine = engine
        return try await withCheckedThrowingContinuation { continuation in
            queue.async {
                continuation.resume(with: Result { try body(engine) })
            }
        }
    }

    /// The single crossing point. Clearing `context.exception` before and after
    /// each call is what keeps one failure from being reported against the next
    /// call — a JS throw leaves the exception standing on the context.
    private static func call(_ engine: Engine, _ method: String, _ arguments: [Any]) throws
        -> JSValue
    {
        engine.context.exception = nil
        guard let result = engine.api.invokeMethod(method, withArguments: arguments) else {
            throw RectoCoreError.unexpectedResult(call: method, detail: "nothing")
        }
        if let exception = engine.context.exception {
            engine.context.exception = nil
            throw RectoCoreError.javaScript(
                call: method, message: exception.toString() ?? "an unreadable exception")
        }
        if result.isUndefined || result.isNull {
            throw RectoCoreError.unexpectedResult(call: method, detail: "\(result)")
        }
        return result
    }

    private func string(_ method: String, _ arguments: [Any]) async throws -> String {
        let arguments = UncheckedBox(arguments)
        return try await run(method) { engine in
            let result = try Self.call(engine, method, arguments.value)
            guard result.isString, let string = result.toString() else {
                throw RectoCoreError.unexpectedResult(call: method, detail: "a non-string")
            }
            return string
        }
    }

    private func integer(_ method: String, _ arguments: [Any]) async throws -> Int {
        let arguments = UncheckedBox(arguments)
        return try await run(method) { engine in
            let result = try Self.call(engine, method, arguments.value)
            guard result.isNumber, let number = result.toNumber(),
                let exact = Int(exactly: number.doubleValue)
            else {
                throw RectoCoreError.unexpectedResult(
                    call: method, detail: "something that is not an integer")
            }
            return exact
        }
    }

    private func array(_ method: String, _ arguments: [Any]) async throws -> [Any] {
        // `[Any]` is not Sendable; it is decoded into a Sendable value by the
        // caller on the way out, and never touched on the JS queue afterwards.
        let arguments = UncheckedBox(arguments)
        let boxed = try await run(method) { engine -> UncheckedBox<[Any]> in
            let result = try Self.call(engine, method, arguments.value)
            guard result.isArray, let array = result.toArray() else {
                throw RectoCoreError.unexpectedResult(call: method, detail: "a non-array")
            }
            return UncheckedBox(array)
        }
        return boxed.value
    }

    static func seconds(since start: DispatchTime) -> TimeInterval {
        TimeInterval(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000_000
    }
}

/// Carries a JSON-derived `[Any]` off the JS queue.
///
/// `toArray()` returns Foundation values (`NSNumber`, `NSString`, `NSDictionary`)
/// that are immutable and value-like but not `Sendable`. They are read once, on
/// the awaiting task, and never handed back to JavaScript.
private struct UncheckedBox<Value>: @unchecked Sendable {
    let value: Value
    init(_ value: Value) { self.value = value }
}
