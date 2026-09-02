import AppKit
import Foundation
import Highlighter
import MarkdownEngine

/// Recto's fenced-code renderer, backed by Highlight.js through
/// HighlighterSwift. The editor only consumes foreground colours from the
/// result, so its font, fill and paragraph geometry remain Recto-owned.
final class RectoCodeStyle: SyntaxHighlighter {
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
            .highlight(code: code, infoString: language)
    }

    /// Light or dark is Recto's theme's decision, not the system appearance's,
    /// and theme changes already reach the engine through `styleRevision`.
    /// Subscribing here would only add a redundant full-document restyle on
    /// every mount, when the view joins its window.
    var appearanceDidChangeNotification: Notification.Name? { nil }
}

/// Highlighter initialization evaluates the bundled Highlight.js runtime.
/// One instance per colour scheme keeps SwiftUI view updates from paying that
/// cost again while preserving separate mutable theme state.
private final class RectoCodeHighlighter {
    private static let maxHighlightedUTF16Length = 1_500
    private static let maxLanguageUTF16Length = 128
    private static let maxRememberedUnknownLanguages = 256
    static let dark = RectoCodeHighlighter(theme: "github-dark")
    static let light = RectoCodeHighlighter(theme: "github")

    private let highlighter: Highlighter?
    private let cache = NSCache<NSString, NSAttributedString>()
    private var knownLanguages: Set<String>
    private var unknownLanguages: Set<String> = []

    private init(theme: String) {
        highlighter = Highlighter()
        cache.countLimit = 128
        cache.totalCostLimit = 2_000_000
        _ = highlighter?.setTheme(theme)
        knownLanguages = Set(highlighter?.supportedLanguages().map { $0.lowercased() } ?? [])
    }

    func highlight(code: String, infoString: String?) -> NSAttributedString? {
        // Highlight.js reparses the whole block synchronously. Above this
        // bound, plain code preserves the editor's 8 ms typing budget; splitting
        // by line would miscolour multiline strings and comments.
        guard code.utf16.count <= Self.maxHighlightedUTF16Length else { return nil }
        guard let highlighter, let language = language(from: infoString) else { return nil }
        let cacheKey = "\(language.utf16.count):\(language)\(code)" as NSString
        if let cached = cache.object(forKey: cacheKey),
           cached.length == (code as NSString).length,
           cached.string == code {
            return cached
        }

        guard let highlighted = highlighter.highlight(code, as: language),
              highlighted.length == (code as NSString).length,
              highlighted.string == code else { return nil }

        let result = NSAttributedString(attributedString: highlighted)
        cache.setObject(result, forKey: cacheKey, cost: result.length)
        return result
    }

    /// The Highlight.js name for a fence's info string, or nil for plain code.
    ///
    /// Only the first word names the language (CommonMark); the rest is
    /// attributes such as `{.numberLines}`. A fence with no usable language
    /// stays plain rather than going through `highlightAuto`, which tries every
    /// grammar (measured ~120 ms per keystroke at the length bound, against an
    /// 8 ms budget) and paints prose with whichever grammar scores best.
    private func language(from infoString: String?) -> String? {
        guard let infoString else { return nil }
        let word = infoString.drop(while: \.isWhitespace).prefix(while: { !$0.isWhitespace })
        guard !word.isEmpty, word.utf16.count <= Self.maxLanguageUTF16Length else { return nil }
        let name = word.lowercased()
        if knownLanguages.contains(name) { return name }
        if unknownLanguages.contains(name) { return nil }

        // `supportedLanguages()` lists registered grammars only; aliases such as
        // `js`, `py`, `sh` and `ts` resolve inside Highlight.js. Probing with
        // empty code costs microseconds for an alias and one thrown JS error
        // (~0.7 ms) for a genuinely unknown tag, so remember both answers.
        if highlighter?.highlight("", as: name) != nil {
            knownLanguages.insert(name)
            return name
        }
        if unknownLanguages.count >= Self.maxRememberedUnknownLanguages {
            unknownLanguages.removeAll(keepingCapacity: true)
        }
        unknownLanguages.insert(name)
        return nil
    }
}

private extension RectoEditorTheme {
    var isDark: Bool {
        guard let sheet = sheet.usingColorSpace(.sRGB) else { return true }
        return sheet.brightnessComponent < 0.5
    }
}
