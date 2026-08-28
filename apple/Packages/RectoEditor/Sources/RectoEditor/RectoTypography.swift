//
//  RectoTypography.swift
//  RectoEditor
//

import AppKit

/// The type scale for one presentation, from the design plan §5.
///
/// Two scales, picked by ``Presentation/usesProseScale``: prose (Source Serif 4
/// at 19 pt) for rich and preview, source (JetBrains Mono at 17.5 pt) for raw.
/// Both run at 1.6 line height. `scale` multiplies the base size for the
/// reader's text-size control and is clamped to the plan's 0.8…2.0.
public struct RectoTypography: Sendable, Equatable {
    /// PostScript family the body is set in.
    public var family: String
    /// Body size in points, before ``scale``.
    public var baseSize: CGFloat
    /// Multiple of the font size one line occupies.
    public var lineHeightMultiple: CGFloat
    /// Heading sizes in em, H1…H6.
    public var headingMultipliers: [CGFloat]
    /// Space above each heading, in multiples of its own size. Design §5 does
    /// not specify this; these values give 19 pt prose at 1.6 enough air for a
    /// heading to read as a break rather than a bold line.
    public var headingTopSpacingEm: [CGFloat]
    /// Letter spacing in em. Negative tightens.
    public var tracking: CGFloat
    /// Reader text-size control, 0.8…2.0.
    public var scale: CGFloat

    public init(
        family: String,
        baseSize: CGFloat,
        lineHeightMultiple: CGFloat = 1.6,
        headingMultipliers: [CGFloat] = [1.7, 1.42, 1.22, 1.08, 1, 1],
        headingTopSpacingEm: [CGFloat] = [0.9, 0.8, 0.7, 0.6, 0.5, 0.5],
        tracking: CGFloat = -0.015,
        scale: CGFloat = 1
    ) {
        self.family = family
        self.baseSize = baseSize
        self.lineHeightMultiple = lineHeightMultiple
        self.headingMultipliers = headingMultipliers
        self.headingTopSpacingEm = headingTopSpacingEm
        self.tracking = tracking
        self.scale = scale
    }

    /// Source Serif 4, 19 pt — rich and preview.
    public static let prose = RectoTypography(family: RectoFonts.proseFamily, baseSize: 19)

    /// JetBrains Mono, 17.5 pt — raw. Headings still change weight and size so
    /// the source has structure, but far less than in prose: source is read as
    /// source.
    public static let source = RectoTypography(
        family: RectoFonts.sourceFamily,
        baseSize: 17.5,
        headingMultipliers: [1.2, 1.15, 1.1, 1.05, 1, 1],
        headingTopSpacingEm: [0.6, 0.6, 0.5, 0.5, 0.5, 0.5],
        tracking: 0
    )

    /// The scale for a presentation, at the reader's text size.
    public static func forPresentation(_ presentation: Presentation, scale: CGFloat = 1) -> RectoTypography {
        var typography = presentation.usesProseScale ? Self.prose : Self.source
        typography.scale = min(max(scale, 0.8), 2.0)
        return typography
    }

    /// Body size after the reader's text-size control.
    public var resolvedSize: CGFloat { baseSize * min(max(scale, 0.8), 2.0) }

    /// Extra leading the engine must add to reach ``lineHeightMultiple``.
    ///
    /// The engine sets a paragraph's minimum line height to the font's natural
    /// line height plus `ParagraphStyle.lineHeightExtraSpacing`, so a ratio has
    /// to be expressed as the difference.
    public var lineHeightExtraSpacing: CGFloat {
        let font = bodyFont
        let natural = ceil(font.ascender - font.descender + font.leading)
        return max(0, round(resolvedSize * lineHeightMultiple) - natural)
    }

    /// The resolved body font, falling back to a system face when the bundled
    /// resource is missing (a mis-built app bundle) so the editor still reads.
    public var bodyFont: NSFont {
        RectoFonts.register()
        if let font = NSFont(name: family, size: resolvedSize) { return font }
        return family == RectoFonts.sourceFamily
            ? .monospacedSystemFont(ofSize: resolvedSize, weight: .regular)
            : .systemFont(ofSize: resolvedSize)
    }
}
