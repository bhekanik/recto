import AppKit
import RectoEditor
import Testing
@testable import Recto

@Suite("Page sheet")
@MainActor
struct PageSheetTests {
    private func settings() -> StudioSettings {
        let name = "com.bhekani.recto.tests.page-sheet"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return StudioSettings(defaults: defaults, systemAppearance: { .dark })
    }

    @Test("on by default, reaches the styler, and toggles")
    func setting() {
        let settings = settings()
        #expect(settings.showsSheet)
        #expect(settings.styler(presentation: .rich).showsSheet)
        settings.toggleSheet()
        #expect(!settings.styler(presentation: .rich).showsSheet)
        #expect(CommandRegistry.action("toggle-sheet") != nil)
    }

    @Test("the sheet is the reading column and its margins")
    func width() {
        let styler = MarkdownStyler(readingWidth: 720, showsSheet: true)
        #expect(styler.sheetWidth == 720 + 2 * MarkdownStyler.sheetMargin)
        #expect(MarkdownStyler(readingWidth: nil).sheetWidth == nil)
    }

    @Test("every palette carries the web's atmosphere")
    func atmosphere() {
        for theme in [RectoEditorTheme.twilight, .aurora, .dawn, .moonlit, .paper] {
            #expect(theme.atmosphere1.alphaComponent > 0.2)
            #expect(theme.atmosphere2.alphaComponent > 0.2)
        }
        #expect(RectoEditorTheme.paper.isLight)
        #expect(!RectoEditorTheme.twilight.isLight)
    }
}
