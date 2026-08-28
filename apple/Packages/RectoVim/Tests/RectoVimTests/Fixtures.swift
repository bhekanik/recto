import Foundation
import Testing

@testable import RectoVim

/// `packages/recto-vim-js/fixtures/keystroke-suite.json`, read from the source
/// tree rather than copied into the test bundle.
///
/// Copying would mean a second place for it to go stale, and the whole point is
/// that Bun and JavaScriptCore run *the same bytes*: a divergence between the
/// two suites is then a bridge bug, not a vim bug.
enum Fixtures {
    static let repositoryRoot: URL = {
        // …/apple/Packages/RectoVim/Tests/RectoVimTests/Fixtures.swift
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        return url.deletingLastPathComponent()
    }()

    static var bundleURL: URL {
        repositoryRoot.appending(path: "packages/recto-vim-js/dist/recto-vim.js")
    }

    static func suite() throws -> KeystrokeSuite {
        let url = repositoryRoot.appending(
            path: "packages/recto-vim-js/fixtures/keystroke-suite.json")
        return try JSONDecoder().decode(KeystrokeSuite.self, from: Data(contentsOf: url))
    }

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

struct KeystrokeSuite: Decodable {
    struct Case: Decodable {
        let name: String
        let text: String
        let cursor: [Int]
        let keys: String
        let expectText: String
        let expectCursor: [Int]?
        let expectMode: String?
        /// Why an expectation diverges from real vim, where one does.
        let note: String?
    }
    let cases: [Case]
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

    func performHistory(_ kind: String) -> (text: String, anchor: Int, head: Int)? {
        let target: Snapshot?
        if kind == "undo" {
            target = undoStack.popLast()
            if let target { redoStack.append(capture()); _ = target }
        } else {
            target = redoStack.popLast()
            if target != nil { undoStack.append(capture()) }
        }
        guard let target else { return nil }
        return (target.text, target.anchor, target.head)
    }
}

/// Parses the fixture's vim-style key strings.
///
/// Mirrors `test/harness.ts`'s `parseKeys` exactly, including the rule that `<<`
/// is two `<` keys rather than one malformed group — the two suites read the
/// same file, so a parser that disagreed would make them test different things.
enum VimKeys {
    private static let named: [String: String] = [
        "CR": "Enter", "Enter": "Enter", "Esc": "Escape", "BS": "Backspace",
        "Del": "Delete", "Space": " ", "Tab": "Tab", "Left": "ArrowLeft",
        "Right": "ArrowRight", "Up": "ArrowUp", "Down": "ArrowDown", "lt": "<",
    ]

    static func parse(_ spec: String) -> [(key: String, modifiers: VimModifiers)] {
        var out: [(String, VimModifiers)] = []
        let characters = Array(spec)
        var i = 0
        while i < characters.count {
            if characters[i] == "<", let close = characters[i...].firstIndex(of: ">"),
                let body = groupBody(String(characters[(i + 1)..<close]))
            {
                out.append(body)
                i = close + 1
                continue
            }
            let character = String(characters[i])
            // An uppercase letter is Shift on a real keyboard, and the core
            // checks `shiftKey` when naming chords.
            let shifted = character.count == 1 && character.first?.isUppercase == true
                && character.first?.isLetter == true
            out.append((character, shifted ? .shift : []))
            i += 1
        }
        return out
    }

    /// nil when the body is not a chord or a key name, so `<` stays literal.
    private static func groupBody(_ body: String) -> (String, VimModifiers)? {
        var modifiers: VimModifiers = []
        var rest = Substring(body)
        while rest.count > 2, rest.dropFirst().first == "-",
            let prefix = rest.first, "CAMS".contains(prefix)
        {
            switch prefix {
            case "C": modifiers.insert(.control)
            case "A": modifiers.insert(.option)
            case "M": modifiers.insert(.command)
            default: modifiers.insert(.shift)
            }
            rest = rest.dropFirst(2)
        }
        guard let first = rest.first, first.isLetter,
            rest.allSatisfy({ $0.isLetter || $0.isNumber })
        else { return nil }
        return (named[String(rest)] ?? String(rest), modifiers)
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
