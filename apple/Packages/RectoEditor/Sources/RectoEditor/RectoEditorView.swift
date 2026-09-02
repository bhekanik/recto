//
//  RectoEditorView.swift
//  RectoEditor
//

import AppKit
import MarkdownEngine
import SwiftUI

/// The editor, as SwiftUI sees it.
///
/// ```swift
/// RectoEditorView(storage: session.storage, styler: styler)
/// ```
///
/// The `NSViewRepresentable` is the engine's own `NativeTextViewWrapper`: it
/// builds the TextKit 2 stack, the scroll container and the layout-fragment
/// subclass that draws bullets, task boxes and code backgrounds, and its
/// coordinator is the `NSTextViewDelegate`. Re-implementing that here to own
/// the representable would mean re-implementing all of it. This view supplies
/// Recto's configuration and routes edits through ``RectoTextStorage``.
public struct RectoEditorView: View {
    private let storage: RectoTextStorage
    private let styler: MarkdownStyler
    private let placeholder: String?

    private let onAttach: ((RectoTextView?) -> Void)?
    private let onTextChange: ((String) -> Void)?
    private let onEdit: ((RectoEditorEdit) -> Void)?
    private let onCodeBlockAnchorsChange: (([RectoCodeBlockAnchor]) -> Void)?
    private let writingController: RectoWritingController?
    @State private var caretCarrier = PresentationCaretCarrier()

    /// - Parameter onAttach: Called with the AppKit seam when the editor
    ///   appears, and `nil` when it goes — the moment to install find, a vim key
    ///   layer or typewriter scrolling, rather than polling `storage.textView`.
    /// - Parameter onTextChange: Called after storage accepts an editor write.
    public init(storage: RectoTextStorage, styler: MarkdownStyler,
                placeholder: String? = nil,
                onAttach: ((RectoTextView?) -> Void)? = nil,
                onTextChange: ((String) -> Void)? = nil,
                onEdit: ((RectoEditorEdit) -> Void)? = nil,
                onCodeBlockAnchorsChange: (([RectoCodeBlockAnchor]) -> Void)? = nil,
                writingController: RectoWritingController? = nil) {
        self.storage = storage
        self.styler = styler
        self.placeholder = placeholder
        self.onAttach = onAttach
        self.onTextChange = onTextChange
        self.onEdit = onEdit
        self.onCodeBlockAnchorsChange = onCodeBlockAnchorsChange
        self.writingController = writingController
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let header { DocumentHeaderView(frontmatter: header, styler: styler) }
            editor
        }
        .background(Color(nsColor: styler.theme.sheet))
        .onAppear {
            writingController?.update(storage: storage, presentation: styler.presentation)
        }
        .onChange(of: styler.presentation) { _, presentation in
            caretCarrier.restore(into: storage.textView)
            writingController?.update(storage: storage, presentation: presentation)
        }
        .onDisappear {
            onCodeBlockAnchorsChange?([])
        }
    }

    /// The frontmatter to render above the sheet, or `nil`.
    ///
    /// Raw shows the block as source, so there is nothing to lift out of it
    /// there. Rich and preview hide it from the body, which is exactly why the
    /// header has to exist: without it the reader's title would disappear.
    private var header: Frontmatter? {
        guard styler.presentation != .raw,
              let frontmatter = storage.frontmatter,
              DocumentHeaderView.hasVisibleFields(frontmatter) else { return nil }
        return frontmatter
    }

    private var editor: some View {
        caretCarrier.prepare(for: styler.presentation, in: storage.textView)
        return NativeTextViewWrapper(
            text: Binding(
                get: { storage.markdown },
                // The engine writes the binding back after each edit; the
                // storage takes it as already-applied. The edit descriptors
                // the undo tree and the sync outbox want come separately,
                // through onTextMutation.
                set: { markdown in
                    if storage.editorDidWriteBack(markdown) {
                        publishAcceptedEdit()
                    }
                }
            ),
            configuration: styler.engineConfiguration(),
            styleRevision: styler.theme.styleRevision,
            controller: storage.controller,
            fontName: styler.typography.family,
            fontSize: styler.typography.resolvedSize,
            documentId: storage.documentId,
            isEditable: styler.presentation.isEditable,
            onAttachmentChange: attachmentObserver,
            onTextMutation: { mutation in
                if storage.editorDidMutate(mutation) {
                    publishAcceptedEdit()
                }
            },
            onCodeBlockSelectionChange: { selections in
                onCodeBlockAnchorsChange?(selections.map(RectoCodeBlockAnchor.init))
            },
            placeholder: placeholderText
        )
    }

    private var attachmentObserver: (NSTextView?) -> Void {
        let controller = storage.controller
        return { [weak controller] textView in
            storage.observeAcceptedChanges(in: textView) { markdown, structural in
                onTextChange?(markdown)
                onEdit?(RectoEditorEdit(markdown: markdown, structural: structural))
            }
            guard let controller, textView != nil else {
                writingController?.attach(nil)
                onAttach?(nil)
                return
            }
            let seam = RectoTextView(controller: controller)
            writingController?.update(storage: storage, presentation: styler.presentation)
            writingController?.attach(seam)
            onAttach?(seam)
        }
    }

    private func publishAcceptedEdit() {
        onTextChange?(storage.markdown)
        onEdit?(RectoEditorEdit(
            markdown: storage.markdown,
            structural: storage.currentEditIsStructural
        ))
    }

    private var placeholderText: NSAttributedString? {
        guard let placeholder else { return nil }
        return NSAttributedString(string: placeholder, attributes: [
            .font: styler.typography.bodyFont,
            .foregroundColor: styler.theme.ink3,
        ])
    }
}

/// The caret across a rich ⇄ raw switch.
///
/// The engine answers a presentation change with a whole-document rebuild of
/// the attributed string, and AppKit treats that as one edit spanning the
/// document, so the selection collapses to the end. SwiftUI evaluates `body`
/// before the representable updates and runs `onChange` after it, which gives
/// this one place to read the caret and one to put it back.
///
/// The scroll offset is kept in pixels across the rebuild while raw and rich
/// line heights differ, and at the document end the rebuild clamps it upward,
/// so a caret that was on screen ends up below or above the fold. The carrier
/// scrolls it back only if it was on screen: a writer who had scrolled away
/// from the caret on purpose keeps their place.
///
/// The scroll waits one run-loop turn. Rich shows the frontmatter header above
/// the sheet and raw does not, so on raw → rich the scroll view is still at
/// its raw height inside `onChange`; a scroll measured against that bottom
/// lands the caret under the header's 60 pt once layout runs.
@MainActor
private final class PresentationCaretCarrier {
    private var presentation: Presentation?
    private var carried: (range: NSRange, text: String, wasOnScreen: Bool)?

    /// Called from `body`: remembers the selection when the presentation is
    /// about to change on a mounted view.
    func prepare(for presentation: Presentation, in editor: RectoTextView) {
        defer { self.presentation = presentation }
        guard let previous = self.presentation, previous != presentation,
              let textView = editor.nsTextView else { return }
        let range = textView.selectedRange()
        carried = (range, textView.string, Self.isOnScreen(range, in: editor))
    }

    /// Called from `onChange`: puts the selection back if the rebuild left the
    /// text as it was. Any other text means an edit landed in between, and its
    /// caret wins.
    func restore(into editor: RectoTextView) {
        guard let carried, let textView = editor.nsTextView else { return }
        self.carried = nil
        guard RectoTextStorage.hasSameUTF16(textView.string, carried.text) else { return }
        textView.setSelectedRange(carried.range)
        guard carried.wasOnScreen else { return }
        let (range, text) = (carried.range, carried.text)
        RunLoop.main.perform {
            MainActor.assumeIsolated {
                guard let textView = editor.nsTextView,
                      RectoTextStorage.hasSameUTF16(textView.string, text) else { return }
                editor.scroll(range: range, position: .nearest)
            }
        }
    }

    /// Whether any line of the selection is inside the viewport. A caret has
    /// no selection rects, so it is judged by its own rect.
    private static func isOnScreen(_ range: NSRange, in editor: RectoTextView) -> Bool {
        guard let textView = editor.nsTextView else { return false }
        let visible = textView.visibleRect
        let rects = range.length == 0
            ? editor.caretRect().map { [$0] } ?? []
            : editor.rects(forSourceRange: range)
        return rects.contains { $0.minY < visible.maxY && $0.maxY > visible.minY }
    }
}

public struct RectoEditorEdit: Equatable, Sendable {
    public let markdown: String
    public let structural: Bool

    public init(markdown: String, structural: Bool) {
        self.markdown = markdown
        self.structural = structural
    }
}

public extension RectoTextStorage {
    /// The AppKit seam for this storage's editor.
    var textView: RectoTextView { RectoTextView(controller: controller) }
}
