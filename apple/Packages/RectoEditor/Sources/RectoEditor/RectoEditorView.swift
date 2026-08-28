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

    /// - Parameter onAttach: Called with a handle bound to THIS view when it
    ///   appears, and `nil` when it goes. Find, a vim key layer, typewriter
    ///   scrolling and focus dimming all act on the window the reader is in, so
    ///   they need this rather than `storage.textView`, which resolves to
    ///   whichever view attached last.
    public init(storage: RectoTextStorage, styler: MarkdownStyler,
                placeholder: String? = nil,
                onAttach: ((RectoTextView?) -> Void)? = nil) {
        self.storage = storage
        self.styler = styler
        self.placeholder = placeholder
        self.onAttach = onAttach
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let header { DocumentHeaderView(frontmatter: header, styler: styler) }
            editor
        }
        .background(Color(nsColor: styler.theme.sheet))
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
        .onAppear { announceAttachment() }
        .onDisappear { onAttach?(nil) }
    }

    /// The engine attaches its text view during `makeNSView`, which SwiftUI
    /// runs before `onAppear`, so by here there is a view to bind to.
    private func announceAttachment() {
        guard let onAttach else { return }
        onAttach(storage.controller.textView.map {
            RectoTextView(controller: storage.controller, view: $0)
        })
    }

    private var placeholderText: NSAttributedString? {
        guard let placeholder else { return nil }
        return NSAttributedString(string: placeholder, attributes: [
            .font: styler.typography.bodyFont,
            .foregroundColor: styler.theme.ink3,
        ])
    }
}

public extension RectoTextStorage {
    /// The AppKit seam for the document's CURRENT view.
    ///
    /// Right when the document is open in one window. When it is open in
    /// several, anything acting on "the window the reader is in" — find, a vim
    /// key layer, typewriter scrolling, focus dimming — must take the
    /// view-bound handle `RectoEditorView` hands it through `onAttach` instead.
    var textView: RectoTextView { RectoTextView(controller: controller) }

    /// A seam bound to one specific view of this document.
    func textView(for view: NSTextView) -> RectoTextView {
        RectoTextView(controller: controller, view: view)
    }
}
