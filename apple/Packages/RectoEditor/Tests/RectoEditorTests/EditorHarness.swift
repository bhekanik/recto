//
//  EditorHarness.swift
//  RectoEditorTests
//
//  A live editor without SwiftUI: a real NSTextView driven by the engine's
//  coordinator, so the patch and performance tests exercise the shipping edit
//  path (shouldChangeText -> replaceCharacters -> didChangeText) rather than a
//  parallel one.
//

import AppKit
import MarkdownEngine
@testable import RectoEditor

@MainActor
struct EditorHarness {
    let storage: RectoTextStorage
    let textView: NSTextView
    let coordinator: NativeTextViewCoordinator

    init(markdown: String, presentation: Presentation = .rich, documentId: String = "test") {
        _ = NSApplication.shared
        let styler = MarkdownStyler(presentation: presentation, theme: .twilight)
        storage = RectoTextStorage(documentId: documentId, markdown: markdown)
        let wrapper = NativeTextViewWrapper(
            text: .constant(markdown),
            configuration: styler.engineConfiguration(),
            controller: storage.controller,
            fontName: styler.typography.family,
            fontSize: styler.typography.resolvedSize,
            documentId: documentId,
            isEditable: presentation.isEditable
        )
        coordinator = wrapper.makeCoordinator()
        textView = NSTextView(frame: NSRect(x: 0, y: 0, width: 720, height: 900))
        textView.isEditable = presentation.isEditable
        // `adopt` wires the delegate, styles the document and attaches the
        // controller the wrapper was given — the same seams makeNSView sets up.
        coordinator.adopt(textView, text: markdown)
    }
}
