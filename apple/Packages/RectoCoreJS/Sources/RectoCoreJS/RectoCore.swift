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
        try await string("normalize", [.string(markdown)])
    }

    /// Prose words, markdown syntax excluded. The authority for `WordCount`.
    public func countWords(_ markdown: String) async throws -> Int {
        try await integer("countWords", [.string(markdown)])
    }

    /// Flat heading list in document order. The authority for `Outline`.
    public func parseOutline(_ markdown: String) async throws -> [OutlineHeading] {
        try await array("parseOutline", [.string(markdown)]) { dictionary in
            // Never skip a malformed element: a dropped one makes the outline
            // shorter, which reads as "no headings here" rather than "the
            // bridge is broken".
            guard let depth = dictionary["depth"] as? NSNumber,
                let text = dictionary["text"] as? String,
                let offset = dictionary["offset"] as? NSNumber,
                let index = dictionary["index"] as? NSNumber
            else { return nil }
            return OutlineHeading(
                depth: depth.intValue, text: text,
                offset: offset.intValue, index: index.intValue)
        }
    }

    /// The **sanitized** preview pipeline (`lib/preview/render.ts`), not the
    /// export renderer — that one absolutizes URLs against `window.location` and
    /// stays on the web.
    public func htmlFromMarkdown(_ markdown: String) async throws -> String {
        try await string("htmlFromMarkdown", [.string(markdown)])
    }

    /// Smart paste: HTML in, canonical markdown out.
    public func markdownFromHtml(_ html: String) async throws -> String {
        try await string("markdownFromHtml", [.string(html)])
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
        var arguments: [Argument] = [.string(markdown)]
        if let categories { arguments.append(.strings(categories.map(\.rawValue))) }
        return try await array("lint", arguments, call: Self.settle) { dictionary in
            guard let from = dictionary["from"] as? NSNumber,
                let to = dictionary["to"] as? NSNumber,
                let category = dictionary["category"] as? String,
                let message = dictionary["message"] as? String,
                let text = dictionary["text"] as? String
            else { return nil }
            return LintIssue(
                from: from.intValue, to: to.intValue,
                category: category, message: message, text: text)
        }
    }

    /// Reads the array out of the promise `lint` returns.
    ///
    /// JSC drains the microtask queue before returning to native code, and the
    /// bundle's lazy `write-good` import resolves inside the bundle, so the
    /// `then` registered here has already run by the time `invokeMethod`
    /// returns. If that ever stops holding, `settled` is nil and this throws
    /// rather than reporting an empty lint.
    private static func settle(_ promise: JSValue) throws -> JSValue {
        var settled: JSValue?
        var problem: String?
        let onFulfilled: @convention(block) (JSValue) -> Void = { settled = $0 }
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
                call: "lint",
                detail: "a promise that had not settled when invokeMethod returned")
        }
        return settled
    }

    /// `lib/ai/chunk.ts`: paragraph windows (~1,500 characters, one paragraph of
    /// overlap) for related-passage search. Offsets are UTF-16 into `markdown`.
    public func chunk(_ markdown: String) async throws -> [TextChunk] {
        try await array("chunk", [.string(markdown)]) { dictionary in
            guard let start = dictionary["charStart"] as? NSNumber,
                  let end = dictionary["charEnd"] as? NSNumber,
                  let text = dictionary["text"] as? String
            else { return nil }
            return TextChunk(charStart: start.intValue, charEnd: end.intValue, text: text)
        }
    }

    /// `lib/ai/transform-checks`: what a finished AI transform broke, as the
    /// sentences the web shows beside Keep and Reject. `presetId` is nil for a
    /// free-text instruction.
    public func transformWarnings(
        original: String, rewritten: String, presetId: String?
    ) async throws -> [String] {
        try await run("transformWarnings") { engine in
            let result = try Self.call(
                engine, "transformWarnings",
                [.string(original), .string(rewritten), presetId.map(Argument.string) ?? .null])
            guard result.isArray, let elements = result.toArray() as? [String] else {
                throw RectoCoreError.unexpectedResult(call: "transformWarnings", detail: "a non-string array")
            }
            return elements
        }
    }

    /// Consecutive written days counting back from `today`, which is a local
    /// calendar key (`"YYYY-MM-DD"`), not an instant.
    public func streak(_ days: [WritingDay], today: String) async throws -> Int {
        try await integer("streak", [.days(days), .string(today)])
    }

    // MARK: - Bridge

    /// One argument on its way into JavaScript.
    ///
    /// `invokeMethod` takes `[Any]` of Foundation values, none of which are
    /// `Sendable`, so an argument list cannot be captured by a closure that
    /// hops to the JS queue under Swift 6. Describing the arguments as data and
    /// materialising them *on* that queue removes the crossing instead of
    /// silencing it with an unchecked box.
    private enum Argument: Sendable {
        case string(String)
        case strings([String])
        case days([WritingDay])
        case null

        var bridged: Any {
            switch self {
            case .null: return NSNull()
            case .string(let value): return value
            case .strings(let values): return values
            case .days(let days):
                return days.map { ["date": $0.date, "words": $0.words] as [String: Any] }
            }
        }
    }

    private func run<T: Sendable>(
        _ call: String, _ body: @escaping @Sendable (Engine) throws -> T
    ) async throws -> T {
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
    private static func call(_ engine: Engine, _ method: String, _ arguments: [Argument]) throws
        -> JSValue
    {
        engine.context.exception = nil
        guard let result = engine.api.invokeMethod(method, withArguments: arguments.map(\.bridged))
        else {
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

    private func string(_ method: String, _ arguments: [Argument]) async throws -> String {
        try await run(method) { engine in
            let result = try Self.call(engine, method, arguments)
            guard result.isString, let string = result.toString() else {
                throw RectoCoreError.unexpectedResult(call: method, detail: "a non-string")
            }
            return string
        }
    }

    private func integer(_ method: String, _ arguments: [Argument]) async throws -> Int {
        try await run(method) { engine in
            let result = try Self.call(engine, method, arguments)
            guard result.isNumber, let number = result.toNumber(),
                let exact = Int(exactly: number.doubleValue)
            else {
                throw RectoCoreError.unexpectedResult(
                    call: method, detail: "something that is not an integer")
            }
            return exact
        }
    }

    /// An array of dictionaries, decoded **on the JS queue**.
    ///
    /// `toArray()` hands back `NSDictionary`/`NSNumber`/`NSString`, which are
    /// not `Sendable`; decoding them here means the awaiting task only ever
    /// receives the finished `[T]`. `decode` returning nil is a malformed
    /// element and throws — never a skip, because a shorter array reads as an
    /// empty document rather than a broken bridge.
    ///
    /// `call` is a seam for `lint`, whose result arrives inside a promise.
    private func array<T: Sendable>(
        _ method: String, _ arguments: [Argument],
        call transform: @escaping @Sendable (JSValue) throws -> JSValue = { $0 },
        decoding decode: @escaping @Sendable ([String: Any]) -> T?
    ) async throws -> [T] {
        try await run(method) { engine in
            let result = try transform(Self.call(engine, method, arguments))
            guard result.isArray, let elements = result.toArray() else {
                throw RectoCoreError.unexpectedResult(call: method, detail: "a non-array")
            }
            return try elements.enumerated().map { index, element in
                guard let dictionary = element as? [String: Any],
                    let decoded = decode(dictionary)
                else {
                    throw RectoCoreError.unexpectedResult(
                        call: method, detail: "a malformed element at \(index): \(element)")
                }
                return decoded
            }
        }
    }

    static func seconds(since start: DispatchTime) -> TimeInterval {
        TimeInterval(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000_000
    }
}
