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

    public init(storage: RectoTextStorage, styler: MarkdownStyler, placeholder: String? = nil) {
        self.storage = storage
        self.styler = styler
        self.placeholder = placeholder
    }

    public var body: some View {
        NativeTextViewWrapper(
            text: Binding(
                get: { storage.markdown },
                // The engine writes the binding back after each edit; the
                // storage takes it as already-applied. The edit DESCRIPTORS
                // the undo tree and the sync outbox want come separately,
                // through onTextMutation.
                set: { storage.editorDidWriteBack($0) }
            ),
            configuration: styler.engineConfiguration(),
            controller: storage.controller,
            fontName: styler.typography.family,
            fontSize: styler.typography.resolvedSize,
            documentId: storage.documentId,
            isEditable: styler.presentation.isEditable,
            onTextMutation: { storage.editorDidMutate($0) },
            placeholder: placeholderText
        )
        .background(Color(nsColor: styler.theme.sheet))
    }

    private var placeholderText: NSAttributedString? {
        guard let placeholder else { return nil }
        return NSAttributedString(string: placeholder, attributes: [
            .font: styler.typography.bodyFont,
            .foregroundColor: styler.theme.ink3,
        ])
    }
}

/// The AppKit seam for a document — hand this to anything that needs the real
/// text view (find, vim, typewriter, a caret-anchored popover).
public extension RectoTextStorage {
    var textView: RectoTextView { RectoTextView(controller: controller) }
}
