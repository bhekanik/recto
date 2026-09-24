import AppKit
import Observation
import SwiftUI

/// Typing in the editor quiets the window's chrome; moving or clicking the
/// pointer brings it back. The iA Writer behaviour: while the writer is in
/// the sentence, the toolbar and status bar are not.
///
/// Scrolling leaves it as it is: a trackpad scroll is reading, not reaching
/// for a control.
@MainActor
@Observable
final class QuietChrome {
    private(set) var isQuiet = false

    @ObservationIgnored private weak var textView: NSTextView?
    @ObservationIgnored private var monitor: Any?

    /// Follow one editor. `nil` stops and restores the chrome.
    func follow(_ textView: NSTextView?) {
        self.textView = textView
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        set(quiet: false)
        guard textView != nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(
            matching: [.keyDown, .mouseMoved, .leftMouseDown, .rightMouseDown]
        ) { [weak self] event in
            MainActor.assumeIsolated { self?.observe(event) }
            return event
        }
    }

    private func observe(_ event: NSEvent) {
        guard let textView, let window = textView.window, event.window === window else { return }
        switch event.type {
        case .keyDown:
            // Shortcuts are commands, not writing: ⌘K should find the chrome
            // where the writer left it.
            let chord = event.modifierFlags.intersection([.command, .control])
            if chord.isEmpty, window.firstResponder === textView {
                window.acceptsMouseMovedEvents = true
                set(quiet: true)
            }
        default:
            set(quiet: false)
        }
    }

    private func set(quiet: Bool) {
        if isQuiet != quiet { isQuiet = quiet }
    }

    isolated deinit {
        if let monitor { NSEvent.removeMonitor(monitor) }
    }
}

/// Fades a piece of chrome while ``QuietChrome`` is quiet. A modifier, so the
/// flag is read here and a keystroke re-renders this, not the host.
struct QuietChromeFade: ViewModifier {
    let quiet: QuietChrome
    let settings: StudioSettings
    /// How far it fades. The status bar keeps a trace: the word count and the
    /// saved state are safety nets (blueprint P6), dimmed, never gone.
    var quietOpacity: Double = 0

    func body(content: Content) -> some View {
        let isQuiet = settings.quietChrome && quiet.isQuiet
        content
            .opacity(isQuiet ? quietOpacity : 1)
            .animation(.easeInOut(duration: isQuiet ? 0.45 : 0.2), value: isQuiet)
    }
}
