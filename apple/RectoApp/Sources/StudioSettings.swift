import AppKit
import Observation
import RectoCoreJS
import RectoEditor
import RectoHistory
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

    /// The preview presentation's render, `PreviewVariant` in
    /// `settings-schema.ts`: the rendered Markdown, or the inbox chrome around
    /// it. A variant of preview, not a fifth mode (plan 008).
    enum PreviewVariant: String, CaseIterable {
        case rendered, email
    }

    /// How an accepted AI transform lands: shown with Keep / Reject, or applied.
    enum AITransformMode: String {
        case pending, replace
    }

    /// How a compare lays out, `DiffLayout` on the web.
    enum DiffLayout: String {
        case inline
        case sideBySide = "side-by-side"
    }

    enum Key {
        static let appearance = "studio.appearance"
        static let palette = "studio.theme"
        static let readingFont = "studio.readingFont"
        static let smartPaste = "studio.smartPaste"
        static let focusDim = "studio.focusDim"
        static let diffGranularity = "studio.diffGranularity"
        static let aiEnabled = "studio.aiEnabled"
        static let aiTransformMode = "studio.aiTransformMode"
        static let diffLayout = "studio.diffLayout"
        static let focusDimScope = "studio.focusDimScope"
        static let lint = "studio.lint"
        static func lintCategory(_ category: LintCategory) -> String { "studio.lint.\(category.rawValue)" }
        static let previewVariant = "studio.previewVariant"
        static let wordGoalTarget = "studio.wordGoalTarget"
        static let dailyGoalTarget = "studio.dailyGoalTarget"
        static let wordGoalKind = "studio.wordGoalKind"
        static let goalScope = "studio.goalScope"
        static let goalStyle = "studio.goalStyle"
        static let readingScale = "studio.readingScale"
        static let spellcheck = "studio.spellcheck"
        static let typewriter = "studio.typewriter"
        static let showToolbar = "studio.topToolbar"
        static let showStatusBar = "studio.statusBar"
        static let showOutline = "studio.outline"
        static let quietChrome = "studio.quietChrome"
        static let showsSheet = "studio.sheet"
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

    /// AI is opt-in, off until the writer turns it on and accepts the notice.
    var aiEnabled: Bool {
        didSet { defaults.set(aiEnabled, forKey: Key.aiEnabled) }
    }

    var aiTransformMode: AITransformMode {
        didSet { defaults.set(aiTransformMode.rawValue, forKey: Key.aiTransformMode) }
    }

    /// Compare splits by word or by line.
    var diffGranularity: DiffGranularity {
        didSet { defaults.set(diffGranularity.rawValue, forKey: Key.diffGranularity) }
    }

    var diffLayout: DiffLayout {
        didSet { defaults.set(diffLayout.rawValue, forKey: Key.diffLayout) }
    }

    /// Dim everything but the sentence or paragraph being written (plan 003).
    var focusDim: Bool {
        didSet { defaults.set(focusDim, forKey: Key.focusDim) }
    }

    var focusDimScope: FocusDimScope {
        didSet { defaults.set(focusDimScope.rawValue, forKey: Key.focusDimScope) }
    }

    /// The prose linter's master switch; off until the writer wants it (plan 004).
    var lint: Bool {
        didSet { defaults.set(lint, forKey: Key.lint) }
    }

    /// Per-category switches, all on, so turning the linter on shows everything.
    private(set) var lintCategories: Set<LintCategory> {
        didSet {
            for category in LintCategory.allCases {
                defaults.set(lintCategories.contains(category), forKey: Key.lintCategory(category))
            }
        }
    }

    /// Rich paste turns HTML (Word, Docs, the web) into Markdown (plan 007).
    var smartPaste: Bool {
        didSet { defaults.set(smartPaste, forKey: Key.smartPaste) }
    }

    var previewVariant: PreviewVariant {
        didSet { defaults.set(previewVariant.rawValue, forKey: Key.previewVariant) }
    }

    /// Per-document word goal. 0 = no goal, which hides the widget.
    private(set) var wordGoalTarget: Int {
        didSet { defaults.set(wordGoalTarget, forKey: Key.wordGoalTarget) }
    }

    /// Daily word goal. 0 = no daily goal.
    private(set) var dailyGoalTarget: Int {
        didSet { defaults.set(dailyGoalTarget, forKey: Key.dailyGoalTarget) }
    }

    /// Direction of both goals.
    var wordGoalKind: GoalKind {
        didSet { defaults.set(wordGoalKind.rawValue, forKey: Key.wordGoalKind) }
    }

    var goalScope: GoalScope {
        didSet { defaults.set(goalScope.rawValue, forKey: Key.goalScope) }
    }

    var goalStyle: GoalStyle {
        didSet { defaults.set(goalStyle.rawValue, forKey: Key.goalStyle) }
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

    /// The web's outline panel ships hidden (`outlineOpen` in
    /// `settings-schema.ts`).
    var showOutline: Bool {
        didSet { defaults.set(showOutline, forKey: Key.showOutline) }
    }

    /// The toolbar and status bar fade while the writer types and come back
    /// when the pointer moves. Native only; on by default.
    var quietChrome: Bool {
        didSet { defaults.set(quietChrome, forKey: Key.quietChrome) }
    }

    /// The writing column as a sheet on the palette's atmosphere (design
    /// §2's signature), or the sheet colour edge to edge. Native only; on by
    /// default.
    var showsSheet: Bool {
        didSet { defaults.set(showsSheet, forKey: Key.showsSheet) }
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
        smartPaste = defaults.object(forKey: Key.smartPaste) as? Bool ?? true
        focusDim = defaults.object(forKey: Key.focusDim) as? Bool ?? false
        aiEnabled = defaults.object(forKey: Key.aiEnabled) as? Bool ?? false
        aiTransformMode = defaults.string(forKey: Key.aiTransformMode).flatMap(AITransformMode.init(rawValue:)) ?? .pending
        diffGranularity = defaults.string(forKey: Key.diffGranularity).flatMap(DiffGranularity.init(rawValue:)) ?? .word
        diffLayout = defaults.string(forKey: Key.diffLayout).flatMap(DiffLayout.init(rawValue:)) ?? .inline
        focusDimScope = defaults.string(forKey: Key.focusDimScope).flatMap(FocusDimScope.init(rawValue:)) ?? .sentence
        lint = defaults.object(forKey: Key.lint) as? Bool ?? false
        lintCategories = Set(LintCategory.allCases.filter {
            defaults.object(forKey: Key.lintCategory($0)) as? Bool ?? true
        })
        previewVariant = defaults.string(forKey: Key.previewVariant)
            .flatMap(PreviewVariant.init(rawValue:)) ?? .rendered
        wordGoalTarget = (defaults.object(forKey: Key.wordGoalTarget) as? NSNumber)
            .map { WritingGoals.clampTarget($0.doubleValue) } ?? 0
        dailyGoalTarget = (defaults.object(forKey: Key.dailyGoalTarget) as? NSNumber)
            .map { WritingGoals.clampTarget($0.doubleValue) } ?? 0
        wordGoalKind = defaults.string(forKey: Key.wordGoalKind).flatMap(GoalKind.init(rawValue:)) ?? .atLeast
        goalScope = defaults.string(forKey: Key.goalScope).flatMap(GoalScope.init(rawValue:)) ?? .document
        goalStyle = defaults.string(forKey: Key.goalStyle).flatMap(GoalStyle.init(rawValue:)) ?? .ring
        readingScale = (defaults.object(forKey: Key.readingScale) as? Double)
            .map(Self.clampScale) ?? Self.readingScaleDefault
        spellcheck = defaults.object(forKey: Key.spellcheck) as? Bool ?? true
        typewriter = defaults.object(forKey: Key.typewriter) as? Bool ?? false
        showToolbar = defaults.object(forKey: Key.showToolbar) as? Bool ?? true
        showStatusBar = defaults.object(forKey: Key.showStatusBar) as? Bool ?? true
        showOutline = defaults.object(forKey: Key.showOutline) as? Bool ?? false
        quietChrome = defaults.object(forKey: Key.quietChrome) as? Bool ?? true
        showsSheet = defaults.object(forKey: Key.showsSheet) as? Bool ?? true
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
    func toggleSmartPaste() { smartPaste.toggle() }
    func toggleFocusDim() { focusDim.toggle() }
    func toggleAITransformMode() { aiTransformMode = aiTransformMode == .pending ? .replace : .pending }
    func toggleDiffGranularity() { diffGranularity = diffGranularity == .word ? .line : .word }
    func toggleDiffLayout() { diffLayout = diffLayout == .inline ? .sideBySide : .inline }
    func cycleFocusDimScope() { focusDimScope = focusDimScope == .sentence ? .paragraph : .sentence }
    func toggleLint() { lint.toggle() }

    func toggleLintCategory(_ category: LintCategory) {
        if lintCategories.contains(category) {
            lintCategories.remove(category)
        } else {
            lintCategories.insert(category)
        }
    }
    func togglePreviewVariant() { previewVariant = previewVariant == .email ? .rendered : .email }
    func toggleGoalStyle() { goalStyle = goalStyle.next }
    func toggleGoalScope() { goalScope = goalScope.next }

    /// `clampGoalTarget`: a typed goal can never persist negative or fractional.
    func setWordGoalTarget(_ value: Double) { wordGoalTarget = WritingGoals.clampTarget(value) }
    func setDailyGoalTarget(_ value: Double) { dailyGoalTarget = WritingGoals.clampTarget(value) }
    func toggleTypewriter() { typewriter.toggle() }
    func toggleToolbar() { showToolbar.toggle() }
    func toggleStatusBar() { showStatusBar.toggle() }
    func toggleOutline() { showOutline.toggle() }
    func toggleQuietChrome() { quietChrome.toggle() }
    func toggleSheet() { showsSheet.toggle() }

    // MARK: - Styler

    /// The editor's rendering for one document at the current settings.
    func styler(presentation: Presentation) -> MarkdownStyler {
        MarkdownStyler(
            presentation: presentation,
            theme: theme,
            typography: .forPresentation(presentation, scale: readingScale, readingFont: readingFont),
            readingFont: readingFont,
            spellChecking: spellcheck,
            undo: .external,
            convertsPastedHTML: smartPaste,
            showsSheet: showsSheet
        )
    }
}
