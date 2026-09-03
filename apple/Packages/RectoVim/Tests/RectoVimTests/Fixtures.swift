import Foundation
import RectoVimFixtures
import Testing

@testable import RectoVim

/// Engines over the built bundle, for the suites.
enum Fixtures {
    static var bundleURL: URL { KeystrokeSuite.bundleURL }

    static func suite() throws -> KeystrokeSuite { try KeystrokeSuite.load() }

    /// An engine over the built bundle, with a snapshot-based undo host.
    @MainActor
    static func engine() throws -> (VimEngine, SnapshotHistory, VimHost) {
        guard FileManager.default.fileExists(atPath: bundleURL.path) else {
            throw MissingBundle()
        }
        let host = VimHost()
        let engine = try VimEngine(bundleURL: bundleURL, host: host)
        let history = SnapshotHistory(engine: engine)
        host.historyProvider = history
        // Keep the suite off the real pasteboard: `"+` and `"*` would otherwise
        // clobber whatever the developer had copied.
        var clipboard = ""
        host.pasteboardRead = { clipboard }
        host.pasteboardWrite = { clipboard = $0 }
        return (engine, history, host)
    }

    struct MissingBundle: Error, CustomStringConvertible {
        var description: String {
            "packages/recto-vim-js/dist/recto-vim.js is missing — run `bun run vim:build`"
        }
    }
}

/// The host's undo, modelled as a snapshot stack.
///
/// In the product `u` runs the document's undo tree, not vim's own history, so
/// the host performs the change and hands the resulting buffer back. This is the
/// smallest thing with that shape, and it is enough to prove the round trip and
/// the `resynced` path — the same model `test/harness.ts` uses on the JS side, so
/// both suites exercise the same contract.
@MainActor
final class SnapshotHistory: VimHistoryProvider {
    private struct Snapshot {
        let text: String
        let anchor: Int
        let head: Int
    }

    private unowned let engine: VimEngine
    private var undoStack: [Snapshot] = []
    private var redoStack: [Snapshot] = []
    private var pending: Snapshot?

    init(engine: VimEngine) {
        self.engine = engine
    }

    private func capture() -> Snapshot {
        let state = try? engine.state()
        let selection = state?.primarySelection ?? VimSelection(anchor: 0, head: 0)
        return Snapshot(text: engine.text(), anchor: selection.anchor, head: selection.head)
    }

    /// Remember where we were, in case this key turns out to change something.
    func beginKey() {
        pending = capture()
    }

    /// Commit an undo entry only if the key actually edited: a key that merely
    /// moved the caret must not push a state, or `u` would appear to do nothing.
    /// A resync is the host's own undo coming back and is never re-recorded.
    func endKey(_ result: VimResult) {
        if let pending, !result.edits.isEmpty, !result.resynced {
            undoStack.append(pending)
            redoStack.removeAll()
        }
        pending = nil
    }

    func performHistory(_ kind: String) -> VimHistoryResult? {
        let target: Snapshot?
        if kind == "undo" {
            target = undoStack.popLast()
            if target != nil { redoStack.append(capture()) }
        } else {
            target = redoStack.popLast()
            if target != nil { undoStack.append(capture()) }
        }
        guard let target else { return nil }
        // A snapshot host has no patch, so it reports the caret it saved. The
        // adapters carry the real range; this only has to prove the round trip.
        return VimHistoryResult(text: target.text, patchStart: target.anchor)
    }
}

/// Compare by UTF-16 code unit; Swift's `String ==` is canonical equivalence and
/// would accept `e` + U+0301 where the fixture holds a precomposed `é`.
func sameCodeUnits(_ a: String, _ b: String) -> Bool {
    a.utf16.elementsEqual(b.utf16)
}

func describe(_ value: String) -> String {
    let units = value.utf16.map { String(format: "%04x", $0) }.joined(separator: " ")
    return "\(value.debugDescription) [\(units)]"
}

/// `[line, ch]` for a UTF-16 offset, matching the fixture's cursor convention.
func position(of offset: Int, in text: String) -> [Int] {
    let string = text as NSString
    let head = string.substring(to: min(max(offset, 0), string.length))
    let line = head.components(separatedBy: "\n").count - 1
    let lastBreak = (head as NSString).range(of: "\n", options: .backwards)
    let column = lastBreak.location == NSNotFound ? offset : offset - NSMaxRange(lastBreak)
    return [line, column]
}
