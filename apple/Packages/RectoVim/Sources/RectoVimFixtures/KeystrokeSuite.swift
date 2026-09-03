import Foundation
import RectoVim

/// `packages/recto-vim-js/fixtures/keystroke-suite.json`, read from the source
/// tree rather than copied into a test bundle.
///
/// Copying would mean a second place for it to go stale, and the whole point is
/// that Bun, JavaScriptCore and every Swift host run *the same bytes*: a
/// divergence between suites is then a bridge bug, not a vim bug. This target
/// exists so the RectoVim suites and the RectoEditor suite share one loader and
/// one key parser instead of each carrying a copy.
public struct KeystrokeSuite: Decodable, Sendable {
    public struct Case: Decodable, Sendable {
        public let name: String
        public let text: String
        public let cursor: [Int]
        public let keys: String
        public let expectText: String
        public let expectCursor: [Int]?
        public let expectMode: String?
        /// Why an expectation diverges from real vim, where one does.
        public let note: String?
    }

    public let cases: [Case]

    /// The repository checkout this source file lives in.
    public static let repositoryRoot: URL = {
        // …/apple/Packages/RectoVim/Sources/RectoVimFixtures/KeystrokeSuite.swift
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        return url.deletingLastPathComponent()
    }()

    /// The built bundle in the source tree (`bun run vim:build`), which is what
    /// the suites load so they exercise the exact bytes the app ships.
    public static var bundleURL: URL {
        repositoryRoot.appending(path: "packages/recto-vim-js/dist/recto-vim.js")
    }

    public static var fixtureURL: URL {
        repositoryRoot.appending(path: "packages/recto-vim-js/fixtures/keystroke-suite.json")
    }

    public static func load() throws -> KeystrokeSuite {
        try JSONDecoder().decode(KeystrokeSuite.self, from: Data(contentsOf: fixtureURL))
    }
}

/// Parses the fixture's vim-style key strings.
///
/// Mirrors `test/harness.ts`'s `parseKeys` exactly, including the rule that `<<`
/// is two `<` keys rather than one malformed group — the suites read the same
/// file, so a parser that disagreed would make them test different things.
public enum VimKeys {
    public struct Key: Sendable, Equatable {
        /// DOM `KeyboardEvent.key` name, as `VimEngine.handleKey` takes it.
        public let key: String
        public let modifiers: VimModifiers
    }

    private static let named: [String: String] = [
        "CR": "Enter", "Enter": "Enter", "Esc": "Escape", "BS": "Backspace",
        "Del": "Delete", "Space": " ", "Tab": "Tab", "Left": "ArrowLeft",
        "Right": "ArrowRight", "Up": "ArrowUp", "Down": "ArrowDown", "lt": "<",
    ]

    public static func parse(_ spec: String) -> [Key] {
        var out: [Key] = []
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
            out.append(Key(key: character, modifiers: shifted ? .shift : []))
            i += 1
        }
        return out
    }

    /// nil when the body is not a chord or a key name, so `<` stays literal.
    private static func groupBody(_ body: String) -> Key? {
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
        return Key(key: named[String(rest)] ?? String(rest), modifiers: modifiers)
    }
}

#if canImport(AppKit)
import AppKit

public extension VimKeys.Key {
    /// This key as the `NSEvent` a keyboard would deliver, for driving a real
    /// `NSTextView.keyDown`. Function keys become their AppKit private-use
    /// scalars; control chords carry the letter in `charactersIgnoringModifiers`
    /// the way AppKit does.
    var event: NSEvent? {
        var flags: NSEvent.ModifierFlags = []
        if modifiers.contains(.control) { flags.insert(.control) }
        if modifiers.contains(.option) { flags.insert(.option) }
        if modifiers.contains(.command) { flags.insert(.command) }
        if modifiers.contains(.shift) { flags.insert(.shift) }
        let characters: String
        switch key {
        case "Enter": characters = "\r"
        case "Escape": characters = "\u{1B}"
        case "Backspace": characters = "\u{7F}"
        case "Tab": characters = "\t"
        case "Delete": characters = String(UnicodeScalar(UInt32(NSDeleteFunctionKey))!)
        case "ArrowLeft": characters = String(UnicodeScalar(UInt32(NSLeftArrowFunctionKey))!)
        case "ArrowRight": characters = String(UnicodeScalar(UInt32(NSRightArrowFunctionKey))!)
        case "ArrowUp": characters = String(UnicodeScalar(UInt32(NSUpArrowFunctionKey))!)
        case "ArrowDown": characters = String(UnicodeScalar(UInt32(NSDownArrowFunctionKey))!)
        case "Home": characters = String(UnicodeScalar(UInt32(NSHomeFunctionKey))!)
        case "End": characters = String(UnicodeScalar(UInt32(NSEndFunctionKey))!)
        case "PageUp": characters = String(UnicodeScalar(UInt32(NSPageUpFunctionKey))!)
        case "PageDown": characters = String(UnicodeScalar(UInt32(NSPageDownFunctionKey))!)
        default:
            guard key.count == 1 else { return nil }
            characters = key
        }
        return NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0,
            windowNumber: 0, context: nil, characters: characters,
            charactersIgnoringModifiers: characters, isARepeat: false, keyCode: 0)
    }
}
#endif
