//
//  MountedSwapTests.swift
//  RectoEditorTests
//
//  Showing a different document in the same window, through the whole real
//  stack: SwiftUI, a mounted `NativeTextViewWrapper`, an on-screen window and
//  first responder.
//
//  Deliberately WITHOUT `.id(documentId)`. Giving the view an identity keyed on
//  the document makes SwiftUI tear it down and build a fresh one, which is a
//  perfectly good way to switch documents and a useless way to test switching
//  them: the controller-change branch in `updateNSView` never runs, and neither
//  does the layout-manager transfer it exists for. Here one view instance is
//  kept and pointed at a different document, which is the path under test.
//

import AppKit
import Foundation
import MarkdownEngine
import SwiftUI
import Testing
@testable import RectoEditor

@MainActor
extension RealWindowTests {
@Suite("Swapping documents in a mounted window")
struct MountedSwapTests {

    /// What the host renders. Mutating it re-runs the update pass on the SAME
    /// representable rather than remounting it.
    @Observable
    @MainActor
    final class Model {
        var storage: RectoTextStorage
        var styler: MarkdownStyler
        var onCodeBlockAnchorsChange: (([RectoCodeBlockAnchor]) -> Void)?
        init(storage: RectoTextStorage, styler: MarkdownStyler) {
            self.storage = storage
            self.styler = styler
        }
    }

    private struct Host: View {
        let model: Model
        var body: some View {
            RectoEditorView(
                storage: model.storage,
                styler: model.styler,
                onCodeBlockAnchorsChange: model.onCodeBlockAnchorsChange
            )
        }
    }

    private func mount(_ storage: RectoTextStorage,
                       _ presentation: Presentation = .rich,
                       onCodeBlockAnchorsChange: (([RectoCodeBlockAnchor]) -> Void)? = nil)
        -> (WindowHarness, Model) {
        let model = Model(storage: storage,
                          styler: MarkdownStyler(presentation: presentation, theme: .twilight))
        model.onCodeBlockAnchorsChange = onCodeBlockAnchorsChange
        return (WindowHarness(Host(model: model)), model)
    }

    private func documentA() -> RectoTextStorage {
        RectoTextStorage(
            documentId: "A",
            markdown: String(repeating: "alpha bravo charlie delta echo\n", count: 60))
    }

    @Test("one view instance is kept across A -> B -> A")
    func viewIdentityIsStableAcrossSwaps() throws {
        let a = documentA()
        let b = RectoTextStorage(documentId: "B", markdown: "short\n")
        let (harness, model) = mount(a)
        defer { harness.tearDown() }

        let original = try #require(harness.editorTextView)
        harness.window.makeFirstResponder(original)

        model.storage = b
        harness.layout()
        let afterB = try #require(harness.editorTextView)
        #expect(afterB === original, "the view was remounted; the swap path never ran")

        model.storage = a
        harness.layout()
        let afterA = try #require(harness.editorTextView)
        #expect(afterA === original)
        #expect(afterA.string == a.markdown)
    }

    @Test("a non-zero selection into a long document survives the swap to a short one")
    func selectionSurvivesSwapToShorterDocument() throws {
        let a = documentA()
        let b = RectoTextStorage(documentId: "B", markdown: "short\n")
        let (harness, model) = mount(a)
        defer { harness.tearDown() }

        let textView = try #require(harness.editorTextView)
        harness.window.makeFirstResponder(textView)
        let tail = (a.markdown as NSString).length - 25
        textView.setSelectedRange(NSRange(location: tail, length: 20))
        harness.layout()

        model.storage = b
        harness.layout()

        #expect(textView.string == "short\n")
        #expect(NSMaxRange(textView.selectedRange()) <= (textView.string as NSString).length,
                "the selection still points into the document that was swapped out")
        #expect(textView.delegate != nil, "the swapped-in view has no delegate")
        #expect(textView.enclosingScrollView != nil)
    }

    @Test("each document keeps its own caret across A -> B -> A")
    func caretIsRememberedPerDocument() throws {
        let a = RectoTextStorage(documentId: "A", markdown: "alpha bravo charlie delta\n")
        let b = RectoTextStorage(documentId: "B", markdown: "one two three four five\n")
        let (harness, model) = mount(a)
        defer { harness.tearDown() }

        let textView = try #require(harness.editorTextView)
        textView.setSelectedRange(NSRange(location: 6, length: 0))
        harness.layout()

        model.storage = b
        harness.layout()
        textView.setSelectedRange(NSRange(location: 14, length: 0))
        harness.layout()

        model.storage = a
        harness.layout()
        #expect(textView.string == a.markdown)
        #expect(textView.selectedRange() == NSRange(location: 6, length: 0),
                "coming back to a document did not put the caret where it was left")
    }

    @Test("the storage, delegate and edits all follow the swapped-in document")
    func ownershipFollowsTheSwap() throws {
        let a = RectoTextStorage(documentId: "A", markdown: "document A\n")
        let b = RectoTextStorage(documentId: "B", markdown: "document B\n")
        let (harness, model) = mount(a)
        defer { harness.tearDown() }

        let textView = try #require(harness.editorTextView)
        #expect(textView.textLayoutManager?.textContentManager
                === a.controller.textContentStorage)

        model.storage = b
        harness.layout()

        #expect(textView.string == "document B\n")
        #expect(textView.textLayoutManager?.textContentManager
                === b.controller.textContentStorage,
                "the view still lays out through the document it left")
        #expect(a.controller.textContentStorage.textLayoutManagers.isEmpty)
        #expect(b.controller.textView === textView)
        #expect(a.controller.isAttached == false)

        // And an edit lands in B only.
        #expect(b.apply(MarkdownTextPatch(range: NSRange(location: 10, length: 0),
                                          replacement: "!")))
        harness.layout()
        #expect(textView.string == "document B!\n")
        #expect(a.markdown == "document A\n", "the edit reached the document left behind")
    }

    @Test("the edit feed routes to the swapped-in document, not the one left behind")
    func callbacksRouteToTheCurrentDocument() throws {
        let a = RectoTextStorage(documentId: "A", markdown: "alpha\n")
        let b = RectoTextStorage(documentId: "B", markdown: "bravo\n")
        final class Box { var a: [MarkdownTextMutation] = []; var b: [MarkdownTextMutation] = [] }
        let box = Box()
        a.onEdit = { box.a.append($0) }
        b.onEdit = { box.b.append($0) }

        let (harness, model) = mount(a)
        defer { harness.tearDown() }
        let textView = try #require(harness.editorTextView)

        model.storage = b
        harness.layout()
        harness.window.makeFirstResponder(textView)
        textView.insertText("!", replacementRange: NSRange(location: 5, length: 0))
        harness.layout()

        #expect(box.b.count == 1, "the edit did not reach the document on screen")
        #expect(box.a.isEmpty, "the edit reached the document that was swapped out")
    }

    @Test("each document has its own undo manager")
    func undoManagersArePerDocument() throws {
        let a = RectoTextStorage(documentId: "A", markdown: "alpha\n")
        let b = RectoTextStorage(documentId: "B", markdown: "bravo\n")
        let managerA = UndoManager()
        let managerB = UndoManager()
        a.controller.undoManager = managerA
        b.controller.undoManager = managerB

        let (harness, model) = mount(a)
        defer { harness.tearDown() }
        let textView = try #require(harness.editorTextView)
        // Through the delegate, not `textView.undoManager`: that property comes
        // from the responder chain, and the engine's contract is
        // `undoManager(for:)` — which is what AppKit's text system asks.
        func vended() -> UndoManager? {
            (textView.delegate as? NativeTextViewCoordinator)?.undoManager(for: textView)
        }
        #expect(vended() === managerA)

        model.storage = b
        harness.layout()
        #expect(vended() === managerB,
                "the window still vends the outgoing document's undo manager")
        #expect(managerA !== managerB)
    }

    @Test("a swap to an empty document is safe")
    func swapToEmptyDocument() throws {
        let a = RectoTextStorage(documentId: "A", markdown: "alpha bravo charlie\n")
        let empty = RectoTextStorage(documentId: "empty", markdown: "")
        let (harness, model) = mount(a)
        defer { harness.tearDown() }

        let textView = try #require(harness.editorTextView)
        harness.window.makeFirstResponder(textView)
        textView.setSelectedRange(NSRange(location: 6, length: 5))
        harness.layout()

        model.storage = empty
        harness.layout()

        #expect(textView.string == "")
        #expect(textView.selectedRange() == NSRange(location: 0, length: 0))
    }

    @Test("switching presentation in a single window is allowed")
    func soleWindowMaySwitchPresentation() throws {
        let storage = RectoTextStorage(documentId: "lens", markdown: "## Section\n\nBody.\n")
        let (harness, model) = mount(storage, .rich)
        defer { harness.tearDown() }
        let textView = try #require(harness.editorTextView)
        let richMarker = textView.textStorage?
            .attribute(.font, at: 0, effectiveRange: nil) as? NSFont
        #expect((richMarker?.pointSize ?? 99) < 1, "rich did not collapse the `##`")
        harness.window.makeFirstResponder(textView)
        let selection = NSRange(location: 12, length: 4)
        textView.setSelectedRange(selection)

        model.styler = MarkdownStyler(presentation: .raw, theme: .twilight)
        harness.layout()

        #expect(textView.string == "## Section\n\nBody.\n", "the source must survive a lens switch")
        let rawMarker = textView.textStorage?
            .attribute(.font, at: 0, effectiveRange: nil) as? NSFont
        #expect((rawMarker?.pointSize ?? 0) > 1, "the lens did not switch to raw")
        // The engine's rebuild collapses the selection to the document end;
        // the view carries it across.
        #expect(textView.selectedRange() == selection)

        model.styler = MarkdownStyler(presentation: .rich, theme: .twilight)
        harness.layout()

        #expect(textView.selectedRange() == selection)
    }

    /// About 2k words under 40 headings: several screens tall in an 800×900
    /// window, in either presentation. With frontmatter, rich shows the header
    /// above the sheet and raw does not, so the scroll view changes height
    /// across the switch.
    private func longDocument(frontmatter: Bool) -> RectoTextStorage {
        let paragraph = String(
            repeating: "alpha bravo charlie delta echo foxtrot golf hotel india juliet ", count: 5)
        let body = (1...40).map { "## Section \($0)\n\n\(paragraph)\n" }.joined(separator: "\n")
        let markdown = frontmatter ? "---\ntitle: Sediment\n---\n\n" + body : body
        return RectoTextStorage(documentId: "long", markdown: markdown)
    }

    private func caretIsOnScreen(_ storage: RectoTextStorage) -> Bool {
        guard let textView = storage.textView.nsTextView,
              let caret = storage.textView.caretRect() else { return false }
        let visible = textView.visibleRect
        return caret.minY < visible.maxY && caret.maxY > visible.minY
    }

    @Test("switching through vim carries the selection like raw does")
    func vimSwitchCarriesSelection() throws {
        let storage = RectoTextStorage(documentId: "vim-lens", markdown: "## Section\n\nBody.\n")
        let (harness, model) = mount(storage, .rich)
        defer { harness.tearDown() }
        let textView = try #require(harness.editorTextView)
        harness.window.makeFirstResponder(textView)
        let selection = NSRange(location: 12, length: 4)
        textView.setSelectedRange(selection)

        for presentation in [Presentation.vim, .raw, .vim, .rich] {
            model.styler = MarkdownStyler(presentation: presentation, theme: .twilight)
            harness.layout()
            #expect(textView.string == "## Section\n\nBody.\n", "\(presentation) must not touch the source")
            #expect(textView.selectedRange() == selection, "\(presentation) dropped the selection")
            let marker = textView.textStorage?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont
            #expect(((marker?.pointSize ?? 0) > 1) == presentation.showsSource, "\(presentation) marker")
        }
    }

    @Test("a caret on screen at the end of a long document stays on screen across rich → raw → rich",
          arguments: [false, true])
    func presentationSwitchKeepsVisibleCaretOnScreen(frontmatter: Bool) throws {
        let storage = longDocument(frontmatter: frontmatter)
        let (harness, model) = mount(storage, .rich)
        defer { harness.tearDown() }
        let textView = try #require(harness.editorTextView)
        harness.window.makeFirstResponder(textView)
        let end = NSRange(location: (textView.string as NSString).length, length: 0)
        textView.setSelectedRange(end)
        #expect(storage.textView.scroll(range: end))
        harness.layout()
        #expect(caretIsOnScreen(storage), "precondition: the caret is on screen before the switch")
        let before = textView.visibleRect.minY

        for presentation in [Presentation.raw, .vim, .rich] {
            model.styler = MarkdownStyler(presentation: presentation, theme: .twilight)
            harness.layout()
            #expect(textView.selectedRange() == end)
            #expect(caretIsOnScreen(storage), "\(presentation) left the caret off screen")
        }
        #expect(textView.visibleRect.minY == before, "the round trip must land where it started")
    }

    @Test("a caret near the bottom edge stays on screen across repeated switches", arguments: [false, true])
    func presentationSwitchKeepsCaretNearBottomOnScreen(frontmatter: Bool) throws {
        let storage = longDocument(frontmatter: frontmatter)
        let (harness, model) = mount(storage, .rich)
        defer { harness.tearDown() }
        let textView = try #require(harness.editorTextView)
        harness.window.makeFirstResponder(textView)
        let caret = NSRange(location: (textView.string as NSString).range(of: "## Section 20").location, length: 0)
        textView.setSelectedRange(caret)
        #expect(storage.textView.scroll(range: caret))
        harness.layout()
        // Park the caret line just above the bottom edge: the case where a
        // rebuild with different line heights pushes it under the fold.
        let scrollView = try #require(textView.enclosingScrollView)
        let line = try #require(harness.textViewRect(forCharacterRange: caret))
        scrollView.contentView.scroll(to: NSPoint(x: 0, y: line.maxY + 4 - textView.visibleRect.height))
        scrollView.reflectScrolledClipView(scrollView.contentView)
        harness.layout()
        #expect(caretIsOnScreen(storage), "precondition: the caret is on screen before the switch")

        for presentation in [Presentation.raw, .rich, .raw, .rich] {
            model.styler = MarkdownStyler(presentation: presentation, theme: .twilight)
            harness.layout()
            #expect(textView.selectedRange() == caret)
            #expect(caretIsOnScreen(storage), "\(presentation) left the caret off screen")
        }
    }

    @Test("a selection scrolled off screen before the switch is not pulled back", arguments: [false, true])
    func presentationSwitchLeavesOffScreenSelectionAlone(frontmatter: Bool) throws {
        let storage = longDocument(frontmatter: frontmatter)
        let (harness, model) = mount(storage, .rich)
        defer { harness.tearDown() }
        let textView = try #require(harness.editorTextView)
        let scrollView = try #require(textView.enclosingScrollView)
        harness.window.makeFirstResponder(textView)
        let selection = NSRange(location: (textView.string as NSString).length - 20, length: 5)
        textView.setSelectedRange(selection)
        #expect(storage.textView.scroll(range: selection))
        harness.layout()
        scrollView.contentView.scroll(to: .zero)
        scrollView.reflectScrolledClipView(scrollView.contentView)
        harness.layout()
        #expect(!caretIsOnScreen(storage), "precondition: the selection is off screen")
        let viewportHeight = textView.visibleRect.height

        for presentation in [Presentation.raw, .rich] {
            model.styler = MarkdownStyler(presentation: presentation, theme: .twilight)
            harness.layout()
            #expect(textView.selectedRange() == selection)
            #expect(!caretIsOnScreen(storage), "\(presentation) pulled the selection back on screen")
            #expect(textView.visibleRect.minY < viewportHeight, "\(presentation) left the first screen")
        }
    }

    @Test("mounted theme changes replace code token colours")
    func mountedThemeChangeRestylesCode() throws {
        let storage = RectoTextStorage(
            documentId: "theme",
            markdown: "```swift\nlet answer = 42\n```\n"
        )
        let (harness, model) = mount(storage)
        defer { harness.tearDown() }
        let textView = try #require(harness.editorTextView)
        let token = (textView.string as NSString).range(of: "answer").location
        let dark = try #require(
            textView.textStorage?.attribute(.foregroundColor, at: token, effectiveRange: nil)
                as? NSColor
        )

        model.styler = MarkdownStyler(theme: .paper)
        harness.layout()

        let light = try #require(
            textView.textStorage?.attribute(.foregroundColor, at: token, effectiveRange: nil)
                as? NSColor
        )
        #expect(light != dark)
    }

    @Test("a window appearance flip is not a restyle; the theme decides light or dark")
    func windowAppearanceDoesNotRestyleCode() throws {
        let storage = RectoTextStorage(
            documentId: "appearance",
            markdown: "```swift\nlet answer = 42\n```\n"
        )
        let (harness, model) = mount(storage)
        defer { harness.tearDown() }
        #expect(model.styler.engineConfiguration().services.syntaxHighlighter
            .appearanceDidChangeNotification == nil)
        let textView = try #require(harness.editorTextView)
        let token = (textView.string as NSString).range(of: "answer").location
        let before = try #require(
            textView.textStorage?.attribute(.foregroundColor, at: token, effectiveRange: nil)
                as? NSColor
        )
        var restyles = 0
        let observer = NotificationCenter.default.addObserver(
            forName: NSTextStorage.didProcessEditingNotification,
            object: textView.textStorage, queue: nil
        ) { _ in restyles += 1 }
        defer { NotificationCenter.default.removeObserver(observer) }

        harness.window.appearance = NSAppearance(named: .aqua)
        harness.layout()

        let after = textView.textStorage?
            .attribute(.foregroundColor, at: token, effectiveRange: nil) as? NSColor
        #expect(after == before)
        #expect(restyles == 0, "an appearance flip restyled the document \(restyles) time(s)")
    }

    @Test("code-block selections follow mounted document switches")
    func codeBlockSelectionsFollowDocumentSwitches() {
        final class Box { var selections: [RectoCodeBlockAnchor] = [] }
        let box = Box()
        let a = RectoTextStorage(
            documentId: "code-a",
            markdown: "intro\n\n```swift\nlet a = 1\n```\n"
        )
        let b = RectoTextStorage(
            documentId: "code-b",
            markdown: "intro\n\n```python\nb = 2\n```\n"
        )
        let (harness, model) = mount(a) { box.selections = $0 }
        harness.editorTextView?.setSelectedRange(NSRange(location: 0, length: 0))
        harness.layout()
        #expect(box.selections.contains {
            $0.language == "swift" && $0.code.contains("let a")
        })

        model.storage = b
        harness.layout()
        #expect(box.selections.contains {
            $0.language == "python" && $0.code.contains("b = 2")
        })
        #expect(!box.selections.contains { $0.language == "swift" })

        harness.tearDown()
        #expect(box.selections.isEmpty)
    }
}
}
