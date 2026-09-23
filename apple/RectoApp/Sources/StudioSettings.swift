import AppKit
import Observation
import RectoEditor
import SwiftUI

/// The writer's studio knobs, after the web app's `useStudioSettings`: one
/// app-wide value, remembered across documents and launches.
///
/// Each setting is its own `UserDefaults` key rather than the web's single JSON
/// blob, so a bad value costs the writer one setting instead of all of them.
/// Anything unreadable falls back to the web's default.
@MainActor
@Observable
final class StudioSettings {
    /// Light/dark axis. `system` follows the OS (web ADR-20). Ordered as the
    /// web's `APPEARANCES`, which is the cycle order of the status-bar control.
    enum Appearance: String, CaseIterable {
        case system, light, dark

        var label: String {
            switch self {
            case .system: "System"
            case .light: "Light"
            case .dark: "Dark"
            }
        }

        /// SF Symbol for the web's lucide `Monitor` / `Sun` / `Moon`.
        var symbol: String {
            switch self {
            case .system: "desktopcomputer"
            case .light: "sun.max"
            case .dark: "moon"
            }
        }

        var next: Appearance {
            let all = Appearance.allCases
            let index = all.firstIndex(of: self) ?? 0
            return all[(index + 1) % all.count]
        }
    }

    enum ResolvedAppearance: Equatable {
        case light, dark
    }

    /// The web's `THEMES`: soft dark palettes, in cycle order. They apply only
    /// while the appearance resolves to dark; light is always Paper (ADR-20).
    enum Palette: String, CaseIterable {
        case twilight, aurora, dawn, moonlit

        var label: String { rawValue.capitalized }

        @MainActor var colors: RectoEditorTheme {
            switch self {
            case .twilight: .twilight
            case .aurora: .aurora
            case .dawn: .dawn
            case .moonlit: .moonlit
            }
        }

        var next: Palette {
            let all = Palette.allCases
            return all[((all.firstIndex(of: self) ?? 0) + 1) % all.count]
        }
    }

    enum Key {
        static let appearance = "studio.appearance"
        static let palette = "studio.theme"
        static let readingFont = "studio.readingFont"
        static let readingScale = "studio.readingScale"
        static let spellcheck = "studio.spellcheck"
        static let typewriter = "studio.typewriter"
        static let showToolbar = "studio.topToolbar"
        static let showStatusBar = "studio.statusBar"
    }

    /// The web's zoom steps: `READING_SCALE_MIN/MAX/STEP` in `settings-schema.ts`.
    static let readingScaleMin = 0.8
    static let readingScaleMax = 2.0
    static let readingScaleStep = 0.1
    static let readingScaleDefault = 1.0

    /// Created from `RectoApp`'s stored properties, which run before
    /// `NSApplication.shared` exists, so nothing here can observe the app yet;
    /// each window root arms that through ``followApplicationAppearance()``.
    static let shared = StudioSettings()

    var appearance: Appearance {
        didSet { defaults.set(appearance.rawValue, forKey: Key.appearance) }
    }

    var palette: Palette {
        didSet { defaults.set(palette.rawValue, forKey: Key.palette) }
    }

    /// Serif by default on the Mac, unlike the web's sans: Source Serif 4 is
    /// what the native editor was designed around, and changing a writer's
    /// face on update is not this setting's job.
    var readingFont: ReadingFont {
        didSet { defaults.set(readingFont.rawValue, forKey: Key.readingFont) }
    }

    /// Text-zoom multiplier for the reading column, 0.8…2.0.
    private(set) var readingScale: Double {
        didSet { defaults.set(readingScale, forKey: Key.readingScale) }
    }

    var spellcheck: Bool {
        didSet { defaults.set(spellcheck, forKey: Key.spellcheck) }
    }

    var typewriter: Bool {
        didSet { defaults.set(typewriter, forKey: Key.typewriter) }
    }

    var showToolbar: Bool {
        didSet { defaults.set(showToolbar, forKey: Key.showToolbar) }
    }

    var showStatusBar: Bool {
        didSet { defaults.set(showStatusBar, forKey: Key.showStatusBar) }
    }

    /// What the OS is showing right now; only consulted while `appearance` is
    /// `.system`.
    private(set) var systemAppearance: ResolvedAppearance

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let readSystemAppearance: @MainActor () -> ResolvedAppearance
    @ObservationIgnored private var appearanceObservation: NSKeyValueObservation?

    /// - Parameter systemAppearance: Where "what is the OS showing" comes from.
    ///   Injected so a test can flip it without touching the machine.
    init(
        defaults: UserDefaults = .standard,
        systemAppearance: @escaping @MainActor () -> ResolvedAppearance = StudioSettings.applicationAppearance
    ) {
        self.defaults = defaults
        readSystemAppearance = systemAppearance
        self.systemAppearance = systemAppearance()
        appearance = defaults.string(forKey: Key.appearance).flatMap(Appearance.init(rawValue:)) ?? .system
        palette = defaults.string(forKey: Key.palette).flatMap(Palette.init(rawValue:)) ?? .twilight
        readingFont = defaults.string(forKey: Key.readingFont).flatMap(ReadingFont.init(rawValue:)) ?? .serif
        readingScale = (defaults.object(forKey: Key.readingScale) as? Double)
            .map(Self.clampScale) ?? Self.readingScaleDefault
        spellcheck = defaults.object(forKey: Key.spellcheck) as? Bool ?? true
        typewriter = defaults.object(forKey: Key.typewriter) as? Bool ?? false
        showToolbar = defaults.object(forKey: Key.showToolbar) as? Bool ?? true
        showStatusBar = defaults.object(forKey: Key.showStatusBar) as? Bool ?? true
    }

    // MARK: - Appearance

    var resolvedAppearance: ResolvedAppearance {
        switch appearance {
        case .system: systemAppearance
        case .light: .light
        case .dark: .dark
        }
    }

    var theme: RectoEditorTheme {
        resolvedAppearance == .dark ? palette.colors : .paper
    }

    /// `THEMES.find(...).label` on the web; Paper while light, like the web's
    /// status bar reports.
    var themeLabel: String {
        resolvedAppearance == .dark ? palette.label : "Paper"
    }

    /// The dark palettes only exist while dark, so the control does nothing in light.
    var canCyclePalette: Bool { resolvedAppearance == .dark }

    func cyclePalette() {
        guard canCyclePalette else { return }
        palette = palette.next
    }

    /// For `.preferredColorScheme` at each window's root, so the chrome follows
    /// the editor. `nil` leaves the window on the OS setting.
    var preferredColorScheme: ColorScheme? {
        switch appearance {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    func cycleAppearance() {
        appearance = appearance.next
    }

    /// Re-read the OS appearance. The shared instance calls this from KVO; a
    /// test calls it after changing what its provider answers.
    func refreshSystemAppearance() {
        let current = readSystemAppearance()
        guard current != systemAppearance else { return }
        systemAppearance = current
    }

    /// The application's effective appearance, which tracks the OS as long as
    /// no window forces its own — which is why the roots use
    /// `.preferredColorScheme` rather than `NSApp.appearance`.
    static func applicationAppearance() -> ResolvedAppearance {
        let appearance = NSApp?.effectiveAppearance ?? NSAppearance.currentDrawing()
        return appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? .dark : .light
    }

    /// Start tracking the OS appearance through `NSApp.effectiveAppearance`.
    /// Idempotent, and a no-op until the application object exists, so a root
    /// view can call it on every appearance. Also re-reads the OS at once: the
    /// value taken at init may predate the application.
    func followApplicationAppearance() {
        guard appearanceObservation == nil, let application = NSApp else { return }
        appearanceObservation = application.observe(\.effectiveAppearance) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.refreshSystemAppearance() }
        }
        refreshSystemAppearance()
    }

    var isFollowingApplicationAppearance: Bool { appearanceObservation != nil }

    // MARK: - Text size

    var zoomPercent: Int { Int((readingScale * 100).rounded()) }
    var canZoomIn: Bool { readingScale < Self.readingScaleMax }
    var canZoomOut: Bool { readingScale > Self.readingScaleMin }

    func zoomIn() {
        readingScale = Self.clampScale(readingScale + Self.readingScaleStep)
    }

    func zoomOut() {
        readingScale = Self.clampScale(readingScale - Self.readingScaleStep)
    }

    func zoomReset() {
        readingScale = Self.readingScaleDefault
    }

    /// `clampScale` in `settings-schema.ts`: clamp, then round to two places so
    /// the displayed percentage never shows float drift.
    static func clampScale(_ value: Double) -> Double {
        guard value.isFinite else { return readingScaleDefault }
        let clamped = min(readingScaleMax, max(readingScaleMin, value))
        return (clamped * 100).rounded() / 100
    }

    // MARK: - Toggles

    func toggleSpellcheck() { spellcheck.toggle() }
    func toggleReadingFont() { readingFont = readingFont == .serif ? .sans : .serif }
    func toggleTypewriter() { typewriter.toggle() }
    func toggleToolbar() { showToolbar.toggle() }
    func toggleStatusBar() { showStatusBar.toggle() }

    // MARK: - Styler

    /// The editor's rendering for one document at the current settings.
    func styler(presentation: Presentation) -> MarkdownStyler {
        MarkdownStyler(
            presentation: presentation,
            theme: theme,
            typography: .forPresentation(presentation, scale: readingScale, readingFont: readingFont),
            readingFont: readingFont,
            spellChecking: spellcheck,
            undo: .external
        )
    }
}
