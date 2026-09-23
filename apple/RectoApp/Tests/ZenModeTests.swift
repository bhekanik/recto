import AppKit
import Testing
@testable import Recto

@Suite("Zen mode")
@MainActor
struct ZenModeTests {
    @Test("entering hides the laid-out chrome and reveals the overlay once")
    func entering() {
        let zen = ZenMode()
        #expect(!zen.hidesChrome)
        zen.toggle(in: nil)
        #expect(zen.isOn)
        #expect(zen.hidesChrome)
        #expect(zen.showsOverlayChrome, "shown on the way in so the exit is findable")
        zen.toggle(in: nil)
        #expect(!zen.isOn)
        #expect(!zen.hidesChrome)
        #expect(!zen.showsOverlayChrome)
    }

    @Test("the revealed chrome hides again unless the pointer is over it")
    func revealTimesOut() async throws {
        let zen = ZenMode()
        zen.revealDuration = .milliseconds(20)
        zen.enter(nil)
        try await Task.sleep(for: .milliseconds(120))
        #expect(!zen.showsOverlayChrome)

        zen.reveal()
        zen.pointerOverChrome(true)
        try await Task.sleep(for: .milliseconds(120))
        #expect(zen.showsOverlayChrome)
        zen.pointerOverChrome(false)
        try await Task.sleep(for: .milliseconds(120))
        #expect(!zen.showsOverlayChrome)
        zen.leave()
    }

    @Test("revealing does nothing outside zen")
    func revealOutsideZen() {
        let zen = ZenMode()
        zen.reveal()
        #expect(!zen.showsOverlayChrome)
    }

    @Test("the window leaving full screen by itself leaves zen")
    func exitingFullScreenLeavesZen() {
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 200, height: 200), styleMask: [.titled], backing: .buffered, defer: true)
        let zen = ZenMode()
        zen.enter(window)
        #expect(zen.isOn)
        NotificationCenter.default.post(name: NSWindow.didExitFullScreenNotification, object: window)
        #expect(!zen.isOn)
    }
}
