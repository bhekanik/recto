//
//  TypewriterControllerTests.swift
//  RectoEditorTests
//

import AppKit
import Testing
@testable import RectoEditor

@MainActor
@Suite("Typewriter scrolling", .serialized)
struct TypewriterControllerTests {
    private struct MountedTypewriter {
        let harness: WindowHarness
        let storage: RectoTextStorage
        let controller: RectoTypewriterController
        let textView: NSTextView
        let scrollView: NSScrollView
    }

    private func mount(markdown: String, enabled: Bool = true) throws -> MountedTypewriter {
        let storage = RectoTextStorage(documentId: "typewriter", markdown: markdown)
        let controller = RectoTypewriterController(isEnabled: enabled)
        let harness = WindowHarness(
            RectoEditorView(
                storage: storage,
                styler: MarkdownStyler(presentation: .rich, theme: .twilight),
                onAttach: { controller.attach(to: $0) }
            ),
            size: CGSize(width: 640, height: 320)
        )
        let textView = try #require(harness.editorTextView)
        let scrollView = try #require(textView.enclosingScrollView)
        #expect(harness.window.makeFirstResponder(textView))
        #expect(harness.window.firstResponder === textView)
        return MountedTypewriter(
            harness: harness,
            storage: storage,
            controller: controller,
            textView: textView,
            scrollView: scrollView
        )
    }

    private func document(lineCount: Int = 2_000) -> String {
        (0..<lineCount)
            .map { "Line \($0): alpha bravo charlie delta echo foxtrot golf hotel" }
            .joined(separator: "\n") + "\n"
    }

    private func expectCentered(
        _ range: NSRange,
        in mounted: MountedTypewriter,
        sourceLocation: SourceLocation = #_sourceLocation
    ) throws {
        let layoutManager = try #require(
            mounted.textView.textLayoutManager,
            sourceLocation: sourceLocation
        )
        let contentManager = try #require(
            layoutManager.textContentManager,
            sourceLocation: sourceLocation
        )
        let location = try #require(
            contentManager.location(layoutManager.documentRange.location,
                                    offsetBy: range.location),
            sourceLocation: sourceLocation
        )
        var segmentRect: CGRect?
        layoutManager.enumerateTextSegments(
            in: NSTextRange(location: location),
            type: .standard,
            options: []
        ) { _, frame, _, _ in
            segmentRect = frame
            return false
        }
        let segment = try #require(segmentRect, sourceLocation: sourceLocation)
        let localRect = segment.offsetBy(
            dx: mounted.textView.textContainerOrigin.x,
            dy: mounted.textView.textContainerOrigin.y
        )
        let lineMidY = localRect.midY + mounted.textView.frame.minY
        #expect(
            abs(lineMidY - mounted.scrollView.contentView.bounds.midY) < 2,
            sourceLocation: sourceLocation
        )
    }

    @Test("a 10k-word document centers top, middle and bottom without TextKit 1")
    func centersLargeDocument() throws {
        let markdown = document()
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

        let ns = markdown as NSString
        let ranges = [
            ns.range(of: "Line 0:"),
            ns.range(of: "Line 1000:"),
            ns.range(of: "Line 1999:"),
        ]
        for range in ranges {
            mounted.storage.textView.selectedRange = NSRange(location: range.location, length: 0)
            NotificationCenter.default.post(
                name: NSTextView.didChangeSelectionNotification,
                object: mounted.textView
            )
            mounted.harness.layout(passes: 3)
            try expectCentered(range, in: mounted)
        }
        #expect(compatibilitySwitches == 0)
    }

    @Test("disable and detach restore the editor inset")
    func restoresInsetAndStops() throws {
        let mounted = try mount(markdown: document(lineCount: 100))
        defer { mounted.harness.tearDown() }
        let configuredInset = NSSize(width: 0, height: 32)

        #expect(mounted.textView.textContainerInset.height > configuredInset.height)
        mounted.controller.isEnabled = false
        #expect(mounted.textView.textContainerInset == configuredInset)

        mounted.controller.isEnabled = true
        #expect(mounted.textView.textContainerInset.height > configuredInset.height)
        mounted.controller.attach(to: nil)
        #expect(mounted.textView.textContainerInset == configuredInset)
    }

    @Test("destruction restores state while the editor stays alive")
    func destructionRestoresBorrowedState() throws {
        let storage = RectoTextStorage(documentId: "typewriter-destruction", markdown: document())
        var controller: RectoTypewriterController? = RectoTypewriterController(isEnabled: false)
        let harness = WindowHarness(
            RectoEditorView(
                storage: storage,
                styler: MarkdownStyler(presentation: .rich, theme: .twilight),
                onAttach: { controller?.attach(to: $0) }
            ),
            size: CGSize(width: 640, height: 320)
        )
        defer { harness.tearDown() }
        let textView = try #require(harness.editorTextView)
        let clipView = try #require(textView.enclosingScrollView?.contentView)
        let originalInset = textView.textContainerInset
        let originalPostsFrameChangedNotifications = clipView.postsFrameChangedNotifications

        controller?.isEnabled = true
        #expect(textView.textContainerInset.height > originalInset.height)
        #expect(clipView.postsFrameChangedNotifications)

        controller = nil

        #expect(textView.textContainerInset == originalInset)
        #expect(
            clipView.postsFrameChangedNotifications
                == originalPostsFrameChangedNotifications
        )
    }

    @Test("a programmatic change centers once after its guarded operation")
    func programmaticChangeRecentersAfterCompletion() throws {
        let markdown = document(lineCount: 300)
        let mounted = try mount(markdown: markdown)
        defer { mounted.harness.tearDown() }
        let target = (markdown as NSString).range(of: "Line 250:")

        mounted.controller.performProgrammaticChange {
            mounted.storage.textView.selectedRange = NSRange(
                location: target.location,
                length: 0
            )
        }
        mounted.harness.layout(passes: 3)

        try expectCentered(target, in: mounted)
    }

    @Test("a range selection does not move until it collapses")
    func rangeSelectionWaitsForCompletion() throws {
        let markdown = document(lineCount: 300)
        let mounted = try mount(markdown: markdown)
        defer { mounted.harness.tearDown() }
        let middle = (markdown as NSString).range(of: "Line 150:")
        let top = (markdown as NSString).range(of: "Line 5:")

        mounted.storage.textView.selectedRange = NSRange(location: middle.location, length: 0)
        NotificationCenter.default.post(
            name: NSTextView.didChangeSelectionNotification,
            object: mounted.textView
        )
        mounted.harness.layout(passes: 3)
        let centeredY = mounted.scrollView.contentView.bounds.minY

        mounted.storage.textView.selectedRange = NSRange(location: top.location, length: 6)
        NotificationCenter.default.post(
            name: NSTextView.didChangeSelectionNotification,
            object: mounted.textView
        )
        mounted.harness.layout(passes: 3)
        #expect(mounted.scrollView.contentView.bounds.minY == centeredY)

        mounted.storage.textView.selectedRange = NSRange(location: top.location, length: 0)
        NotificationCenter.default.post(
            name: NSTextView.didChangeSelectionNotification,
            object: mounted.textView
        )
        mounted.harness.layout(passes: 3)
        try expectCentered(top, in: mounted)
    }
}
