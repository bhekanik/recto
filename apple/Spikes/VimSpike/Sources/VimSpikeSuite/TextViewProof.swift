import AppKit
import Foundation
import RectoVim

/// Proves the adapter against a real `NSTextView`, not just against the JS
/// mirror.
///
/// The keystroke suite drives `RectoVimEngine` directly, so it would still pass
/// if the edits never reached the text storage. This drives synthetic
/// `NSEvent`s through `VimKeyEvent` → engine → `NSTextStorage` and asserts on
/// `textView.string`, which is the path the app actually uses. It also covers
/// the two things only a text view has: an undo manager behind `u`, and the
/// caret shape.
@MainActor
enum TextViewProof {
    struct Step {
        let name: String
        let keys: String
        let expect: String
        /// Caret shape expected after the step, when it is worth checking.
        let expectMode: String?

        init(_ name: String, _ keys: String, _ expect: String, mode: String? = nil) {
            self.name = name
            self.keys = keys
            self.expect = expect
            expectMode = mode
        }
    }

    static func run() throws -> Bool {
        let document = "the quick brown fox\njumps over the lazy dog\npack my box with jugs\n"

        // A window so the text view gets a real undo manager; `u` and `<C-r>`
        // route to it, which is the spike's stand-in for the undo tree.
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 600, height: 400),
            styleMask: [.titled], backing: .buffered, defer: false
        )
        let textView = BlockCaretTextView(frame: window.contentLayoutRect)
        textView.isRichText = false
        textView.allowsUndo = true
        textView.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        textView.string = document
        window.contentView?.addSubview(textView)
        window.makeFirstResponder(textView)

        let host = RectoVimHost()
        var clipboard = ""
        host.pasteboardRead = { clipboard }
        host.pasteboardWrite = { clipboard = $0 }
        let engine = try RectoVimEngine(
            bundleURL: RectoVimEngine.bundledScriptURL(), host: host
        )
        let controller = VimTextViewController(textView: textView, engine: engine, host: host)
        var lastStatus: VimStatus?
        controller.onStatusChange = { lastStatus = $0 }
        try controller.start()

        // TextKit 2 must still be in charge; touching layoutManager anywhere
        // would have silently downgraded the stack.
        guard textView.textLayoutManager != nil else {
            print("text view proof: TextKit 2 stack was lost")
            return false
        }

        // Expectations are traced by hand from vim semantics. Two are worth
        // spelling out because they look wrong at a glance:
        //   - After `ciwslow<Esc>` the caret sits on the "w" of "slow" (Esc
        //     steps left), so the following `vll` selects "w b", not "slo".
        //   - `.` repeats the whole `dw`, so `ggdw.` removes two words.
        let steps: [Step] = [
            .init("dw", "dw",
                  "quick brown fox\njumps over the lazy dog\npack my box with jugs\n"),
            .init("ciw + text", "ciwslow<Esc>",
                  "slow brown fox\njumps over the lazy dog\npack my box with jugs\n",
                  mode: "normal"),
            .init("visual d", "vlld",
                  "slorown fox\njumps over the lazy dog\npack my box with jugs\n"),
            .init("search + n", "/o<CR>nx",
                  "slorown fx\njumps over the lazy dog\npack my box with jugs\n"),
            .init("count 3dd", "gg3dd", ""),
            .init("undo the 3dd", "u",
                  "slorown fx\njumps over the lazy dog\npack my box with jugs\n"),
            .init("redo the 3dd", "<C-r>", ""),
            .init("undo again", "u",
                  "slorown fx\njumps over the lazy dog\npack my box with jugs\n"),
            // `gg` first on purpose: after `u` the caret is wherever
            // NSUndoManager restored the selection to (offset 57, line 2 here),
            // not where vim would leave it — the start of the restored change.
            // The product's undo tree has to return a vim-shaped caret; see the
            // package README, "Undo".
            .init("ex substitute", "gg:s/fx/fox/<CR>",
                  "slorown fox\njumps over the lazy dog\npack my box with jugs\n"),
            .init("ex nohlsearch", ":noh<CR>",
                  "slorown fox\njumps over the lazy dog\npack my box with jugs\n"),
            .init("dot repeat", "ggdw.",
                  "\njumps over the lazy dog\npack my box with jugs\n"),
            .init("insert mode caret", "i",
                  "\njumps over the lazy dog\npack my box with jugs\n", mode: "insert"),
        ]

        var failures: [String] = []
        for step in steps {
            for (key, mods) in parseKeys(step.keys) {
                _ = controller.handle(syntheticEvent(key: key, mods: mods))
            }
            if textView.string != step.expect {
                failures.append(
                    "  \(step.name): \(debugString(textView.string)) != \(debugString(step.expect))"
                )
            }
            if ProcessInfo.processInfo.environment["VIMSPIKE_TRACE"] != nil {
                print("    [trace] after \(step.name): caret=\(textView.selectedRange().location) "
                    + "text=\(debugString(textView.string))")
            }
            if let wanted = step.expectMode, lastStatus?.mode != wanted {
                failures.append("  \(step.name): mode \(lastStatus?.mode ?? "nil") != \(wanted)")
            }
        }

        // The engine's mirror and the text storage must agree at the end, or a
        // later keystroke would compute offsets against the wrong buffer.
        if engine.text() != textView.string {
            failures.append("  mirror diverged from NSTextStorage")
        }

        print("text view proof: \(steps.count - failures.count)/\(steps.count) steps passing")
        for failure in failures { print(failure) }
        return failures.isEmpty
    }

    /// A key event shaped like the one AppKit delivers, so `VimKeyEvent` is
    /// exercised rather than bypassed.
    private static func syntheticEvent(key: String, mods: VimModifiers) -> NSEvent {
        var flags: NSEvent.ModifierFlags = []
        if mods.contains(.control) { flags.insert(.control) }
        if mods.contains(.option) { flags.insert(.option) }
        if mods.contains(.command) { flags.insert(.command) }
        if mods.contains(.shift) { flags.insert(.shift) }

        let characters: String
        switch key {
        case "Escape": characters = "\u{1B}"
        case "Enter": characters = "\r"
        case "Backspace": characters = "\u{7F}"
        case "Tab": characters = "\t"
        case "Delete": characters = String(UnicodeScalar(UInt32(NSDeleteFunctionKey))!)
        case "ArrowLeft": characters = String(UnicodeScalar(UInt32(NSLeftArrowFunctionKey))!)
        case "ArrowRight": characters = String(UnicodeScalar(UInt32(NSRightArrowFunctionKey))!)
        case "ArrowUp": characters = String(UnicodeScalar(UInt32(NSUpArrowFunctionKey))!)
        case "ArrowDown": characters = String(UnicodeScalar(UInt32(NSDownArrowFunctionKey))!)
        default: characters = key
        }

        return NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: flags,
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: 0,
            context: nil,
            characters: characters,
            charactersIgnoringModifiers: characters,
            isARepeat: false,
            keyCode: 0
        )!
    }
}
