//
//  WindowHarness.swift
//  RectoEditorTests
//
//  A real window with a real view hierarchy, laid out and drawn.
//
//  The attribute dumps are the right tool for "what did the styler decide", and
//  the wrong one for "did anything actually appear". They call the styler
//  directly: no view, no window, no layout manager, no fragment draw. Break the
//  bullet drawing or delete the header and every dump still passes.
//
//  What is readable from an off-screen window is narrower than it looks.
//  SwiftUI draws `Text` itself instead of producing an `NSTextField`, so
//  walking `subviews` finds nothing to read; and AppKit only populates the
//  accessibility tree once an assistive client attaches, so that comes back
//  empty too. Both measured here, not assumed. What IS available is geometry
//  and pixels, so that is what these assert on: where the header band ends,
//  whether there is ink in it, and whether its bitmap changes when the content
//  changes.
//

import AppKit
import SwiftUI
@testable import RectoEditor

@MainActor
struct WindowHarness {
    let window: NSWindow
    let hostingView: NSHostingView<AnyView>

    init<Content: View>(_ content: Content, size: CGSize = CGSize(width: 800, height: 900)) {
        _ = NSApplication.shared
        hostingView = NSHostingView(rootView: AnyView(content))
        hostingView.frame = NSRect(origin: .zero, size: size)
        window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = hostingView
        // Fixed appearance: a test that renders differently on the machine's
        // light/dark setting is a test nobody trusts.
        window.appearance = NSAppearance(named: .darkAqua)
        // AppKit releases a closed window by default, which over a suite of
        // these crashes the runner on the next autorelease drain.
        window.isReleasedWhenClosed = false
        window.orderBack(nil)
        layout()
    }

    /// SwiftUI resolves into AppKit views across run-loop turns, and TextKit 2
    /// lays the viewport out on its own schedule. One pass is not enough for
    /// either, so settle deliberately rather than hoping.
    func layout(passes: Int = 4) {
        for _ in 0..<passes {
            hostingView.needsLayout = true
            hostingView.layoutSubtreeIfNeeded()
            hostingView.displayIfNeeded()
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
    }

    // MARK: - The view tree

    /// Every view in the hierarchy, depth first.
    var allViews: [NSView] {
        func walk(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(walk) }
        return walk(hostingView)
    }

    /// The engine's text view, once SwiftUI has built it.
    var editorTextView: NSTextView? {
        allViews.compactMap { $0 as? NSTextView }.first
    }

    /// The scroll view the editor lives in, in hosting-view coordinates.
    var editorFrame: NSRect? {
        guard let scrollView = allViews.compactMap({ $0 as? NSScrollView }).first else { return nil }
        return scrollView.convert(scrollView.bounds, to: hostingView)
    }

    /// The band above the editor — where the document header goes. Zero-height
    /// when there is no header, which is what the raw and no-frontmatter cases
    /// turn on.
    var headerBand: NSRect {
        guard let editorFrame else { return .zero }
        return NSRect(x: 0, y: 0, width: hostingView.bounds.width, height: editorFrame.minY)
    }

    // MARK: - Pixels

    /// The hierarchy, drawn.
    func bitmap(of rect: NSRect) -> NSBitmapImageRep? {
        guard rect.width >= 1, rect.height >= 1,
              let rep = hostingView.bitmapImageRepForCachingDisplay(in: rect) else { return nil }
        hostingView.cacheDisplay(in: rect, to: rep)
        return rep
    }

    /// The fraction of sampled pixels in `rect` that differ from its corner.
    ///
    /// The sheet is a flat fill, so "differs from the corner" is "something was
    /// drawn here". Blunt on purpose: it answers *did anything render*, which
    /// is the question a deleted view fails.
    func inkCoverage(in rect: NSRect) -> Double {
        guard let rep = bitmap(of: rect), rep.pixelsWide > 1, rep.pixelsHigh > 1,
              let background = rep.colorAt(x: 0, y: 0)?.usingColorSpace(.sRGB) else { return 0 }
        var inked = 0
        var total = 0
        for y in stride(from: 0, to: rep.pixelsHigh, by: 2) {
            for x in stride(from: 0, to: rep.pixelsWide, by: 2) {
                total += 1
                guard let pixel = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                if abs(pixel.brightnessComponent - background.brightnessComponent) > 0.02 {
                    inked += 1
                }
            }
        }
        return total == 0 ? 0 : Double(inked) / Double(total)
    }

    /// A digest of what `rect` looks like. Two renders of the same content
    /// agree; a change to any drawn glyph or decoration does not.
    func fingerprint(of rect: NSRect) -> String {
        guard let rep = bitmap(of: rect),
              let data = rep.representation(using: .png, properties: [:]) else { return "" }
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in data {
            hash = (hash ^ UInt64(byte)) &* 0x0000_0100_0000_01B3
        }
        return String(hash, radix: 16)
    }

    /// The rect a character range occupies, in hosting-view coordinates.
    ///
    /// TextKit 2 only: `textLayoutManager`, never `layoutManager`. Returns nil
    /// before the viewport has been laid out.
    func rect(forCharacterRange range: NSRange) -> NSRect? {
        guard let textView = editorTextView,
              let local = textViewRect(forCharacterRange: range) else { return nil }
        return textView.convert(local, to: hostingView)
    }

    /// The same rect, left in the text view's own coordinate system — which is
    /// what `characterIndexForInsertion(at:)` and the other hit-testing APIs
    /// take, and what avoids a flipped-coordinate round trip through SwiftUI's
    /// hosting view.
    func textViewRect(forCharacterRange range: NSRange) -> NSRect? {
        guard let textView = editorTextView,
              let layoutManager = textView.textLayoutManager,
              let contentManager = layoutManager.textContentManager,
              let start = contentManager.location(contentManager.documentRange.location,
                                                  offsetBy: range.location),
              let fragment = layoutManager.textLayoutFragment(for: start) else { return nil }
        var frame = fragment.layoutFragmentFrame
        let origin = textView.textContainerOrigin
        frame.origin.x += origin.x
        frame.origin.y += origin.y
        return frame
    }

    /// The marker slot: the strip between the line's left edge and where its
    /// text actually starts.
    ///
    /// Bullets, ordered numbers and task boxes are DRAWN there by the layout
    /// fragment; the authored `-` or `1.` is kerned to zero width and painted
    /// clear. So this strip is empty for a paragraph and holds exactly the
    /// drawn glyph for a list item — which is the only place an attribute dump
    /// cannot look. The width comes from the paragraph's head indent rather
    /// than a guess, because that indent is what pushes the text aside to make
    /// room for the glyph.
    func markerGutter(forCharacterRange range: NSRange) -> NSRect? {
        guard let line = rect(forCharacterRange: range),
              let storage = editorTextView?.textStorage,
              range.location < storage.length,
              let paragraph = storage.attribute(.paragraphStyle, at: range.location,
                                                effectiveRange: nil) as? NSParagraphStyle,
              paragraph.headIndent > 1 else { return nil }
        return NSRect(x: line.minX, y: line.minY,
                      width: paragraph.headIndent, height: max(1, line.height))
    }

    // MARK: - Text

    /// Strings readable from real AppKit text views. SwiftUI `Text` does not
    /// appear here; see the type comment.
    var renderedStrings: [String] {
        allViews.compactMap { view in
            if let text = view as? NSTextField { return text.stringValue }
            if let text = view as? NSTextView { return text.string }
            return nil
        }
    }

    func tearDown() {
        window.contentView = nil
        window.orderOut(nil)
    }
}
