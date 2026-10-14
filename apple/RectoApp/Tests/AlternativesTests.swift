import AppKit
import RectoCore
import RectoEditor
import RectoHistory
@testable import RectoStore
import SwiftUI
import Testing
@testable import Recto

@Suite("Alternatives", .serialized)
@MainActor
struct AlternativesTests {
    private let draft = "Much of the tension in design."

    private func open() async throws -> CloudDocumentModel {
        _ = NSApplication.shared
        let store = try RectoStore.inMemory()
        let library = DocumentLibrary(store: store, sync: nil, origin: "alternatives-test")
        let document = try await library.createDocument(title: "Alternatives")
        let registry = DocumentSessionRegistry(store: store, sync: nil, origin: "alternatives-test")
        let model = try await CloudDocumentModel.open(localId: document.localId, registry: registry)
        model.storage.markdown = draft
        model.accept(RectoEditorEdit(markdown: draft, structural: true))
        await model.save()
        return model
    }

    @Test("a wording previews in place, refuses typing until kept, keeps as one undo step, and restores")
    func previewKeepUndo() async throws {
        let model = try await open()
        let tension = (draft as NSString).range(of: "tension")
        await model.addAlternative("pressure", at: tension)
        let group = try #require(model.writing.alternatives.first)
        #expect(group.candidates.map(\.text) == ["tension", "pressure"])
        #expect(model.storage.markdown == draft)

        model.showAlternative(group.candidates[1].id, in: group.id)
        #expect(model.storage.markdown == "Much of the pressure in design.")
        // Typing over a preview is refused, not recorded as an edit of the original.
        model.accept(RectoEditorEdit(markdown: "Much of the pressureX in design.", structural: false), from: model.storage)
        #expect(model.storage.markdown == "Much of the pressure in design.")
        #expect(model.pendingEditCount == 0)

        await model.keepAlternative()
        #expect(model.preview == nil)
        #expect(model.state.markdown == "Much of the pressure in design.")
        #expect(model.writing.alternatives.first?.isOnOriginal == false)

        await model.undo()
        #expect(model.storage.markdown == draft)
        #expect(model.writing.alternatives.first?.isOnOriginal == true)

        model.showAlternative(group.candidates[1].id, in: group.id)
        model.restoreAlternative()
        #expect(model.storage.markdown == draft)
        #expect(model.state.markdown == draft)
        await model.close()
    }

    @Test("the panel's arrows step through wordings and Escape restores the start")
    func panelKeys() async throws {
        let model = try await open()
        let tension = (draft as NSString).range(of: "tension")
        await model.addAlternative("pressure", at: tension)
        await model.addAlternative("strain", at: tension)
        var closed = false
        let host = NSHostingView(rootView: AlternativesPanel(model: model, theme: .twilight, range: tension) { closed = true })
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 500), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }
        host.layoutSubtreeIfNeeded()
        for _ in 0..<5 { await Task.yield() }
        let field = try #require(Self.textField(in: host))
        #expect(window.makeFirstResponder(field))
        func key(_ characters: String, _ code: UInt16) -> NSEvent? {
            NSEvent.keyEvent(
                with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber, context: nil, characters: characters,
                charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code)
        }
        let arrow = String(UnicodeScalar(NSDownArrowFunctionKey)!)
        window.sendEvent(try #require(key(arrow, 125)))
        #expect(await Self.until { model.storage.markdown == "Much of the pressure in design." })
        window.sendEvent(try #require(key(arrow, 125)))
        #expect(await Self.until { model.storage.markdown == "Much of the strain in design." }, "shown: \(model.storage.markdown)")
        window.sendEvent(try #require(key("\u{1b}", 53)))
        #expect(await Self.until { model.storage.markdown == draft })
        #expect(closed)
        await model.close()
    }

    private static func until(_ condition: () -> Bool) async -> Bool {
        for _ in 0..<60 {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(16))
        }
        return condition()
    }

    private static func textField(in view: NSView) -> NSTextField? {
        if let field = view as? NSTextField, field.isEditable { return field }
        for child in view.subviews { if let found = textField(in: child) { return found } }
        return nil
    }
}
