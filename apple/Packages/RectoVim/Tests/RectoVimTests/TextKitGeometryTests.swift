#if canImport(AppKit)
import AppKit
import Foundation
import Testing

@testable import RectoVim

/// `VimTextKitGeometry` in the layout the engine actually uses: a text view
/// inset by `textContainerInset`, placed off-origin inside a container that is
/// the scroll view's document view.
///
/// The core computes `zz`/`zt`/`zb` and page moves by subtracting
/// `scrollInfo.top` from a character's `top`, so the two have to be in one
/// coordinate space — the clip view's. The adapter used to report container
/// coordinates, which was right in its bare-window tests and wrong by the inset
/// plus the reading-column offset in the app.
@Suite("TextKit geometry")
@MainActor
struct TextKitGeometryTests {
    /// The engine's document view is flipped (`NativeTextViewContainer`), as
    /// any view hosting text views should be; an unflipped one would mirror y.
    private final class FlippedContainer: NSView {
        override var isFlipped: Bool { true }
    }

    private struct Mounted {
        let window: NSWindow
        let scrollView: NSScrollView
        let container: NSView
        let textView: NSTextView
        let geometry: VimTextKitGeometry
    }

    private func mount(
        _ text: String, inset: CGSize, textViewOrigin: CGPoint
    ) -> Mounted {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 600, height: 400),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let scrollView = NSScrollView(frame: window.contentLayoutRect)
        let container = FlippedContainer(frame: NSRect(x: 0, y: 0, width: 600, height: 1200))
        let textView = NSTextView(frame: NSRect(origin: textViewOrigin, size: CGSize(width: 400, height: 1000)))
        textView.isRichText = false
        textView.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        textView.textContainerInset = inset
        textView.string = text
        container.addSubview(textView)
        scrollView.documentView = container
        window.contentView?.addSubview(scrollView)
        textView.textLayoutManager?.ensureLayout(for: textView.textLayoutManager!.documentRange)
        return Mounted(
            window: window, scrollView: scrollView, container: container, textView: textView,
            geometry: VimTextKitGeometry(textView: textView))
    }

    @Test("charCoords carry the container inset and the text view's frame origin")
    func charCoordsAreInDocumentCoordinates() {
        let mounted = mount(
            "one\ntwo\nthree\n", inset: CGSize(width: 0, height: 32),
            textViewOrigin: CGPoint(x: 100, y: 0))
        let bare = mount(
            "one\ntwo\nthree\n", inset: .zero, textViewOrigin: .zero)

        let offset = 4  // start of "two"
        let inset = mounted.geometry.charCoords(offset: offset)
        let plain = bare.geometry.charCoords(offset: offset)

        #expect(abs(inset.top - (plain.top + 32)) < 0.5, "top \(inset.top) vs \(plain.top) + inset")
        #expect(abs(inset.left - (plain.left + 100)) < 0.5, "left \(inset.left) vs \(plain.left) + origin")
        #expect(inset.bottom > inset.top)
    }

    @Test("offsetAtCoords inverts charCoords in the same space")
    func offsetRoundTrips() {
        let mounted = mount(
            "one\ntwo\nthree\n", inset: CGSize(width: 12, height: 32),
            textViewOrigin: CGPoint(x: 100, y: 0))
        for offset in [0, 2, 4, 6, 8, 10] {
            let coords = mounted.geometry.charCoords(offset: offset)
            let back = mounted.geometry.offsetAtCoords(left: coords.left + 1, top: coords.top + 1)
            #expect(back == offset, "offset \(offset) came back as \(back)")
        }
    }

    @Test("scrollInfo reports the clip view over the document view")
    func scrollInfoUsesTheDocumentView() {
        let mounted = mount(
            "one\ntwo\nthree\n", inset: CGSize(width: 0, height: 32),
            textViewOrigin: CGPoint(x: 100, y: 0))
        mounted.scrollView.contentView.scroll(to: NSPoint(x: 0, y: 250))
        mounted.scrollView.reflectScrolledClipView(mounted.scrollView.contentView)

        let info = mounted.geometry.scrollInfo()
        #expect(abs(info.top - 250) < 0.5)
        #expect(abs(info.height - 1200) < 0.5, "the document view's height, not the text view's")
        #expect(abs(info.clientHeight - mounted.scrollView.contentView.bounds.height) < 0.5)
    }

    @Test("a text view with no scroll view answers in its own coordinates")
    func bareTextViewIsAZeroOffset() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 600, height: 400),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let textView = NSTextView(frame: NSRect(x: 50, y: 0, width: 400, height: 300))
        textView.textContainerInset = CGSize(width: 0, height: 10)
        textView.string = "one\ntwo\n"
        window.contentView?.addSubview(textView)
        textView.textLayoutManager?.ensureLayout(for: textView.textLayoutManager!.documentRange)
        let geometry = VimTextKitGeometry(textView: textView)

        let coords = geometry.charCoords(offset: 0)
        #expect(abs(coords.top - 10) < 0.5, "container inset only; the window offset is not part of it")
        #expect(geometry.scrollInfo().top == 0)
    }
}
#endif
