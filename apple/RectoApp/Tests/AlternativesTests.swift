import AppKit
import RectoCore
import RectoEditor
import RectoHistory
import RectoSync
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
        await model.addAlternative("pressure", at: tension, scope: .word)
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
        await model.addAlternative("pressure", at: tension, scope: .word)
        await model.addAlternative("strain", at: tension, scope: .word)
        var closed = false
        let host = NSHostingView(rootView: AlternativesPanel(model: model, theme: .twilight, targets: AlternativesTargets(ranges: [.word: tension], initial: .word)) { closed = true })
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

    @Test("a wording that changes the vowel sound fixes a/an in the same undo step")
    func article() async throws {
        let model = try await open()
        let source = "Like a thumbtack, for example."
        model.storage.markdown = source
        model.accept(RectoEditorEdit(markdown: source, structural: true))
        await model.save()
        await model.addAlternative("eraser", at: (source as NSString).range(of: "thumbtack"), scope: .word)
        let group = try #require(model.writing.alternatives.first)
        model.showAlternative(group.candidates[1].id, in: group.id)
        #expect(await Self.until { model.storage.markdown == "Like an eraser, for example." }, "shown: \(model.storage.markdown)")
        await model.keepAlternative()
        #expect(model.state.markdown == "Like an eraser, for example.")
        #expect((model.state.markdown as NSString).substring(with: try #require(model.writing.alternatives.first).range) == "eraser")
        // Back to the original wording restores its article too.
        model.showAlternative(group.candidates[0].id, in: group.id)
        await model.keepAlternative()
        #expect(model.state.markdown == source)
        await model.undo()
        #expect(model.state.markdown == "Like an eraser, for example.")
        await model.undo()
        #expect(model.state.markdown == source)
        await model.close()
    }

    @Test("the panel finds the word, sentence and paragraph at the caret, and a sentence wording replaces the sentence")
    func scopes() async throws {
        let text = "First line here.\n\nShouldn't everything be obvious? Unless you're making a product.\n"
        let view = NSTextView()
        view.string = text
        let caret = (text as NSString).range(of: "everything").location + 2
        view.setSelectedRange(NSRange(location: caret, length: 0))
        let targets = try #require(CloudDocumentView.alternativesTargets(in: view, writing: WritingState()))
        let source = text as NSString
        #expect(source.substring(with: try #require(targets.ranges[.word])) == "everything")
        #expect(source.substring(with: try #require(targets.ranges[.sentence])) == "Shouldn't everything be obvious?")
        #expect(source.substring(with: try #require(targets.ranges[.paragraph])) == "Shouldn't everything be obvious? Unless you're making a product.")
        #expect(targets.initial == .word)

        let model = try await open()
        model.storage.markdown = text
        model.accept(RectoEditorEdit(markdown: text, structural: true))
        await model.save()
        let sentence = try #require(targets.ranges[.sentence])
        await model.addAlternative("Why isn't everything obvious?", at: sentence, scope: .sentence)
        let group = try #require(model.writing.alternatives.first)
        #expect(group.scope == .sentence)
        model.showAlternative(group.candidates[1].id, in: group.id)
        await model.keepAlternative()
        #expect(model.state.markdown == "First line here.\n\nWhy isn't everything obvious? Unless you're making a product.\n")
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

@Suite("Ghost", .serialized)
@MainActor
struct GhostTests {
    @Test("ghosting keeps the text, leaves it out for readers, revives from the caret, and undoes")
    func ghostAndRevive() async throws {
        _ = NSApplication.shared
        let store = try RectoStore.inMemory()
        let library = DocumentLibrary(store: store, sync: nil, origin: "ghost-test")
        let document = try await library.createDocument(title: "Ghost")
        let registry = DocumentSessionRegistry(store: store, sync: nil, origin: "ghost-test")
        let model = try await CloudDocumentModel.open(localId: document.localId, registry: registry)
        let draft = "Keep this. Maybe cut this. Keep that."
        model.storage.markdown = draft
        model.accept(RectoEditorEdit(markdown: draft, structural: true))
        await model.save()

        let cut = (draft as NSString).range(of: "Maybe cut this.")
        await model.toggleGhost(cut)
        #expect(model.state.markdown == draft)
        #expect(model.writing.ghosts.map(\.range) == [cut])
        #expect(model.readerMarkdown == "Keep this. Keep that.")
        let omit = ReaderOmission(markdown: draft, ranges: [cut])
        guard case let .object(fields) = omit.convexValue, case let .string(hash) = fields["markdownSha256"] else {
            Issue.record("omission did not encode as an object with a hash")
            return
        }
        #expect(hash.count == 64)
        #expect(fields["ranges"] == .array([.object(["from": .number(Double(cut.location)), "to": .number(Double(NSMaxRange(cut)))])]))

        await model.toggleGhost(NSRange(location: cut.location + 4, length: 0))
        #expect(model.writing.ghosts.isEmpty)
        #expect(model.readerMarkdown == draft)

        await model.undo()
        #expect(model.writing.ghosts.map(\.range) == [cut])
        await model.undo()
        #expect(model.writing.ghosts.isEmpty)
        await model.close()
    }
}

@Suite("Lab cuts", .serialized)
@MainActor
struct LabCutTests {
    @Test("several cuts apply as one undo step and carry ghosts and alternatives with them")
    func applyCuts() async throws {
        _ = NSApplication.shared
        let store = try RectoStore.inMemory()
        let library = DocumentLibrary(store: store, sync: nil, origin: "lab-test")
        let document = try await library.createDocument(title: "Lab")
        let registry = DocumentSessionRegistry(store: store, sync: nil, origin: "lab-test")
        let model = try await CloudDocumentModel.open(localId: document.localId, registry: registry)
        let draft = "Much of the struggle, frankly, comes from balance. It all depends. The core should be obvious."
        model.storage.markdown = draft
        model.accept(RectoEditorEdit(markdown: draft, structural: true))
        await model.save()
        let core = (draft as NSString).range(of: "core")
        await model.addAlternative("centre", at: core, scope: .word)

        let cuts = [(draft as NSString).range(of: ", frankly,"), (draft as NSString).range(of: " It all depends.")]
        #expect(await model.applyCuts(cuts, on: draft))
        let cut = "Much of the struggle comes from balance. The core should be obvious."
        #expect(model.state.markdown == cut)
        let group = try #require(model.writing.alternatives.first)
        #expect((cut as NSString).substring(with: group.range) == "core")

        await model.undo()
        #expect(model.state.markdown == draft)
        #expect(await model.applyCuts(cuts, on: "stale text") == false)
        await model.close()
    }

    @Test("a proposal counts words with and without its cuts and forgets kept ones")
    func proposal() {
        let base = "One two three four five six seven eight nine ten."
        let cuts = [
            AIClient.LabCut(from: 3, to: 7, reason: "a"),
            AIClient.LabCut(from: 13, to: 18, reason: "b"),
        ]
        var lab = AIController.LabProposal(target: 20, base: base, cuts: cuts, dropped: 0)
        #expect(lab.wordsBefore == 10)
        #expect(lab.wordsAfter == 8)
        lab.kept.insert(1)
        #expect(lab.cutRanges == [NSRange(location: 3, length: 4)])
        #expect(lab.wordsAfter == 9)
    }
}
