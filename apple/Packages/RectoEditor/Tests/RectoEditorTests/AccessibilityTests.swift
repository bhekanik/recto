//
//  AccessibilityTests.swift
//  RectoEditorTests
//

import AppKit
import MarkdownEngine
import Testing
@testable import RectoEditor

@MainActor
@Suite("VoiceOver", .serialized)
struct AccessibilityTests {
    private struct MountedAccessibility {
        let harness: WindowHarness
        let storage: RectoTextStorage
        let textView: NSTextView
    }

    private func mount(
        markdown: String,
        presentation: Presentation = .rich
    ) throws -> MountedAccessibility {
        let storage = RectoTextStorage(documentId: "accessibility", markdown: markdown)
        let harness = WindowHarness(
            RectoEditorView(
                storage: storage,
                styler: MarkdownStyler(presentation: presentation, theme: .twilight)
            ),
            size: CGSize(width: 640, height: 320)
        )
        return MountedAccessibility(
            harness: harness,
            storage: storage,
            textView: try #require(harness.editorTextView)
        )
    }

    @Test("rich mode exposes projected text and Markdown rotors")
    func richStructure() throws {
        let markdown = """
        ---
        title: Hidden
        ---
        ## Heading [link](https://example.com)
        - item
        ![Alt](image.png)
        Note[^n].

        [^n]: Footnote body
        """
        let mounted = try mount(markdown: markdown)
        defer { mounted.harness.tearDown() }
        let projection = mounted.storage.textView.textProjection

        #expect(mounted.textView.accessibilityString(
            for: NSRange(location: 0, length: projection.visibleUTF16Length)
        ) == projection.string)
        #expect(!projection.string.contains("Hidden"))
        #expect(!projection.string.contains("https://"))

        let rotorTypes = Set(mounted.textView.accessibilityCustomRotors().map(\.type))
        #expect(rotorTypes.contains(.heading))
        #expect(rotorTypes.contains(.headingLevel2))
        #expect(rotorTypes.contains(.list))
        #expect(rotorTypes.contains(.link))
        #expect(rotorTypes.contains(.image))
        #expect(mounted.textView.accessibilityCustomRotors().contains {
            $0.type == .custom && $0.label == "Footnotes"
        })
    }

    @Test("raw mode exposes the byte-exact file without rendered rotors")
    func rawSource() throws {
        let markdown = "# [Heading](https://example.com)\n"
        let mounted = try mount(markdown: markdown, presentation: .raw)
        defer { mounted.harness.tearDown() }

        #expect(mounted.textView.accessibilityString(
            for: NSRange(location: 0, length: (markdown as NSString).length)
        ) == markdown)
        #expect(mounted.textView.accessibilityCustomRotors().isEmpty)
    }

    @Test("VoiceOver range geometry stays on TextKit 2")
    func rangeGeometryUsesTextKit2() throws {
        let markdown = "# Alpha [bravo](https://example.com)\n"
        let mounted = try mount(markdown: markdown)
        defer { mounted.harness.tearDown() }
        var compatibilitySwitches = 0
        let observer = NotificationCenter.default.addObserver(
            forName: NSTextView.willSwitchToNSLayoutManagerNotification,
            object: mounted.textView,
            queue: .main
        ) { _ in
            MainActor.assumeIsolated { compatibilitySwitches += 1 }
        }
        defer { NotificationCenter.default.removeObserver(observer) }

        let visibleBravo = (mounted.storage.textView.textProjection.string as NSString)
            .range(of: "bravo")
        let frame = mounted.textView.accessibilityFrame(for: visibleBravo)

        #expect(!frame.isEmpty)
        #expect(compatibilitySwitches == 0)
    }
}
