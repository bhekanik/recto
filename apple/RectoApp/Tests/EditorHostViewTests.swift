import AppKit
import RectoEditor
import SwiftUI
import Testing
@testable import Recto

@Suite("Document editor")
@MainActor
struct EditorHostViewTests {
    @Test("accepted editor input updates the file document binding")
    func editorInputUpdatesDocument() async throws {
        _ = NSApplication.shared
        let original = "# Hello, 世界\r\n\r\n[link](https://example.com) and `code`\r\n"
        var document = RectoDocument(markdown: original)
        let storage = RectoTextStorage(documentId: "binding-test", markdown: document.markdown)
        var storageSnapshotsAtDocumentWrite: [String] = []
        let binding = Binding(
            get: { document },
            set: {
                storageSnapshotsAtDocumentWrite.append(storage.markdown)
                document = $0
            }
        )
        let host = NSHostingView(rootView: EditorHostView(document: binding, storage: storage))
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }

        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        #expect(window.makeFirstResponder(textView))
        textView.setSelectedRange(NSRange(location: (storage.markdown as NSString).length, length: 0))
        textView.insertText("Edited ✅\r\n", replacementRange: textView.selectedRange())
        await drainMainQueue()

        #expect(storage.markdown == original + "Edited ✅\r\n")
        #expect(document.markdown == storage.markdown)
        #expect(storageSnapshotsAtDocumentWrite == [storage.markdown])
    }

    @Test("read-only document configurations mount a non-editable editor")
    func readOnlyDocumentIsNotEditable() async throws {
        _ = NSApplication.shared
        var document = RectoDocument(markdown: "# Read only\n")
        let storage = RectoTextStorage(documentId: "read-only-test", markdown: document.markdown)
        let host = NSHostingView(rootView: EditorHostView(
            document: Binding(get: { document }, set: { document = $0 }),
            isEditable: false,
            storage: storage
        ))
        let window = NSWindow(contentViewController: NSViewController())
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }

        host.layoutSubtreeIfNeeded()
        await drainMainQueue()

        #expect(try #require(storage.textView.nsTextView).isEditable == false)
    }

    private func drainMainQueue() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async {
                continuation.resume()
            }
        }
    }
}
