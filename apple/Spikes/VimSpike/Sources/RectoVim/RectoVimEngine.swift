import Foundation
import JavaScriptCore

public enum RectoVimError: Error {
    case bundleMissing
    case bundleDidNotDefineGlobal
    case javascript(String)
}

/// Owns the `JSContext` and is the only thing that talks to it.
///
/// Threading: a `JSContext` is not thread-safe, and every call here mutates vim
/// state, so the engine is confined to one thread. Key handling has to be
/// synchronous with `keyDown` anyway — the text view needs to know whether the
/// key was consumed before it returns — so that thread is the main one. This is
/// affordable because a keystroke is a single call with no I/O; see the README
/// for the measured cost.
@MainActor
public final class RectoVimEngine {
    private let context: JSContext
    private let host: RectoVimHost
    private let decoder = JSONDecoder()

    /// Cached function references. Looking a property up on a `JSValue` is a
    /// bridge crossing; doing it once per keystroke instead of three times is
    /// free performance.
    private let handleKeyFn: JSValue
    private let setCursorFn: JSValue
    private let getTextFn: JSValue
    private let getStateFn: JSValue
    private let setTextFn: JSValue
    private let initFn: JSValue

    public private(set) var loadDuration: TimeInterval = 0

    public init(bundleURL: URL, host: RectoVimHost) throws {
        guard let context = JSContext() else { throw RectoVimError.bundleMissing }
        self.context = context
        self.host = host

        var thrown: String?
        context.exceptionHandler = { _, value in
            thrown = value?.toString() ?? "unknown JS exception"
        }

        let start = DispatchTime.now()
        let source = try String(contentsOf: bundleURL, encoding: .utf8)
        context.evaluateScript(source, withSourceURL: bundleURL)
        loadDuration = Self.seconds(since: start)

        if let thrown { throw RectoVimError.javascript(thrown) }
        guard let global = context.objectForKeyedSubscript("RectoVim"),
              !global.isUndefined
        else { throw RectoVimError.bundleDidNotDefineGlobal }

        initFn = global.objectForKeyedSubscript("init")
        handleKeyFn = global.objectForKeyedSubscript("handleKey")
        setCursorFn = global.objectForKeyedSubscript("setCursor")
        getTextFn = global.objectForKeyedSubscript("getText")
        getStateFn = global.objectForKeyedSubscript("getState")
        setTextFn = global.objectForKeyedSubscript("setText")
    }

    /// Convenience for the app and the suite, which both ship the same resource.
    public static func bundledScriptURL() throws -> URL {
        guard let url = Bundle.module.url(forResource: "recto-vim", withExtension: "js") else {
            throw RectoVimError.bundleMissing
        }
        return url
    }

    @discardableResult
    public func start(text: String) throws -> VimResult {
        try decode(initFn.call(withArguments: [text, host]))
    }

    @discardableResult
    public func setCursor(line: Int, ch: Int) throws -> VimResult {
        try decode(setCursorFn.call(withArguments: [line, ch]))
    }

    /// One keystroke. `key` is a DOM `KeyboardEvent.key` name so that the vim
    /// core does its own key naming — see `VimKeyEvent`.
    @discardableResult
    public func handleKey(_ key: String, mods: VimModifiers = []) throws -> VimResult {
        try decode(handleKeyFn.call(withArguments: [key, mods.rawValue]))
    }

    /// Adopt text the host changed while vim was idle (typing with the lens
    /// off, a sync landing, an undo). No edits come back for this.
    @discardableResult
    public func setText(_ text: String, anchor: Int, head: Int) throws -> VimResult {
        try decode(setTextFn.call(withArguments: [text, anchor, head]))
    }

    public func text() -> String {
        getTextFn.call(withArguments: [])?.toString() ?? ""
    }

    public func state() throws -> VimResult {
        try decode(getStateFn.call(withArguments: []))
    }

    private func decode(_ value: JSValue?) throws -> VimResult {
        guard let json = value?.toString(), let data = json.data(using: .utf8) else {
            throw RectoVimError.javascript("handleKey returned nothing")
        }
        return try decoder.decode(VimResult.self, from: data)
    }

    /// Shared by the benchmark in VimSpikeSuite.
    public static func seconds(since start: DispatchTime) -> TimeInterval {
        TimeInterval(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000_000
    }
}

public struct VimModifiers: OptionSet, Sendable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }

    public static let control = VimModifiers(rawValue: 1)
    public static let option = VimModifiers(rawValue: 2)
    public static let command = VimModifiers(rawValue: 4)
    public static let shift = VimModifiers(rawValue: 8)
}
