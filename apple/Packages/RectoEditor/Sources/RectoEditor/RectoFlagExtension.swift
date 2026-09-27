//
//  RectoFlagExtension.swift
//  RectoEditor
//

import AppKit
import MarkdownEngine

/// Writing flags (`lib/markdown/flags.ts`): `<!--flag: note-->` sits in the
/// text as an HTML comment and shows as a flag while the caret is elsewhere.
/// The engine keeps the source intact and reveals it with the caret inside,
/// so the note can also be edited in place.
public struct RectoFlagExtension: MarkdownExtension {
    public static let identifier = "recto-flag"

    /// The flag's colour: the tokens' `warning` for the active palette.
    let color: NSColor

    public init(color: NSColor) {
        self.color = color
    }

    public var id: String { Self.identifier }

    public var inline: InlineSyntax? {
        InlineSyntax(
            open: "<!--flag", close: "-->",
            parsesContent: false, requiresNonEmptyContent: false,
            // A note is prose: `mid-century` must not end the span early.
            allowsCloseLeadInContent: true,
            // Ahead of the raw-HTML built-in, which would claim any comment.
            precedesBuiltIns: true,
            collapsesToGlyph: true)
    }

    /// The source, when revealed, reads as a note rather than as prose.
    public func contentAttributes(theme: MarkdownEditorTheme) -> [NSAttributedString.Key: Any] {
        [.foregroundColor: color]
    }

    /// Rich copy leaves the writer's notes behind.
    public func html(childrenHTML: String) -> String { "" }

    public func collapsedGlyph(theme: MarkdownEditorTheme, font: NSFont) -> NSImage? {
        let configuration = NSImage.SymbolConfiguration(pointSize: font.pointSize * 0.72, weight: .medium)
            .applying(NSImage.SymbolConfiguration(paletteColors: [color]))
        guard let symbol = NSImage(systemSymbolName: "flag.fill", accessibilityDescription: "Flag")?
            .withSymbolConfiguration(configuration)
        else { return nil }
        // A little air either side, as the web's `margin-inline`, so a flag
        // dropped against a word doesn't touch it.
        let pad = (font.pointSize * 0.12).rounded()
        let size = NSSize(width: symbol.size.width + pad * 2, height: symbol.size.height)
        return NSImage(size: size, flipped: false) { _ in
            symbol.draw(in: NSRect(origin: NSPoint(x: pad, y: 0), size: symbol.size))
            return true
        }
    }
}

extension RectoEditorTheme {
    /// The tokens' `warning`, which the web draws flags with: Paper
    /// `oklch(0.51 0.11 70)`, the dark palettes `oklch(0.84 0.1 85)`.
    public var flagColor: NSColor {
        self == .paper ? .oklch(0.51, 0.11, 70) : .oklch(0.84, 0.1, 85)
    }
}
