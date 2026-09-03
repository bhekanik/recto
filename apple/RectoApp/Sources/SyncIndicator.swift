import AppKit
import RectoEditor
import RectoStore
import SwiftUI

/// The web status bar's sync slot: a 6 pt dot that is always present, plus a
/// label in a frame as wide as the longest word, so Saving ↔ Saved never
/// shoves its neighbours. No animation — the motion itself was the bug.
struct SyncIndicator: View {
    let state: SyncState
    let pendingCount: Int
    let theme: RectoEditorTheme

    private static let font = NSFont.systemFont(ofSize: 12)
    private static let dotSize: CGFloat = 6
    private static let spacing: CGFloat = 8
    /// Widest of the four words, measured in the bar's 12 pt system font.
    static let labelMinWidth: CGFloat = {
        let labels = ["Saving", "Saved", "Unsynced", "Not synced"]
        let attributes: [NSAttributedString.Key: Any] = [.font: font]
        return labels.map { ($0 as NSString).size(withAttributes: attributes).width }.max() ?? 60
    }()

    /// Tokens' danger, once, because the editor theme has no danger slot.
    /// Twilight `oklch(0.7 0.16 20)`, Paper `oklch(0.52 0.19 25)`.
    private static let twilightDanger = NSColor.oklch(0.7, 0.16, 20)
    private static let paperDanger = NSColor.oklch(0.52, 0.19, 25)
    /// Tokens' warning. Twilight `oklch(0.84 0.1 85)`, Paper `oklch(0.51 0.11 70)`.
    private static let twilightWarning = NSColor.oklch(0.84, 0.1, 85)
    private static let paperWarning = NSColor.oklch(0.51, 0.11, 70)

    static func label(state: SyncState, pendingCount: Int) -> String {
        if pendingCount > 0 { return "Saving" }
        return switch state {
        case .pending, .syncing: "Saving"
        case .synced: "Saved"
        case .failed: "Unsynced"
        case .diverged: "Not synced"
        }
    }

    var body: some View {
        HStack(spacing: Self.spacing) {
            Circle()
                .fill(Color(nsColor: dotColor))
                .frame(width: Self.dotSize, height: Self.dotSize)
                .accessibilityHidden(true)
            Text(Self.label(state: state, pendingCount: pendingCount))
                .foregroundStyle(Color(nsColor: textColor))
                .lineLimit(1)
                .frame(minWidth: Self.labelMinWidth, maxWidth: Self.labelMinWidth, alignment: .leading)
        }
        .font(.system(size: 12))
        .fixedSize()
        .help(helpText)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.label(state: state, pendingCount: pendingCount))
        .accessibilityValue(helpText)
    }

    private var isPaper: Bool { theme == .paper }

    private var warningColor: NSColor {
        isPaper ? Self.paperWarning : Self.twilightWarning
    }

    private var dangerColor: NSColor {
        isPaper ? Self.paperDanger : Self.twilightDanger
    }

    private var presentation: (dot: NSColor, text: NSColor) {
        if pendingCount > 0 {
            return (theme.ink3, theme.ink3)
        }
        return switch state {
        case .pending, .syncing, .synced: (theme.ink3, theme.ink3)
        case .failed: (warningColor, warningColor)
        case .diverged: (dangerColor, dangerColor)
        }
    }

    private var dotColor: NSColor { presentation.dot }
    private var textColor: NSColor { presentation.text }

    private var helpText: String {
        switch state {
        case .synced: "This document matches Recto on the web."
        case .pending, .syncing: "Changes are saved locally and waiting to sync."
        case .diverged: "Choose which branch should become current."
        case .failed: "Sync failed. Changes remain in the local database."
        }
    }
}
