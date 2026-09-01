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
    private let writingController: RectoWritingController?

    /// - Parameter onAttach: Called with the AppKit seam when the editor
    ///   appears, and `nil` when it goes — the moment to install find, a vim key
    ///   layer or typewriter scrolling, rather than polling `storage.textView`.
    /// - Parameter onTextChange: Called after storage accepts an editor write.
    public init(storage: RectoTextStorage, styler: MarkdownStyler,
                placeholder: String? = nil,
                onAttach: ((RectoTextView?) -> Void)? = nil,
                onTextChange: ((String) -> Void)? = nil,
                onEdit: ((RectoEditorEdit) -> Void)? = nil,
                writingController: RectoWritingController? = nil) {
        self.storage = storage
        self.styler = styler
        self.placeholder = placeholder
        self.onAttach = onAttach
        self.onTextChange = onTextChange
        self.onEdit = onEdit
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
            writingController?.update(storage: storage, presentation: presentation)
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
        NativeTextViewWrapper(
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
