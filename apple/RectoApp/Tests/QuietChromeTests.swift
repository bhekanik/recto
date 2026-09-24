import AppKit
import Testing
@testable import Recto

@Suite("Quiet chrome while typing", .serialized)
@MainActor
struct QuietChromeTests {
    private func mount() -> (NSWindow, NSTextView, QuietChrome) {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300),
                              styleMask: [.titled], backing: .buffered, defer: false)
        let textView = NSTextView(frame: window.contentView!.bounds)
        window.contentView!.addSubview(textView)
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(textView)
        let quiet = QuietChrome()
        quiet.follow(textView)
        return (window, textView, quiet)
    }

    private func key(_ characters: String, _ flags: NSEvent.ModifierFlags = [], in window: NSWindow) -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0,
                         windowNumber: window.windowNumber, context: nil, characters: characters,
                         charactersIgnoringModifiers: characters, isARepeat: false, keyCode: 0)!
    }

    private func mouse(_ type: NSEvent.EventType, in window: NSWindow) -> NSEvent {
        NSEvent.mouseEvent(with: type, location: .zero, modifierFlags: [], timestamp: 0,
                           windowNumber: window.windowNumber, context: nil, eventNumber: 0,
                           clickCount: 1, pressure: 0)!
    }

    @Test("typing in the editor quiets, the pointer brings the chrome back")
    func typingAndPointer() {
        let (window, _, quiet) = mount()
        defer { window.orderOut(nil) }
        #expect(!quiet.isQuiet)
        quiet.observe(key("a", in: window))
        #expect(quiet.isQuiet)
        quiet.observe(mouse(.mouseMoved, in: window))
        #expect(!quiet.isQuiet)
        quiet.observe(key("b", [.shift], in: window))
        #expect(quiet.isQuiet, "shift is typing")
        quiet.observe(mouse(.leftMouseDown, in: window))
        #expect(!quiet.isQuiet)
    }

    @Test("shortcuts and keys outside the editor leave the chrome alone")
    func shortcutsAndFocus() {
        let (window, _, quiet) = mount()
        defer { window.orderOut(nil) }
        quiet.observe(key("k", [.command], in: window))
        #expect(!quiet.isQuiet)
        quiet.observe(key("r", [.control, .shift], in: window))
        #expect(!quiet.isQuiet)
        window.makeFirstResponder(nil)
        quiet.observe(key("a", in: window))
        #expect(!quiet.isQuiet, "no quieting while the editor does not have the keyboard")
    }

    @Test("another window's events are ignored, and stopping restores the chrome")
    func otherWindowsAndStop() {
        let (window, _, quiet) = mount()
        let (other, _, _) = mount()
        defer { window.orderOut(nil); other.orderOut(nil) }
        window.makeKeyAndOrderFront(nil)
        quiet.observe(key("a", in: window))
        #expect(quiet.isQuiet)
        quiet.observe(mouse(.mouseMoved, in: other))
        #expect(quiet.isQuiet, "a pointer in another window is not this window's pointer")
        quiet.follow(nil)
        #expect(!quiet.isQuiet)
    }
}
