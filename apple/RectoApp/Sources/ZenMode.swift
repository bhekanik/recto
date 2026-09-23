import AppKit
import Observation
import SwiftUI

/// The web's `useZenMode`, per window: full screen, no chrome but the page,
/// and the chrome back for a moment when the pointer moves so the way out
/// stays findable. Leaving full screen leaves zen, as on the web.
@MainActor
@Observable
final class ZenMode {
    private(set) var isOn = false
    private(set) var isChromeRevealed = false

    /// The web's 2.2 s. Injected so a test need not wait for it.
    @ObservationIgnored var revealDuration: Duration = .milliseconds(2_200)
    @ObservationIgnored private weak var window: NSWindow?
    @ObservationIgnored private var enteredFullScreen = false
    @ObservationIgnored private var isPointerOverChrome = false
    @ObservationIgnored private var mouseMonitor: Any?
    @ObservationIgnored private var fullScreenObserver: NSObjectProtocol?
    @ObservationIgnored private var hideTask: Task<Void, Never>?

    /// Chrome that sits in the layout (toolbar, status bar) should be out of it.
    var hidesChrome: Bool { isOn }
    /// Chrome shown over the page while zen has revealed it.
    var showsOverlayChrome: Bool { isOn && isChromeRevealed }

    func toggle(in window: NSWindow?) {
        if isOn { leave() } else { enter(window) }
    }

    func enter(_ window: NSWindow?) {
        guard !isOn else { return }
        isOn = true
        self.window = window
        if let window {
            window.acceptsMouseMovedEvents = true
            if !window.styleMask.contains(.fullScreen) {
                enteredFullScreen = true
                window.toggleFullScreen(nil)
            }
            fullScreenObserver = NotificationCenter.default.addObserver(
                forName: NSWindow.didExitFullScreenNotification, object: window, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.leave(exitingFullScreen: false) }
            }
        }
        mouseMonitor = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved]) { [weak self] event in
            MainActor.assumeIsolated {
                if event.window === self?.window { self?.reveal() }
            }
            return event
        }
        // Shown once on the way in, so the exit is discoverable.
        reveal()
    }

    /// - Parameter exitingFullScreen: `false` when the window already left full
    ///   screen by itself (Esc, the green button), so there is nothing to undo.
    func leave(exitingFullScreen: Bool = true) {
        guard isOn else { return }
        isOn = false
        isChromeRevealed = false
        hideTask?.cancel()
        if let mouseMonitor { NSEvent.removeMonitor(mouseMonitor) }
        mouseMonitor = nil
        if let fullScreenObserver { NotificationCenter.default.removeObserver(fullScreenObserver) }
        fullScreenObserver = nil
        if exitingFullScreen, enteredFullScreen, let window, window.styleMask.contains(.fullScreen) {
            window.toggleFullScreen(nil)
        }
        enteredFullScreen = false
        window = nil
    }

    func reveal() {
        guard isOn else { return }
        isChromeRevealed = true
        scheduleHide()
    }

    /// Chrome under the pointer stays up, like the web's hover props.
    func pointerOverChrome(_ isOver: Bool) {
        isPointerOverChrome = isOver
        if isOver { hideTask?.cancel() } else { scheduleHide() }
    }

    private func scheduleHide() {
        hideTask?.cancel()
        let duration = revealDuration
        hideTask = Task { [weak self] in
            try? await Task.sleep(for: duration)
            guard !Task.isCancelled, let self, !self.isPointerOverChrome else { return }
            self.isChromeRevealed = false
        }
    }
}

/// Carries a document's zen state up to the library, whose sidebar hides with it.
struct ZenPreferenceKey: PreferenceKey {
    static let defaultValue = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) {
        value = value || nextValue()
    }
}
