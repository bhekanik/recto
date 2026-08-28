import AppKit
import MarkdownEngine
import SwiftUI

/// The document text, owned outside SwiftUI so the measurement code can swap
/// documents imperatively and then pump the run loop until the editor caught up.
final class TextModel: ObservableObject {
    @Published var text: String = ""
}

struct SpikeRoot: View {
    @ObservedObject var model: TextModel
    let fontName: String
    let fontSize: CGFloat
    let readingWidth: CGFloat?

    var body: some View {
        NativeTextViewWrapper(
            text: $model.text,
            configuration: {
                var c = MarkdownEditorConfiguration.default
                c.readingWidth = readingWidth
                // SPIKE_NOSPELL=1 isolates the system spell/grammar checker's
                // footprint from the editor's own.
                if ProcessInfo.processInfo.environment["SPIKE_NOSPELL"] == "1" {
                    c.spellChecking = SpellCheckingPolicy(
                        continuousSpellChecking: false, grammarChecking: false,
                        automaticSpellingCorrection: false)
                }
                // Recto's prose sheet has generous gutters; the spike matches the
                // shipping geometry so the numbers describe the real layout cost.
                c.textInsets = TextInsets(horizontal: 24, vertical: 24)
                return c
            }(),
            fontName: fontName,
            fontSize: fontSize,
            documentId: "spike"
        )
    }
}

/// Everything the measurement code needs to poke at a live editor.
@MainActor
struct Harness {
    let window: NSWindow
    let model: TextModel
    let textView: NSTextView
    let scrollView: NSScrollView
    let fontName: String

    static func make(fontSize: CGFloat, readingWidth: CGFloat?, activate: Bool) -> Harness {
        let model = TextModel()
        let fontName = firstAvailableFont([
            // Recto's prose face; falls back to what the machine actually has.
            "SourceSerif4-Regular", "Source Serif 4", "SourceSerifPro-Regular",
            "New York", "Times New Roman", "Helvetica Neue",
        ])
        let root = SpikeRoot(
            model: model, fontName: fontName, fontSize: fontSize, readingWidth: readingWidth)
        let hosting = NSHostingView(rootView: root)
        // SPIKE_WINDOW=WxH: a taller window draws more lines per frame, which is
        // how the scroll numbers are checked for actually including the draw.
        let size = (ProcessInfo.processInfo.environment["SPIKE_WINDOW"] ?? "1200x900")
            .split(separator: "x").compactMap { Double($0) }
        hosting.frame = NSRect(
            x: 0, y: 0, width: size.count == 2 ? size[0] : 1200,
            height: size.count == 2 ? size[1] : 900)

        let window = NSWindow(
            contentRect: hosting.frame,
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false)
        window.title = "EditorSpike"
        window.contentView = hosting
        window.setFrameOrigin(NSPoint(x: 100, y: 100))
        if activate {
            window.makeKeyAndOrderFront(nil)
        } else {
            window.orderFrontRegardless()
        }
        window.layoutIfNeeded()
        pump(0.3)

        guard let textView = findTextView(in: hosting),
            let scrollView = textView.enclosingScrollView
        else {
            fatalError("EditorSpike: no NSTextView in the hosted editor")
        }
        window.makeFirstResponder(textView)
        return Harness(
            window: window, model: model, textView: textView, scrollView: scrollView,
            fontName: fontName)
    }

    /// Swap the document and wait for the engine's rebuild + first layout to land.
    /// SwiftUI delivers the change asynchronously, so the clock runs until the
    /// text view actually holds the new string — not for a fixed sleep.
    @discardableResult
    func load(_ text: String, fullLayout: Bool = true) -> Double {
        let t0 = CACurrentMediaTime()
        model.text = text
        var waited = 0.0
        while textView.string != text && waited < 3.0 {
            pump(0)
            waited = CACurrentMediaTime() - t0
        }
        if fullLayout { layoutWholeDocument() }
        display()
        return (CACurrentMediaTime() - t0) * 1000
    }

    /// Font sizes the styler left on a run of characters. The engine's contract is
    /// that inactive markers shrink to `hiddenMarkerFontSize` and are never
    /// deleted, so this is how we prove hiding actually happened.
    func fontSizes(in range: NSRange) -> [CGFloat] {
        guard let storage = textView.textStorage else { return [] }
        return (range.location..<NSMaxRange(range)).map { i in
            (storage.attribute(.font, at: i, effectiveRange: nil) as? NSFont)?.pointSize ?? -1
        }
    }

    var layout: NSTextLayoutManager? { textView.textLayoutManager }

    func layoutWholeDocument() {
        guard let tlm = layout else { return }
        tlm.ensureLayout(for: tlm.documentRange)
    }

    /// Lay out what the reader can see and push it to the screen — the closest
    /// honest stand-in for "the frame the keystroke produced is on the glass".
    func display() {
        layout?.textViewportLayoutController.layoutViewport()
        textView.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
    }

    func fragmentCount() -> Int {
        guard let tlm = layout else { return 0 }
        var n = 0
        tlm.enumerateTextLayoutFragments(from: tlm.documentRange.location, options: [.ensuresLayout])
        { _ in
            n += 1
            return true
        }
        return n
    }

    func scrollToTop() {
        let clip = scrollView.contentView
        clip.scroll(to: NSPoint(x: 0, y: -scrollView.contentInsets.top))
        scrollView.reflectScrolledClipView(clip)
        display()
    }

    /// Scroll so `location` sits roughly in the middle of the viewport, without
    /// `NSTextView.scrollRangeToVisible` (which Edmund measured killing the
    /// process on large TextKit 2 documents).
    func center(on location: Int) {
        guard let tlm = layout,
            let loc = tlm.location(tlm.documentRange.location, offsetBy: location)
        else { return }
        tlm.ensureLayout(for: NSTextRange(location: loc))
        guard let fragment = tlm.textLayoutFragment(for: loc) else { return }
        let mid = fragment.layoutFragmentFrame.midY
        let clip = scrollView.contentView
        let y = mid - clip.bounds.height / 2
        clip.scroll(to: NSPoint(x: 0, y: max(-scrollView.contentInsets.top, y)))
        scrollView.reflectScrolledClipView(clip)
        display()
    }

    func caretRect() -> NSRect {
        textView.firstRect(forCharacterRange: textView.selectedRange(), actualRange: nil)
    }

    func key(_ characters: String, keyCode: UInt16 = 0, flags: NSEvent.ModifierFlags = []) {
        guard
            let down = NSEvent.keyEvent(
                with: .keyDown, location: .zero, modifierFlags: flags,
                timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber, context: nil,
                characters: characters, charactersIgnoringModifiers: characters,
                isARepeat: false, keyCode: keyCode)
        else { return }
        window.sendEvent(down)
    }
}

func firstAvailableFont(_ candidates: [String]) -> String {
    let available = Set(NSFontManager.shared.availableFonts)
    let families = Set(NSFontManager.shared.availableFontFamilies)
    for name in candidates where available.contains(name) || families.contains(name) {
        return name
    }
    return "SF Pro"
}

func findTextView(in view: NSView) -> NSTextView? {
    if let tv = view as? NSTextView { return tv }
    for sub in view.subviews {
        if let found = findTextView(in: sub) { return found }
    }
    return nil
}

/// Drain the main run loop and the AppKit event queue so async work the engine
/// scheduled (binding write-back, overlay reconcile) lands before the next step.
func pump(_ seconds: Double = 0.02) {
    let deadline = Date().addingTimeInterval(seconds)
    repeat {
        while let event = NSApp.nextEvent(
            matching: .any, until: nil, inMode: .default, dequeue: true)
        {
            NSApp.sendEvent(event)
        }
        _ = CFRunLoopRunInMode(.defaultMode, 0.001, true)
    } while Date() < deadline
}
