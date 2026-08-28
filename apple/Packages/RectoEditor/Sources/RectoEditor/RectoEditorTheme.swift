//
//  RectoEditorTheme.swift
//  RectoEditor
//

import AppKit

/// The colour slots the editor draws with, named for their role rather than
/// their value.
///
/// The defaults below are Twilight (dark) and Paper (light), converted from the
/// OKLCH values in `packages/design-tokens/tokens.json`. The Mac app maps that
/// package's `Colors.xcassets` into a `RectoEditorTheme` instead, so the system
/// resolves light/dark; these defaults are what tests and previews use, and
/// `StylerTests` holds the conversion to the same bytes the token pipeline
/// generates.
public struct RectoEditorTheme: Sendable, Equatable {
    /// Page behind the sheet.
    public var canvas: NSColor
    /// The writing sheet itself.
    public var sheet: NSColor
    /// Code blocks, inline code, quiet fills.
    public var raised: NSColor
    /// Body text.
    public var ink: NSColor
    /// Secondary text.
    public var ink2: NSColor
    /// Syntax markers, list glyphs, URLs, anything the reader is not meant to
    /// read as prose.
    public var ink3: NSColor
    /// Hairlines.
    public var line: NSColor
    /// The one accent: current node, active state.
    public var accent: NSColor
    /// Links.
    public var accent2: NSColor
    /// Selection wash.
    public var selection: NSColor
    /// Caret.
    public var caret: NSColor

    public init(
        canvas: NSColor,
        sheet: NSColor,
        raised: NSColor,
        ink: NSColor,
        ink2: NSColor,
        ink3: NSColor,
        line: NSColor,
        accent: NSColor,
        accent2: NSColor,
        selection: NSColor,
        caret: NSColor
    ) {
        self.canvas = canvas
        self.sheet = sheet
        self.raised = raised
        self.ink = ink
        self.ink2 = ink2
        self.ink3 = ink3
        self.line = line
        self.accent = accent
        self.accent2 = accent2
        self.selection = selection
        self.caret = caret
    }

    /// Twilight — the dark palette shipping at launch.
    public static let twilight = RectoEditorTheme(
        canvas: .oklch(0.18, 0.028, 280),
        sheet: .oklch(0.215, 0.03, 281),
        raised: .oklch(0.255, 0.032, 282),
        ink: .oklch(0.94, 0.012, 285),
        ink2: .oklch(0.79, 0.016, 284),
        ink3: .oklch(0.665, 0.018, 283),
        line: .oklch(0.33, 0.025, 282),
        accent: .oklch(0.74, 0.13, 288),
        accent2: .oklch(0.78, 0.1, 250),
        selection: NSColor.oklch(0.74, 0.13, 288).withAlphaComponent(0.26),
        caret: .oklch(0.92, 0.04, 285)
    )

    /// Paper — the light palette shipping at launch.
    public static let paper = RectoEditorTheme(
        canvas: .oklch(0.975, 0.008, 85),
        sheet: .oklch(0.99, 0.006, 85),
        raised: .oklch(0.955, 0.01, 85),
        ink: .oklch(0.22, 0.02, 285),
        ink2: .oklch(0.42, 0.02, 285),
        ink3: .oklch(0.51, 0.02, 285),
        line: .oklch(0.88, 0.01, 285),
        accent: .oklch(0.52, 0.15, 288),
        accent2: .oklch(0.5, 0.12, 250),
        selection: NSColor.oklch(0.52, 0.15, 288).withAlphaComponent(0.18),
        caret: .oklch(0.52, 0.15, 288)
    )
}

// MARK: - OKLCH

extension NSColor {
    /// A colour written the way the design tokens are: perceptual lightness,
    /// chroma, hue.
    ///
    /// The tokens are authored in OKLCH because equal lightness steps look
    /// equal, which is what makes the ink ramp read as one family. sRGB has no
    /// such property, so converting here rather than pasting hex keeps the
    /// values traceable to the design plan.
    ///
    /// - Parameters:
    ///   - lightness: 0…1.
    ///   - chroma: 0…~0.37.
    ///   - hue: degrees.
    static func oklch(_ lightness: CGFloat, _ chroma: CGFloat, _ hue: CGFloat) -> NSColor {
        let hueRadians = hue * .pi / 180
        let a = chroma * cos(hueRadians)
        let b = chroma * sin(hueRadians)

        // OKLab -> LMS' -> LMS -> linear sRGB (Björn Ottosson's matrices).
        let l = lightness + 0.3963377774 * a + 0.2158037573 * b
        let m = lightness - 0.1055613458 * a - 0.0638541728 * b
        let s = lightness - 0.0894841775 * a - 1.2914855480 * b
        let l3 = l * l * l, m3 = m * m * m, s3 = s * s * s

        let red = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3
        let green = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3
        let blue = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3

        return NSColor(
            srgbRed: gammaEncode(red),
            green: gammaEncode(green),
            blue: gammaEncode(blue),
            alpha: 1
        )
    }

    /// Linear light to sRGB, clamped — an out-of-gamut token would otherwise
    /// produce a NaN component and draw as black.
    private static func gammaEncode(_ channel: CGFloat) -> CGFloat {
        let clamped = min(max(channel, 0), 1)
        return clamped <= 0.0031308
            ? clamped * 12.92
            : 1.055 * pow(clamped, 1 / 2.4) - 0.055
    }
}
