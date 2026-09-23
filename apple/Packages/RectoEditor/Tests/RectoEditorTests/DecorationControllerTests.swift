//
//  DecorationControllerTests.swift
//  RectoEditorTests
//
//  Focus dimming and lint underlines, checked where they land: the pixels a
//  dimmed fragment draws, and the rendering attributes over a source range.
//

import AppKit
import Testing
@testable import RectoEditor

@MainActor
@Suite("Decorations", .serialized)
struct DecorationControllerTests {
    private struct Mounted {
        let harness: WindowHarness
        let storage: RectoTextStorage
        let decorations: RectoDecorationController
        let textView: NSTextView
    }

    private let markdown = "- first item in the list\n\nSecond paragraph. It has two sentences.\n\nThird paragraph here.\n"

    private func mount(_ markdown: String? = nil) throws -> Mounted {
        let storage = RectoTextStorage(documentId: "decorations", markdown: markdown ?? self.markdown)
        let decorations = RectoDecorationController()
        let harness = WindowHarness(
            RectoEditorView(
                storage: storage,
                styler: MarkdownStyler(presentation: .rich, theme: .twilight),
                onAttach: { decorations.attach(to: $0) }
            ),
            size: CGSize(width: 700, height: 420)
        )
        let textView = try #require(harness.editorTextView)
        return Mounted(harness: harness, storage: storage, decorations: decorations, textView: textView)
    }

    private func range(_ text: String, in mounted: Mounted) -> NSRange {
        (mounted.textView.string as NSString).range(of: text)
    }

    /// Mean distance from the rect's corner (the sheet) in brightness: how
    /// strongly whatever is drawn there stands out.
    private func contrast(_ rect: NSRect, _ harness: WindowHarness) throws -> Double {
        let rep = try #require(harness.bitmap(of: rect))
        let background = try #require(rep.colorAt(x: 0, y: 0)?.usingColorSpace(.sRGB)).brightnessComponent
        var sum = 0.0
        var count = 0
        for y in stride(from: 0, to: rep.pixelsHigh, by: 2) {
            for x in stride(from: 0, to: rep.pixelsWide, by: 2) {
                guard let pixel = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                sum += abs(pixel.brightnessComponent - background)
                count += 1
            }
        }
        return count == 0 ? 0 : sum / Double(count)
    }

    private func renderingColor(at location: Int, in mounted: Mounted, key: NSAttributedString.Key) -> Any? {
        guard let manager = mounted.textView.textLayoutManager,
              let content = manager.textContentManager,
              let start = content.location(content.documentRange.location, offsetBy: location)
        else { return nil }
        var found: Any?
        manager.enumerateRenderingAttributes(from: start, reverse: false) { _, attributes, range in
            if range.contains(start) { found = attributes[key] }
            return false
        }
        return found
    }

    @Test("paragraph scope dims the other paragraphs' text and the bullet they draw")
    func paragraphScope() throws {
        let mounted = try mount()
        defer { mounted.harness.tearDown() }
        let third = range("Third paragraph here.", in: mounted)
        let firstItem = range("first item", in: mounted)
        let thirdRect = try #require(mounted.harness.rect(forCharacterRange: third))
        let gutter = try #require(mounted.harness.markerGutter(forCharacterRange: firstItem))
        let before = (try contrast(thirdRect, mounted.harness), try contrast(gutter, mounted.harness))

        mounted.textView.setSelectedRange(NSRange(location: range("Second", in: mounted).location + 3, length: 0))
        mounted.decorations.focusDim = .paragraph
        mounted.harness.layout()

        #expect(mounted.decorations.litRange == range("Second paragraph. It has two sentences.", in: mounted))
        let after = (try contrast(thirdRect, mounted.harness), try contrast(gutter, mounted.harness))
        #expect(after.0 < before.0 * 0.6, "text outside the paragraph dims: \(before.0) → \(after.0)")
        #expect(after.1 < before.1 * 0.6, "the drawn bullet dims with its item: \(before.1) → \(after.1)")

        mounted.decorations.focusDim = nil
        mounted.harness.layout()
        #expect(try contrast(thirdRect, mounted.harness) > before.0 * 0.9, "turning it off restores the text")
    }

    @Test("sentence scope also dims the neighbouring sentence in the lit paragraph")
    func sentenceScope() throws {
        let mounted = try mount()
        defer { mounted.harness.tearDown() }
        mounted.textView.setSelectedRange(NSRange(location: range("It has", in: mounted).location + 2, length: 0))
        mounted.decorations.focusDim = .sentence
        mounted.harness.layout()
        #expect(mounted.decorations.litRange == range("It has two sentences.", in: mounted))
        let neighbour = range("Second paragraph.", in: mounted).location + 2
        #expect(renderingColor(at: neighbour, in: mounted, key: .foregroundColor) != nil)
        let lit = range("It has", in: mounted).location + 2
        #expect(renderingColor(at: lit, in: mounted, key: .foregroundColor) == nil)
    }

    @Test("the lit range follows the caret")
    func followsCaret() throws {
        let mounted = try mount()
        defer { mounted.harness.tearDown() }
        mounted.decorations.focusDim = .paragraph
        mounted.textView.setSelectedRange(NSRange(location: range("Third", in: mounted).location, length: 0))
        #expect(mounted.decorations.litRange == range("Third paragraph here.", in: mounted))
    }

    @Test("lint marks underline their range and answer hover with their message")
    func lintMarks() throws {
        let mounted = try mount()
        defer { mounted.harness.tearDown() }
        let word = range("sentences", in: mounted)
        mounted.decorations.lintMarks = [.init(range: word, category: "weasel", message: "weasel word")]
        mounted.harness.layout()
        #expect(mounted.storage.textView.underlines.map(\.range) == [word])

        // A point on the word's third glyph, in the text view's own coordinates.
        let glyph = mounted.textView.firstRect(forCharacterRange: NSRange(location: word.location + 2, length: 1), actualRange: nil)
        let window = try #require(mounted.textView.window)
        let point = mounted.textView.convert(window.convertPoint(fromScreen: NSPoint(x: glyph.midX, y: glyph.midY)), from: nil)
        #expect(mounted.decorations.lintMessage(at: point) == "weasel word")
    }

    @Test("an edit before a mark shifts it; an edit inside drops it")
    func marksFollowEdits() throws {
        let mounted = try mount()
        defer { mounted.harness.tearDown() }
        let third = range("Third", in: mounted)
        let second = range("Second", in: mounted)
        mounted.decorations.lintMarks = [
            .init(range: third, category: "passive", message: "a"),
            .init(range: second, category: "adverb", message: "b"),
        ]
        mounted.textView.insertText("New ", replacementRange: NSRange(location: third.location - 2, length: 0))
        mounted.textView.insertText("X", replacementRange: NSRange(location: second.location + 2, length: 0))
        #expect(mounted.decorations.lintMarks == [
            .init(range: NSRange(location: third.location + 5, length: third.length), category: "passive", message: "a"),
        ])
    }

    @Test("detaching turns the engine's dimming off")
    func detachClears() throws {
        let mounted = try mount()
        defer { mounted.harness.tearDown() }
        mounted.decorations.focusDim = .paragraph
        #expect(mounted.decorations.litRange != nil)
        mounted.decorations.attach(to: nil)
        #expect(mounted.storage.textView.focusLitRange == nil)
    }
}
