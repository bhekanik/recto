//
//  RectoFonts.swift
//  RectoEditor
//

import AppKit
import CoreText

/// The two faces Recto writes in, bundled with the package so the editor looks
/// the same on a Mac that has never seen them.
///
/// Both are SIL Open Font License 1.1; the licence files sit beside the TTFs
/// in `Resources/Fonts` and ship with the app.
public enum RectoFonts {
    /// Source Serif 4 — prose.
    public static let proseFamily = "Source Serif 4"
    /// The web's sans body face (`--font-app-sans`), for the reading-font toggle.
    public static let sansFamily = "Figtree"
    /// JetBrains Mono — Markdown source, code blocks, inline code.
    public static let sourceFamily = "JetBrains Mono"

    private static let files = [
        "SourceSerif4-Regular", "SourceSerif4-It", "SourceSerif4-Bold",
        "SourceSerif4-BoldIt", "SourceSerif4-Semibold",
        "JetBrainsMono-Regular", "JetBrainsMono-Italic",
        "JetBrainsMono-Bold", "JetBrainsMono-BoldItalic",
        "Figtree-Regular", "Figtree-Italic", "Figtree-SemiBold",
        "Figtree-Bold", "Figtree-BoldItalic",
    ]

    private static var didRegister = false

    /// Register the bundled faces with the process's font manager.
    ///
    /// Idempotent, and safe to call from anywhere that is about to build a
    /// font: every `RectoTypography` initialiser calls it. Registration is
    /// process-scoped (`.process`), so it neither touches nor requires the
    /// user's font library.
    public static func register() {
        guard !didRegister else { return }
        didRegister = true
        for file in files {
            guard let url = Bundle.module.url(forResource: file, withExtension: "ttf",
                                              subdirectory: "Fonts")
                ?? Bundle.module.url(forResource: file, withExtension: "ttf") else { continue }
            var error: Unmanaged<CFError>?
            // A duplicate registration (two RectoEditor copies in one process,
            // or the user having the font installed) is not a failure worth
            // reporting: the family resolves either way.
            _ = CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error)
        }
    }

    /// `true` when the named family resolves after registration — the check
    /// the tests use, and the signal that a build dropped the resources.
    public static func isAvailable(_ family: String) -> Bool {
        register()
        return NSFontManager.shared.availableFontFamilies.contains(family)
    }
}
