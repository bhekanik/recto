import Foundation
import JavaScriptCore
import os

public enum VimError: Error, CustomStringConvertible {
    case bundleMissing(String)
    case bundleLoadFailed(String)
    case missingGlobal
    case javaScript(call: String, message: String)
    case unexpectedResult(call: String, detail: String)

    public var description: String {
        switch self {
        case .bundleMissing(let hint):
            return "recto-vim.js is missing from the package resources. \(hint)"
        case .bundleLoadFailed(let message):
            return "loading recto-vim.js failed: \(message)"
        case .missingGlobal:
            return "recto-vim.js evaluated but did not define globalThis.RectoVim"
        case .javaScript(let call, let message):
            return "RectoVim.\(call) threw: \(message)"
        case .unexpectedResult(let call, let detail):
            return "RectoVim.\(call) returned \(detail)"
        }
    }
}

/// Owns the `JSContext` and is the only thing that talks to it.
///
/// ## Threading — main, and forced rather than chosen
///
/// `JSContext` is not thread-safe and every call here mutates vim state, so the
/// engine is confined to one thread. That thread is the main one because
/// `keyDown` has to know *synchronously* whether vim consumed the key before it
/// returns; it cannot await a background actor. This is affordable because a
/// keystroke is one call with no I/O — p50 0.05 ms, p95 0.10 ms on a 10k-word
/// document (`RectoVimPerfTests`). Do not move it off-main "for safety": you
/// would gain nothing and lose the synchronous answer.
///
/// That is the opposite of `RectoCoreJS`, which runs on its own serial queue —
/// its calls are whole-document and slow, and nothing waits on them inline.
@MainActor
public final class VimEngine {
    private let context: JSContext
    private let host: VimHost

    /// Cached function references. Looking a property up on a `JSValue` is a
    /// bridge crossing of its own; doing it once at load instead of three times
    /// per keystroke is free performance.
    private let functions: Functions
    private let decoder = JSONDecoder()

    /// Bundle version, `<package version>+<git short sha>`.
    public let version: String
    /// How long `evaluateScript` took; ~3 ms.
    public let loadDuration: TimeInterval

    private static let log = Logger(subsystem: "com.bhekani.recto", category: "RectoVim")

    private struct Functions {
        let initialise: JSValue
        let handleKey: JSValue
        let promptKey: JSValue
        let setCursor: JSValue
        let setText: JSValue
        let getText: JSValue
        let getState: JSValue
        let insertText: JSValue
        let setExternalInput: JSValue
        let map: JSValue
        let noremap: JSValue
        let unmap: JSValue
        let setOption: JSValue
        let getOption: JSValue
        let exitInsertMode: JSValue
        let saveState: JSValue
        let restoreState: JSValue
    }

    public init(bundleURL: URL? = nil, host: VimHost) throws {
        let url = try bundleURL ?? Self.bundledScriptURL()
        guard let context = JSContext() else {
            throw VimError.bundleLoadFailed("JSContext() returned nil")
        }
        self.context = context
        self.host = host

        // The vim bundle has no console prelude of its own (unlike recto-core),
        // and the core calls `console.log` when an ex command errors. Without
        // this that is a ReferenceError inside a keystroke.
        let emit: @convention(block) (String) -> Void = { message in
            Self.log.debug("[js] \(message, privacy: .public)")
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

        let source: String
        do {
            source = try String(contentsOf: url, encoding: .utf8)
        } catch {
            throw VimError.bundleLoadFailed("\(url.lastPathComponent): \(error)")
        }

        let start = DispatchTime.now()
        context.evaluateScript(source, withSourceURL: url)
        loadDuration = Self.seconds(since: start)

        if let thrown { throw VimError.bundleLoadFailed(thrown) }
        guard let api = context.objectForKeyedSubscript("RectoVim"), !api.isUndefined else {
            throw VimError.missingGlobal
        }
        func member(_ name: String) throws -> JSValue {
            guard let value = api.objectForKeyedSubscript(name), !value.isUndefined else {
                throw VimError.unexpectedResult(call: name, detail: "undefined")
            }
            return value
        }
        functions = Functions(
            initialise: try member("init"),
            handleKey: try member("handleKey"),
            promptKey: try member("promptKey"),
            setCursor: try member("setCursor"),
            setText: try member("setText"),
            getText: try member("getText"),
            getState: try member("getState"),
            insertText: try member("insertText"),
            setExternalInput: try member("setExternalInput"),
            map: try member("map"),
            noremap: try member("noremap"),
            unmap: try member("unmap"),
            setOption: try member("setOption"),
            getOption: try member("getOption"),
            exitInsertMode: try member("exitInsertMode"),
            saveState: try member("saveState"),
            restoreState: try member("restoreState"))

        guard let versionValue = api.objectForKeyedSubscript("version"), versionValue.isString,
            let version = versionValue.toString()
        else {
            throw VimError.unexpectedResult(call: "version", detail: "a non-string")
        }
        self.version = version
        Self.log.info(
            "loaded recto-vim \(version, privacy: .public) in \(self.loadDuration * 1000, format: .fixed(precision: 1)) ms"
        )
    }

    public static func bundledScriptURL() throws -> URL {
        guard
            let url = Bundle.module.url(
                forResource: "recto-vim", withExtension: "js", subdirectory: "JS")
        else {
            throw VimError.bundleMissing(
                "Run `bun install && bun run vim:build && apple/scripts/copy-js-bundles.sh`.")
        }
        return url
    }

    // MARK: - Session

    @discardableResult
    public func start(text: String) throws -> VimResult {
        try decode("init", functions.initialise.call(withArguments: [text, host]))
    }

    /// One keystroke.
    ///
    /// `key` is a DOM `KeyboardEvent.key` name because that is what the core's
    /// own `vimKeyFromEvent` expects — letting it do the naming keeps `<C-w>`
    /// spelling in one place instead of duplicating it in Swift and drifting
    /// from the web.
    @discardableResult
    public func handleKey(_ key: String, modifiers: VimModifiers = []) throws -> VimResult {
        try decode(
            "handleKey", functions.handleKey.call(withArguments: [key, modifiers.rawValue]))
    }

    /// A key typed into an open `:` or `/` line, when the host routes those
    /// itself rather than letting them fall through `handleKey`.
    @discardableResult
    public func promptKey(_ key: String, modifiers: VimModifiers = []) throws -> VimResult {
        try decode("promptKey", functions.promptKey.call(withArguments: [key, modifiers.rawValue]))
    }

    /// Hand text input to the host's own input system instead of synthesising it
    /// from key names.
    ///
    /// A `keyDown` event carries one key name; real text input does not. NFD
    /// arrives as a base letter and a combining mark, an emoji as several
    /// scalars, a dead key as a composition, an IME as marked text rewritten
    /// before it commits. With this on, the engine declines printable keys in
    /// insert mode and waits for `insertText`.
    public func setExternalInput(_ enabled: Bool) {
        functions.setExternalInput.call(withArguments: [enabled])
    }

    /// Text the host's input system produced, as one transaction: the mirror is
    /// updated, the core sees the change so `.` can replay it, and the resulting
    /// edit comes back for the host to apply. The host must not have inserted
    /// the text itself first.
    ///
    /// `from`/`to` are UTF-16 offsets for a replacement range — AppKit and UIKit
    /// both supply one when committing over marked text.
    @discardableResult
    public func insertText(_ text: String, from: Int? = nil, to: Int? = nil) throws -> VimResult {
        var arguments: [Any] = [text]
        if let from {
            arguments.append(from)
            arguments.append(to ?? from)
        }
        return try decode("insertText", functions.insertText.call(withArguments: arguments))
    }

    /// Place the caret. `ch` is a UTF-16 column.
    @discardableResult
    public func setCursor(line: Int, column: Int) throws -> VimResult {
        try decode("setCursor", functions.setCursor.call(withArguments: [line, column]))
    }

    /// Adopt text the host changed while vim was idle — typing with the lens
    /// off, a sync landing, an undo. No edits come back for this.
    @discardableResult
    public func setText(_ text: String, anchor: Int, head: Int) throws -> VimResult {
        try decode("setText", functions.setText.call(withArguments: [text, anchor, head]))
    }

    @discardableResult
    public func exitInsertMode() throws -> VimResult {
        try decode("exitInsertMode", functions.exitInsertMode.call(withArguments: []))
    }

    /// The engine's copy of the buffer. Should always equal the text view's; the
    /// adapter tests assert that after every fixture.
    public func text() -> String {
        functions.getText.call(withArguments: [])?.toString() ?? ""
    }

    public func state() throws -> VimResult {
        try decode("getState", functions.getState.call(withArguments: []))
    }

    // MARK: - Configuration

    /// `:map` — recursive, so the right-hand side is itself remapped.
    public func map(_ lhs: String, to rhs: String, context: VimMapContext? = nil) {
        functions.map.call(withArguments: arguments(lhs, rhs, context))
    }

    /// `:noremap` — the right-hand side is taken literally.
    public func noremap(_ lhs: String, to rhs: String, context: VimMapContext? = nil) {
        functions.noremap.call(withArguments: arguments(lhs, rhs, context))
    }

    public func unmap(_ lhs: String, context: VimMapContext? = nil) {
        var arguments: [Any] = [lhs]
        if let context { arguments.append(context.rawValue) }
        functions.unmap.call(withArguments: arguments)
    }

    /// A vim option (`:set`). Values are strings, numbers or booleans.
    public func setOption(_ name: String, _ value: Any, context: VimOptionScope? = nil) {
        var arguments: [Any] = [name, value]
        if let context { arguments.append(context.rawValue) }
        functions.setOption.call(withArguments: arguments)
    }

    public func option(_ name: String, context: VimOptionScope? = nil) -> String? {
        var arguments: [Any] = [name]
        if let context { arguments.append(context.rawValue) }
        let value = functions.getOption.call(withArguments: arguments)
        guard let value, !value.isUndefined, !value.isNull else { return nil }
        return value.toString()
    }

    private func arguments(_ lhs: String, _ rhs: String, _ context: VimMapContext?) -> [Any] {
        var arguments: [Any] = [lhs, rhs]
        if let context { arguments.append(context.rawValue) }
        return arguments
    }

    // MARK: - Persistence

    /// Named registers and marks, as JSON.
    ///
    /// Deliberately not the whole vim state: mode, pending keys and search
    /// history are session-scoped and restoring them would resume the user
    /// mid-command. Registers are global to the `JSContext` — that is vim's own
    /// model, and it is why two documents in one context share them.
    public func saveState() -> String {
        functions.saveState.call(withArguments: [])?.toString() ?? "{}"
    }

    public func restoreState(_ json: String) {
        functions.restoreState.call(withArguments: [json])
    }

    // MARK: - Bridge

    /// Every crossing goes through here. A JS throw leaves the exception
    /// standing on the context, so clearing it before and after is what keeps
    /// one failure from being reported against the next keystroke.
    private func decode(_ call: String, _ value: JSValue?) throws -> VimResult {
        if let exception = context.exception {
            context.exception = nil
            throw VimError.javaScript(
                call: call, message: exception.toString() ?? "an unreadable exception")
        }
        guard let value, !value.isUndefined, !value.isNull, let json = value.toString(),
            let data = json.data(using: .utf8)
        else {
            throw VimError.unexpectedResult(call: call, detail: "no JSON")
        }
        do {
            return try decoder.decode(VimResult.self, from: data)
        } catch {
            throw VimError.unexpectedResult(call: call, detail: "undecodable JSON: \(error)")
        }
    }

    static func seconds(since start: DispatchTime) -> TimeInterval {
        TimeInterval(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000_000
    }
}

/// Which modes a mapping applies in, as `:map`'s third argument names them.
public enum VimMapContext: String, Sendable {
    case normal
    case visual
    case insert
}

/// `:set` scope. `local` is per buffer, `global` is per session.
public enum VimOptionScope: String, Sendable {
    case local
    case global
}

public struct VimModifiers: OptionSet, Sendable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }

    public static let control = VimModifiers(rawValue: 1)
    public static let option = VimModifiers(rawValue: 2)
    public static let command = VimModifiers(rawValue: 4)
    public static let shift = VimModifiers(rawValue: 8)
}
