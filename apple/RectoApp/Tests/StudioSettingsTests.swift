import AppKit
import RectoEditor
import Synchronization
import Testing
@testable import Recto

@Suite("Studio settings", .serialized)
@MainActor
struct StudioSettingsTests {
    /// The test host is the real app; its standard defaults hold the
    /// developer's own settings. Every test reads an emptied suite instead.
    private static let scratchSuite = "com.bhekani.recto.tests.studio-settings"
    private let scratch: UserDefaults

    init() throws {
        scratch = try #require(UserDefaults(suiteName: Self.scratchSuite))
        scratch.removePersistentDomain(forName: Self.scratchSuite)
    }

    private func settings(systemAppearance: StudioSettings.ResolvedAppearance = .dark) -> StudioSettings {
        StudioSettings(defaults: scratch, systemAppearance: { systemAppearance })
    }

    @Test("an empty store gives the web's defaults")
    func defaults() {
        let settings = settings()
        #expect(settings.appearance == .system)
        #expect(settings.readingScale == 1)
        #expect(settings.spellcheck)
        #expect(!settings.typewriter)
        #expect(settings.showToolbar)
        #expect(settings.showStatusBar)
        #expect(settings.palette == .twilight)
        #expect(settings.readingFont == .serif)
        #expect(!settings.showOutline, "the web's outline ships hidden")
        #expect(settings.smartPaste)
        #expect(!settings.focusDim && settings.focusDimScope == .sentence)
        #expect(!settings.lint && settings.lintCategories.count == 4, "linter off, every category ready")
        #expect(settings.previewVariant == .rendered)
        #expect(settings.wordGoalTarget == 0 && settings.dailyGoalTarget == 0)
        #expect(settings.wordGoalKind == .atLeast && settings.goalScope == .document && settings.goalStyle == .ring)
    }

    @Test("the palette applies only while dark, cycles in the web's order, and persists")
    func paletteFollowsAppearance() {
        let dark = settings(systemAppearance: .dark)
        #expect(dark.canCyclePalette)
        dark.cyclePalette()
        #expect(dark.palette == .aurora)
        #expect(dark.theme == .aurora)
        #expect(dark.themeLabel == "Aurora")
        dark.cyclePalette(); dark.cyclePalette(); dark.cyclePalette()
        #expect(dark.palette == .twilight)
        dark.palette = .moonlit
        #expect(settings(systemAppearance: .dark).palette == .moonlit)

        let light = settings(systemAppearance: .light)
        #expect(light.palette == .moonlit)
        #expect(light.theme == .paper)
        #expect(light.themeLabel == "Paper")
        #expect(!light.canCyclePalette)
        light.cyclePalette()
        #expect(light.palette == .moonlit)
    }

    @Test("goal targets clamp to non-negative integers and persist")
    func goalTargets() {
        let settings = settings()
        settings.setWordGoalTarget(1_234.6)
        settings.setDailyGoalTarget(-50)
        #expect(settings.wordGoalTarget == 1_235)
        #expect(settings.dailyGoalTarget == 0)
        #expect(self.settings().wordGoalTarget == 1_235)
    }

    @Test("the reading font toggles, persists, and reaches the styler across lenses")
    func readingFont() {
        let settings = settings()
        settings.toggleReadingFont()
        #expect(settings.readingFont == .sans)
        #expect(self.settings().readingFont == .sans)
        #expect(settings.styler(presentation: .rich).typography.family == RectoFonts.sansFamily)
        #expect(settings.styler(presentation: .raw).typography.family == RectoFonts.sourceFamily)
        #expect(settings.styler(presentation: .raw).presenting(.rich).typography.family == RectoFonts.sansFamily)
        settings.toggleReadingFont()
        #expect(settings.styler(presentation: .rich).typography.family == RectoFonts.proseFamily)
    }

    @Test("unreadable stored values fall back per key, not all at once")
    func garbageFallsBackPerKey() {
        scratch.set("purple", forKey: StudioSettings.Key.appearance)
        scratch.set("big", forKey: StudioSettings.Key.readingScale)
        scratch.set("yes", forKey: StudioSettings.Key.spellcheck)
        scratch.set(3, forKey: StudioSettings.Key.typewriter)
        scratch.set(false, forKey: StudioSettings.Key.showToolbar)
        let settings = settings()
        #expect(settings.appearance == .system)
        #expect(settings.readingScale == 1)
        #expect(settings.spellcheck)
        #expect(!settings.typewriter)
        #expect(!settings.showToolbar, "the one readable key still applies")
    }

    @Test("an out-of-range stored scale is clamped on read", arguments: [
        (0.1, 0.8), (9.0, 2.0), (1.23456, 1.23), (Double.nan, 1.0), (Double.infinity, 1.0),
    ])
    func storedScaleIsClamped(stored: Double, expected: Double) {
        scratch.set(stored, forKey: StudioSettings.Key.readingScale)
        #expect(settings().readingScale == expected)
    }

    @Test("every setting survives a relaunch")
    func persists() {
        let first = settings()
        first.appearance = .light
        first.zoomIn()
        first.zoomIn()
        first.toggleSpellcheck()
        first.toggleTypewriter()
        first.toggleToolbar()
        first.toggleStatusBar()
        first.toggleOutline()

        let second = settings()
        #expect(second.appearance == .light)
        #expect(second.readingScale == 1.2)
        #expect(!second.spellcheck)
        #expect(second.typewriter)
        #expect(!second.showToolbar)
        #expect(!second.showStatusBar)
        #expect(second.showOutline)
    }

    @Test("system appearance follows the injected provider until overridden")
    func resolvesAppearance() {
        let system = Mutex(StudioSettings.ResolvedAppearance.dark)
        let settings = StudioSettings(defaults: scratch, systemAppearance: { system.withLock { $0 } })
        #expect(settings.resolvedAppearance == .dark)
        #expect(settings.theme == .twilight)
        #expect(settings.themeLabel == "Twilight")
        #expect(settings.preferredColorScheme == nil)

        system.withLock { $0 = .light }
        #expect(settings.resolvedAppearance == .dark, "nothing re-reads the OS until told")
        settings.refreshSystemAppearance()
        #expect(settings.resolvedAppearance == .light)
        #expect(settings.theme == .paper)
        #expect(settings.themeLabel == "Paper")

        settings.appearance = .dark
        #expect(settings.resolvedAppearance == .dark)
        #expect(settings.theme == .twilight)
        #expect(settings.preferredColorScheme == .dark)

        settings.appearance = .light
        system.withLock { $0 = .dark }
        settings.refreshSystemAppearance()
        #expect(settings.resolvedAppearance == .light, "an explicit choice ignores the OS")
        #expect(settings.preferredColorScheme == .light)
    }

    @Test("the appearance control cycles in the web's order")
    func cyclesAppearance() {
        let settings = settings()
        var seen: [StudioSettings.Appearance] = []
        for _ in 0..<4 {
            seen.append(settings.appearance)
            settings.cycleAppearance()
        }
        #expect(seen == [.system, .light, .dark, .system])
    }

    @Test("text zoom steps by a tenth and clamps at the web's bounds")
    func zoomClamps() {
        let settings = settings()
        settings.zoomIn()
        #expect(settings.readingScale == 1.1, "no float drift")
        #expect(settings.zoomPercent == 110)
        for _ in 0..<20 { settings.zoomIn() }
        #expect(settings.readingScale == StudioSettings.readingScaleMax)
        #expect(!settings.canZoomIn)
        #expect(settings.canZoomOut)
        for _ in 0..<20 { settings.zoomOut() }
        #expect(settings.readingScale == StudioSettings.readingScaleMin)
        #expect(settings.zoomPercent == 80)
        #expect(!settings.canZoomOut)
        #expect(settings.canZoomIn)
        settings.zoomReset()
        #expect(settings.readingScale == 1)
    }

    @Test("the styler carries theme, scale and spellcheck into the editor")
    func stylerReflectsSettings() {
        let settings = settings(systemAppearance: .light)
        settings.zoomIn()
        settings.toggleSpellcheck()
        let styler = settings.styler(presentation: .raw)
        #expect(styler.presentation == .raw)
        #expect(styler.theme == .paper)
        #expect(styler.typography.scale == 1.1)
        #expect(styler.typography.family == RectoFonts.sourceFamily)
        #expect(!styler.spellChecking)
        let configuration = styler.engineConfiguration()
        #expect(!configuration.spellChecking.continuousSpellChecking)
        #expect(!configuration.spellChecking.grammarChecking)
    }

    /// P2-1: `.shared` is created before `NSApplication.shared` exists, so the
    /// scene roots arm the observation on appear. The test host is the real app,
    /// so by the time any test runs a root has appeared: asserting the arming
    /// here, without arming by hand, is what pins the `onAppear` wiring — the
    /// line that was missing when "System" never followed the OS.
    @Test("the shared settings follow the application's appearance once armed")
    func sharedFollowsApplication() async {
        _ = NSApplication.shared
        let previous = NSApp.appearance
        defer { NSApp.appearance = previous }
        let settings = StudioSettings.shared
        #expect(settings.isFollowingApplicationAppearance)

        NSApp.appearance = NSAppearance(named: .aqua)
        await drainMainQueue()
        #expect(settings.systemAppearance == .light)

        NSApp.appearance = NSAppearance(named: .darkAqua)
        await drainMainQueue()
        #expect(settings.systemAppearance == .dark)
    }

    @Test("following is a no-op until armed")
    func notFollowingUntilArmed() {
        let settings = settings()
        #expect(!settings.isFollowingApplicationAppearance)
        settings.followApplicationAppearance()
        #expect(settings.isFollowingApplicationAppearance)
    }

    private func drainMainQueue() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
    }

    @Test("every SF Symbol the status bar names exists", arguments: StudioSettings.Appearance.allCases)
    func appearanceSymbolsResolve(appearance: StudioSettings.Appearance) {
        #expect(NSImage(systemSymbolName: appearance.symbol, accessibilityDescription: nil) != nil)
    }

    @Test("the Settings slider clamps the text size to the zoom range and persists it")
    func readingScaleSlider() {
        let settings = settings()
        settings.setReadingScale(1.234)
        #expect(settings.readingScale == 1.23)
        settings.setReadingScale(9)
        #expect(settings.readingScale == StudioSettings.readingScaleMax)
        settings.setReadingScale(0.1)
        #expect(settings.readingScale == StudioSettings.readingScaleMin)
        #expect(self.settings().readingScale == StudioSettings.readingScaleMin)
    }

    @Test("the Shortcuts tab lists every chord, menu-only ones included, and filters by label or alias")
    func shortcutsTab() {
        let listed = ShortcutsSettingsTab.sections(matching: "").flatMap(\.actions).map(\.id)
        let chorded = CommandRegistry.allActions.filter { !CommandRegistry.shortcut(for: $0.id).isEmpty }.map(\.id)
        #expect(listed == chorded)
        #expect(listed.contains("zoom-in"), "⌘= lives in nativeShortcuts, not on the action")
        let blur = ShortcutsSettingsTab.sections(matching: "  BLUR ").flatMap(\.actions).map(\.id)
        #expect(blur == ["toggle-focus-blur"])
        #expect(ShortcutsSettingsTab.sections(matching: "sidebar").flatMap(\.actions).map(\.id)
            .contains("go-to-documents"), "matches an alias")
        #expect(ShortcutsSettingsTab.sections(matching: "zzz").isEmpty)
    }
}

@Suite("Reading time")
struct ReadingTimeTests {
    /// The web's `reading-time.test.ts` values.
    @Test(arguments: [(0, 0), (-50, 0), (1, 1), (30, 1), (200, 1), (201, 2), (2_400, 12)])
    func minutes(words: Int, expected: Int) {
        #expect(ReadingTime.minutes(wordCount: words) == expected)
    }

    @Test(arguments: [(0, "0 min"), (1, "1 min"), (12, "12 min")])
    func format(minutes: Int, expected: String) {
        #expect(ReadingTime.format(minutes: minutes) == expected)
    }
}
