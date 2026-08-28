//
//  StylerTests.swift
//  RectoEditorTests
//

import AppKit
import MarkdownEngine
import Testing
@testable import RectoEditor

@MainActor
@Suite("Styler, typography, theme")
struct StylerTests {

    @Test("both bundled families register and resolve")
    func bundledFontsResolve() {
        #expect(RectoFonts.isAvailable(RectoFonts.proseFamily))
        #expect(RectoFonts.isAvailable(RectoFonts.sourceFamily))
        #expect(RectoTypography.prose.bodyFont.familyName == RectoFonts.proseFamily)
        #expect(RectoTypography.source.bodyFont.familyName == RectoFonts.sourceFamily)
    }

    @Test("the design plan's scales")
    func scalesMatchTheDesign() {
        #expect(RectoTypography.prose.baseSize == 19)
        #expect(RectoTypography.prose.lineHeightMultiple == 1.6)
        #expect(RectoTypography.prose.headingMultipliers == [1.7, 1.42, 1.22, 1.08, 1, 1])
        #expect(RectoTypography.prose.tracking == -0.015)
        #expect(RectoTypography.source.baseSize == 17.5)
        #expect(RectoTypography.source.lineHeightMultiple == 1.6)
    }

    @Test("the reader's text size is clamped to 0.8…2.0")
    func textSizeIsClamped() {
        #expect(RectoTypography.forPresentation(.rich, scale: 0.1).resolvedSize == 19 * 0.8)
        #expect(RectoTypography.forPresentation(.rich, scale: 9).resolvedSize == 19 * 2.0)
    }

    @Test("each presentation picks its scale, and switching keeps the text size")
    func presentationPicksScale() {
        var styler = MarkdownStyler(presentation: .rich)
        styler.typography.scale = 1.25
        #expect(styler.typography.family == RectoFonts.proseFamily)

        let raw = styler.presenting(.raw)
        #expect(raw.typography.family == RectoFonts.sourceFamily)
        #expect(raw.typography.scale == 1.25)
        #expect(raw.engineConfiguration().rawSourceMode)

        #expect(styler.presenting(.preview).typography.family == RectoFonts.proseFamily)
    }

    @Test("Recto owns undo, so the engine registers nothing")
    func undoIsExternal() {
        #expect(MarkdownStyler().engineConfiguration().undo == .external)
    }

    @Test("strikethrough is registered; nothing else beyond CommonMark is")
    func strikethroughIsRegistered() {
        let extensions = MarkdownStyler().engineConfiguration().extensions
        #expect(extensions.count == 1)
        #expect(extensions.first is StrikethroughExtension)
    }

    @Test("raw turns off the smart-input helpers")
    func rawHasNoSmartInput() {
        let rich = MarkdownStyler(presentation: .rich).engineConfiguration()
        let raw = MarkdownStyler(presentation: .raw).engineConfiguration()
        #expect(rich.lists.helpersEnabled)
        #expect(!raw.lists.helpersEnabled)
        #expect(!raw.lists.autoClosePairsEnabled)
    }

    @Test("preview is not editable; rich and raw are")
    func editability() {
        #expect(Presentation.rich.isEditable)
        #expect(Presentation.raw.isEditable)
        #expect(!Presentation.preview.isEditable)
    }

    @Test("OKLCH tokens convert to plausible sRGB")
    func oklchConversion() throws {
        // Twilight's canvas is a very dark, slightly blue-violet grey.
        let canvas = try #require(RectoEditorTheme.twilight.canvas.usingColorSpace(.sRGB))
        #expect(canvas.brightnessComponent < 0.2)
        #expect(canvas.blueComponent > canvas.redComponent)

        // Paper's canvas is a near-white warm grey.
        let paper = try #require(RectoEditorTheme.paper.canvas.usingColorSpace(.sRGB))
        #expect(paper.brightnessComponent > 0.94)
        #expect(paper.redComponent > paper.blueComponent)

        // The ink ramp gets lighter in the dark palette, darker in the light one.
        let darkInk = try #require(RectoEditorTheme.twilight.ink.usingColorSpace(.sRGB))
        let darkInk3 = try #require(RectoEditorTheme.twilight.ink3.usingColorSpace(.sRGB))
        #expect(darkInk.brightnessComponent > darkInk3.brightnessComponent)
        let lightInk = try #require(RectoEditorTheme.paper.ink.usingColorSpace(.sRGB))
        let lightInk3 = try #require(RectoEditorTheme.paper.ink3.usingColorSpace(.sRGB))
        #expect(lightInk.brightnessComponent < lightInk3.brightnessComponent)
    }

    @Test("every OKLCH token produces a real colour, not a NaN")
    func noTokenIsNaN() {
        for theme in [RectoEditorTheme.twilight, .paper] {
            for color in [theme.canvas, theme.sheet, theme.raised, theme.ink, theme.ink2,
                          theme.ink3, theme.line, theme.accent, theme.accent2,
                          theme.selection, theme.caret] {
                let srgb = color.usingColorSpace(.sRGB)
                #expect(srgb != nil)
                #expect(!(srgb?.redComponent.isNaN ?? true))
            }
        }
    }
}
