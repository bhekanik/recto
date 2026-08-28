//
//  SingleViewTests.swift
//  RectoEditorTests
//
//  One storage drives one editor view, and two windows on a document are two
//  storages kept in step by forwarding edits between them.
//
//  This is the mounted view of that: real windows, real update passes, and
//  assertions that hold in RELEASE too — where the engine's debug assertions do
//  not fire and only behaviour is left.
//

import AppKit
import Foundation
import MarkdownEngine
import SwiftUI
import Testing
@testable import RectoEditor

@MainActor
extension RealWindowTests {
@Suite("One view per storage, mounted")
struct SingleViewTests {

    private static let source = "## Section\n\nBody text.\n"

    @Observable
    @MainActor
    final class Model {
        var presentation: Presentation
        init(presentation: Presentation) { self.presentation = presentation }
    }

    /// One editor, whose presentation the test can change.
    private struct Host: View {
        let storage: RectoTextStorage
        let model: Model
        var body: some View {
            RectoEditorView(
                storage: storage,
                styler: MarkdownStyler(presentation: model.presentation, theme: .twilight))
        }
    }

    /// The composition mistake: two editors wired to one storage.
    private struct TwoEditorHost: View {
        let storage: RectoTextStorage
        var body: some View {
            VStack(spacing: 0) {
                RectoEditorView(storage: storage,
                                styler: MarkdownStyler(presentation: .rich, theme: .twilight))
                RectoEditorView(storage: storage,
                                styler: MarkdownStyler(presentation: .rich, theme: .twilight))
            }
        }
    }

    @Observable
    @MainActor
    final class RemountModel {
        var identity = 0
    }

    @MainActor
    final class AttachmentLog {
        var states: [Bool] = []
        func record(_ seam: RectoTextView?) { states.append(seam != nil) }
    }

    @Observable
    @MainActor
    final class LifecycleModel {
        var showsFirst = true
        var showsSecond = false
    }

    private struct LifecycleHost: View {
        let storage: RectoTextStorage
        let model: LifecycleModel
        let first: AttachmentLog
        let second: AttachmentLog
        var body: some View {
            VStack(spacing: 0) {
                if model.showsFirst {
                    RectoEditorView(
                        storage: storage,
                        styler: MarkdownStyler(presentation: .rich, theme: .twilight),
                        onAttach: first.record
                    )
                }
                if model.showsSecond {
                    RectoEditorView(
                        storage: storage,
                        styler: MarkdownStyler(presentation: .rich, theme: .twilight),
                        onAttach: second.record
                    )
                }
            }
        }
    }

    private struct RemountHost: View {
        let storage: RectoTextStorage
        let model: RemountModel
        let original: AttachmentLog
        let replacement: AttachmentLog
        var body: some View {
            RectoEditorView(
                storage: storage,
                styler: MarkdownStyler(presentation: .rich, theme: .twilight),
                onAttach: model.identity == 0 ? original.record : replacement.record
            )
            .id(model.identity)
        }
    }

    // MARK: - A second editor on one storage reaches nothing

    @Test("a second editor on one storage never joins the document")
    func secondEditorIsRefused() throws {
        let storage = RectoTextStorage(documentId: "single", markdown: Self.source)
        let harness = WindowHarness(TwoEditorHost(storage: storage))
        defer { harness.tearDown() }
        harness.layout()

        let views = harness.allViews.compactMap { $0 as? NSTextView }
        #expect(views.count == 2, "the host did not mount two editors")
        let attached = try #require(storage.controller.textView)
        let refused = try #require(views.first { $0 !== attached })

        #expect(storage.controller.textContentStorage.textLayoutManagers.count == 1,
                "the refused editor put a second layout manager on the document")

        // It cannot write the document, and it is not written to.
        refused.insertText("!", replacementRange: NSRange(location: 0, length: 0))
        #expect(storage.markdown == Self.source, "the refused editor edited the document")
        #expect(attached.string == Self.source)

        let range = (storage.markdown as NSString).range(of: "Body")
        #expect(storage.apply(MarkdownTextPatch(range: range, replacement: "Text")))
        harness.layout()
        #expect(attached.string.contains("Text text."))
    }

    @Test("the refused editor's typing never reaches the edit feed")
    func refusedEditorDoesNotPublish() throws {
        let storage = RectoTextStorage(documentId: "single", markdown: Self.source)
        var edits: [MarkdownTextMutation] = []
        storage.onEdit = { edits.append($0) }
        let harness = WindowHarness(TwoEditorHost(storage: storage))
        defer { harness.tearDown() }
        harness.layout()

        let attached = try #require(storage.controller.textView)
        let refused = try #require(
            harness.allViews.compactMap { $0 as? NSTextView }.first { $0 !== attached })

        refused.insertText("!", replacementRange: NSRange(location: 0, length: 0))
        harness.layout()

        #expect(edits.isEmpty, "a refused editor published an edit as if it were the reader's")
        #expect(storage.markdown == Self.source)
    }

    @Test("unmount clears the view-scoped attachment observer")
    func unmountClearsAttachmentObserver() {
        let storage = RectoTextStorage(documentId: "single", markdown: Self.source)
        let model = LifecycleModel()
        let first = AttachmentLog()
        let second = AttachmentLog()
        let harness = WindowHarness(
            LifecycleHost(storage: storage, model: model, first: first, second: second))
        defer { harness.tearDown() }

        #expect(first.states == [true])
        model.showsFirst = false
        harness.layout()

        #expect(first.states == [true, false])
        #expect(storage.controller.onAttach == nil,
                "Recto left a consumer callback retained on the controller")
    }

    @Test("a refused second view cannot replace the first view's observer")
    func refusedViewDoesNotReplaceAttachmentObserver() {
        let storage = RectoTextStorage(documentId: "single", markdown: Self.source)
        let model = LifecycleModel()
        let first = AttachmentLog()
        let second = AttachmentLog()
        let harness = WindowHarness(
            LifecycleHost(storage: storage, model: model, first: first, second: second))
        defer { harness.tearDown() }

        model.showsSecond = true
        harness.layout()
        #expect(first.states == [true])
        #expect(second.states == [false],
                "the refused view reported the first view's seam as its own")

        model.showsSecond = false
        harness.layout()
        #expect(first.states == [true],
                "the refused view's teardown changed the first view's attachment")
        #expect(second.states == [false])

        model.showsFirst = false
        harness.layout()
        #expect(first.states == [true, false],
                "the refused view replaced the first view's detach observer")
    }

    @Test("a remount notifies the old and replacement observers independently")
    func remountKeepsAttachmentObserversScoped() {
        let storage = RectoTextStorage(documentId: "single", markdown: Self.source)
        let model = RemountModel()
        let original = AttachmentLog()
        let replacement = AttachmentLog()
        let harness = WindowHarness(
            RemountHost(storage: storage, model: model,
                        original: original, replacement: replacement))
        defer { harness.tearDown() }

        #expect(original.states == [true])
        model.identity = 1
        harness.layout()

        #expect(storage.controller.isAttached)
        #expect(original.states == [true, false],
                "the old wrapper's teardown did not reach its own observer")
        #expect(replacement.states == [false, true],
                "the replacement did not report refusal followed by takeover")
    }

    // MARK: - The presentation switch, on the one view

    private struct InputSettings: Equatable {
        let quoteSubstitution: Bool
        let dashSubstitution: Bool
        let textReplacement: Bool
        let spellingCorrection: Bool
        let smartInsertDelete: Bool

        init(_ textView: NSTextView) {
            quoteSubstitution = textView.isAutomaticQuoteSubstitutionEnabled
            dashSubstitution = textView.isAutomaticDashSubstitutionEnabled
            textReplacement = textView.isAutomaticTextReplacementEnabled
            spellingCorrection = textView.isAutomaticSpellingCorrectionEnabled
            smartInsertDelete = textView.smartInsertDeleteEnabled
        }

        static let allOff = InputSettings(
            quoteSubstitution: false, dashSubstitution: false, textReplacement: false,
            spellingCorrection: false, smartInsertDelete: false)

        private init(quoteSubstitution: Bool, dashSubstitution: Bool, textReplacement: Bool,
                     spellingCorrection: Bool, smartInsertDelete: Bool) {
            self.quoteSubstitution = quoteSubstitution
            self.dashSubstitution = dashSubstitution
            self.textReplacement = textReplacement
            self.spellingCorrection = spellingCorrection
            self.smartInsertDelete = smartInsertDelete
        }
    }

    /// Switching the lens is the ordinary single-window case, and the whole
    /// transition has to run: markers restyled and AppKit's five source
    /// rewrites off, or raw mode quietly substitutes quotes and replaces text
    /// inside Markdown source.
    @Test("switching to raw and back runs the whole transition")
    func presentationSwitchRunsTheWholeTransition() throws {
        let storage = RectoTextStorage(documentId: "single", markdown: Self.source)
        let model = Model(presentation: .rich)
        let harness = WindowHarness(Host(storage: storage, model: model))
        defer { harness.tearDown() }
        harness.layout()

        let textView = try #require(harness.editorTextView)
        textView.isAutomaticQuoteSubstitutionEnabled = true
        textView.isAutomaticDashSubstitutionEnabled = true
        textView.isAutomaticTextReplacementEnabled = true
        textView.isAutomaticSpellingCorrectionEnabled = true
        textView.smartInsertDeleteEnabled = true
        let beforeRaw = InputSettings(textView)
        let richMarker = textView.textStorage?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont
        #expect((richMarker?.pointSize ?? 99) < 1, "the heading marker is not hidden in rich")

        model.presentation = .raw
        harness.layout()

        #expect(harness.editorTextView === textView, "the switch rebuilt the whole editor")
        #expect(InputSettings(textView) == .allOff,
                "raw mode left AppKit rewriting Markdown source")
        let rawMarker = try #require(
            textView.textStorage?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)
        #expect(rawMarker.pointSize > 1, "the marker is still collapsed in raw")
        #expect(textView.string == Self.source)

        model.presentation = .rich
        harness.layout()

        #expect(InputSettings(textView) == beforeRaw,
                "leaving raw did not restore the reader's input settings")
        let backMarker = textView.textStorage?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont
        #expect((backMarker?.pointSize ?? 99) < 1, "the marker did not collapse again")
        #expect(storage.markdown == Self.source)
    }

    // MARK: - Two windows, the supported way

    /// Two windows on one document are two storages, kept in step by forwarding
    /// each one's `onEdit` into the other's `apply`. The app's `DocumentSession`
    /// integration will own that forwarding; the package needs only the two
    /// halves it already has.
    @Test("two storages on one document stay in sync when edits are forwarded")
    func twoStoragesStayInSync() throws {
        let left = RectoTextStorage(documentId: "doc", markdown: Self.source)
        let right = RectoTextStorage(documentId: "doc", markdown: Self.source)

        var forwarding = false
        func bridge(_ from: RectoTextStorage, to other: RectoTextStorage) {
            from.onEdit = { mutation in
                guard !forwarding else { return }
                forwarding = true
                defer { forwarding = false }
                other.apply(MarkdownTextPatch(range: mutation.range,
                                              replacement: mutation.replacement))
            }
        }
        bridge(left, to: right)
        bridge(right, to: left)

        // Each window has its own presentation — impossible over one storage.
        let leftHarness = WindowHarness(
            Host(storage: left, model: Model(presentation: .rich)))
        let rightHarness = WindowHarness(
            Host(storage: right, model: Model(presentation: .raw)))
        defer {
            leftHarness.tearDown()
            rightHarness.tearDown()
        }
        leftHarness.layout()
        rightHarness.layout()

        let leftView = try #require(leftHarness.editorTextView)
        let rightView = try #require(rightHarness.editorTextView)
        #expect(left.controller.textContentStorage !== right.controller.textContentStorage)

        // Typing in one window reaches the other. The forwarding itself is
        // synchronous — `onEdit` fires from `textDidChange` — so the RECEIVING
        // side is settled by the time this returns. Only the typing window's own
        // `markdown` lags: the engine writes the binding back on a later
        // run-loop turn, deliberately, because writing SwiftUI state during a
        // view update is not allowed. `ExternalEditFeedTests` covers that hop;
        // here it is driven directly, as `EditorHarness`-based tests do.
        let bodyStart = (Self.source as NSString).range(of: "Body").location
        leftView.insertText("New ", replacementRange: NSRange(location: bodyStart, length: 0))
        left.editorDidWriteBack(leftView.string)
        leftHarness.layout()
        rightHarness.layout()

        #expect(left.markdown.contains("New Body text."))
        #expect(right.markdown == left.markdown, "the second window did not receive the edit")
        #expect(rightView.string == left.markdown)

        // And back the other way.
        rightView.insertText("!", replacementRange: NSRange(location: 0, length: 0))
        right.editorDidWriteBack(rightView.string)
        rightHarness.layout()
        leftHarness.layout()

        #expect(right.markdown.hasPrefix("!"))
        #expect(left.markdown == right.markdown, "the first window did not receive the edit")
        #expect(leftView.string == right.markdown)

        // Separate carets, and the presentations stayed as they were.
        leftView.setSelectedRange(NSRange(location: 2, length: 0))
        rightView.setSelectedRange(NSRange(location: 6, length: 0))
        #expect(leftView.selectedRange() == NSRange(location: 2, length: 0))
        #expect(rightView.selectedRange() == NSRange(location: 6, length: 0))
        let rawMarker = rightView.textStorage?.attribute(.font, at: 1, effectiveRange: nil) as? NSFont
        #expect((rawMarker?.pointSize ?? 0) > 1, "the raw window was restyled as rich")
    }
}
}
