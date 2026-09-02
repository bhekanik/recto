#if canImport(UIKit)
import Foundation
import UIKit

import RectoVimFixtures
@testable import RectoVim

/// A `UITextView` in a key window, wired to an engine over the built bundle.
///
/// The window and `becomeFirstResponder` are not decoration: `UIResponder`
/// resolves `undoManager` through the responder chain, so a detached text view
/// has none and `u` silently does nothing.
///
/// UIKit has no `BlockCaretTextView` equivalent to hook, so the three handoffs
/// the adapter cannot observe for itself — a settled selection, a composition,
/// and an edit made by something other than vim — are the host's to call. That
/// is the contract these tests exercise.
@MainActor
final class UITextViewHarness {
    let window: UIWindow
    let textView: UITextView
    let engine: VimEngine
    let adapter: VimUITextViewAdapter
    var failures: [VimReplayFailure] = []
    private var clipboard = ""

    init(_ text: String) throws {
        window = UIWindow(frame: CGRect(x: 0, y: 0, width: 600, height: 400))
        textView = UITextView(frame: window.bounds)
        textView.text = text
        window.addSubview(textView)
        window.makeKeyAndVisible()
        textView.becomeFirstResponder()

        let host = VimHost()
        engine = try VimEngine(bundleURL: Fixtures.bundleURL, host: host)
        adapter = VimUITextViewAdapter(textView: textView, engine: engine, host: host)
        host.pasteboardRead = { [unowned self] in clipboard }
        host.pasteboardWrite = { [unowned self] in clipboard = $0 }
        try adapter.start()
        adapter.onReplayFailure = { [unowned self] in failures.append($0) }
    }

    /// Vim keys first; a printable one vim declines is text input, which on a
    /// real device the keyboard produces and the subclass forwards.
    func press(_ spec: String) {
        for key in VimKeys.parse(spec) {
            if adapter.handle(key: key.key, modifiers: key.modifiers) { continue }
            guard key.key.count == 1, !key.modifiers.contains(.control),
                !key.modifiers.contains(.command)
            else { continue }
            adapter.insertText(key.key)
        }
    }

    /// A cursor key insert mode declines: UIKit moves the selection itself and
    /// the host reports it from `textViewDidChangeSelection(_:)`.
    func moveCaret(to location: Int) {
        textView.selectedRange = NSRange(location: location, length: 0)
        adapter.selectionDidChangeExternally()
    }

    /// An edit made by something other than vim, announced the way the host has
    /// to announce it: before the mutation, then after.
    func externalInsert(_ text: String, at location: Int) {
        adapter.willChangeTextExternally()
        guard let start = textView.position(from: textView.beginningOfDocument, offset: location),
            let range = textView.textRange(from: start, to: start)
        else { return }
        textView.replace(range, withText: text)
        try? adapter.syncFromTextView()
        // With `groupsByEvent` on, `UndoManager` opens a group for the
        // registration and closes it when the event ends. A test has no event
        // loop, so without this pass the next vim group nests inside the external
        // one and a single `u` takes both.
        RunLoop.current.run(until: Date())
    }
}
#endif
