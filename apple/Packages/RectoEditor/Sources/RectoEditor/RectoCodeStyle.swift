import AppKit
import Foundation
import Highlighter
import MarkdownEngine

/// Recto's fenced-code renderer, backed by Highlight.js through
/// HighlighterSwift. The editor only consumes foreground colours from the
/// result, so its font, fill and paragraph geometry remain Recto-owned.
final class RectoCodeStyle: SyntaxHighlighter, @unchecked Sendable {
    static let appearanceDidChange = Notification.Name(
        "com.bhekani.recto.code-style.appearance-did-change"
    )
    private let theme: RectoEditorTheme

    init(theme: RectoEditorTheme) {
        self.theme = theme
    }

    func codeFont(size: CGFloat) -> NSFont {
        RectoFonts.register()
        return NSFont(name: RectoFonts.sourceFamily, size: size)
            ?? .monospacedSystemFont(ofSize: size, weight: .regular)
    }

    func backgroundColor() -> NSColor { theme.raised }

    func highlight(code: String, language: String?) -> NSAttributedString? {
        (theme.isDark ? RectoCodeHighlighter.dark : .light)
            .highlight(code: code, language: language)
    }

    var appearanceDidChangeNotification: Notification.Name? {
        Self.appearanceDidChange
    }
}

/// Highlighter initialization evaluates the bundled Highlight.js runtime.
/// One instance per colour scheme keeps SwiftUI view updates from paying that
/// cost again while preserving separate mutable theme state.
private final class RectoCodeHighlighter: @unchecked Sendable {
    private static let maxHighlightedUTF16Length = 1_500
    private static let maxLanguageUTF16Length = 128
    static let dark = RectoCodeHighlighter(theme: "github-dark")
    static let light = RectoCodeHighlighter(theme: "github")

    private let highlighter: Highlighter?
    private let cache = NSCache<NSString, NSAttributedString>()

    private init(theme: String) {
        highlighter = Highlighter()
        cache.countLimit = 128
        cache.totalCostLimit = 2_000_000
        _ = highlighter?.setTheme(theme)
    }

    func highlight(code: String, language: String?) -> NSAttributedString? {
        // Highlight.js reparses the whole block synchronously. Above this
        // bound, plain code preserves the editor's 8 ms typing budget; splitting
        // by line would miscolour multiline strings and comments.
        guard code.utf16.count <= Self.maxHighlightedUTF16Length else { return nil }
        guard let highlighter else { return nil }
        let explicitLanguage = language.flatMap { language -> String? in
            guard language.utf16.count <= Self.maxLanguageUTF16Length else { return nil }
            let normalized = language
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
            return normalized.isEmpty ? nil : normalized
        }
        let languageKey = explicitLanguage ?? ""
        let cacheKey = "\(languageKey.utf16.count):\(languageKey)\(code)" as NSString
        if let cached = cache.object(forKey: cacheKey),
           cached.length == (code as NSString).length,
           cached.string == code {
            return cached
        }

        var highlighted: NSAttributedString?
        if let explicitLanguage {
            highlighted = highlighter.highlight(code, as: explicitLanguage)
        }
        highlighted = highlighted ?? highlighter.highlight(code)
        guard let highlighted,
              highlighted.length == (code as NSString).length,
              highlighted.string == code else { return nil }

        let result = NSAttributedString(attributedString: highlighted)
        cache.setObject(result, forKey: cacheKey, cost: result.length)
        return result
    }
}

private extension RectoEditorTheme {
    var isDark: Bool {
        guard let sheet = sheet.usingColorSpace(.sRGB) else { return true }
        return sheet.brightnessComponent < 0.5
    }
}
