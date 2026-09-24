//
//  MarkdownStyler.swift
//  RectoEditor
//

import AppKit
import MarkdownEngine

/// Everything about how Recto renders one document, in one value.
///
/// This is Recto's opinion about the engine: which presentation, which type
/// scale, which colours, how wide the reading column is. Its one job is
/// ``engineConfiguration()`` — turning that opinion into the
/// `MarkdownEditorConfiguration` the engine consumes. Nothing else in the app
/// should build one of those by hand.
public struct MarkdownStyler: Sendable, Equatable {
    /// Which lens the document is shown through.
    public var presentation: Presentation
    /// Colours, by role.
    public var theme: RectoEditorTheme
    /// Type scale. Defaults to the one the presentation implies.
    public var typography: RectoTypography
    /// The prose face, kept here so a lens switch rebuilds the right scale.
    public var readingFont: ReadingFont
    /// Width of the centred writing column. `nil` fills the view.
    public var readingWidth: CGFloat?
    /// Spelling and grammar squiggles. The engine reads this when it builds
    /// the text view; a later change reaches a live view only through
    /// `NSTextView`'s own toggles, which the app drives.
    public var spellChecking: Bool
    /// Who owns undo. Recto's undo tree does, so the engine registers nothing.
    public var undo: UndoPolicy
    /// Smart paste: rich-mode paste turns an HTML flavor into Markdown. Off
    /// pastes the plain text. Read at paste time, so a toggle applies at once.
    public var convertsPastedHTML: Bool
    /// The writing column as a sheet on the atmosphere, rather than the sheet
    /// colour edge to edge. Presentation only; the engine never sees it.
    public var showsSheet: Bool

    /// Room around the text inside the sheet, each side.
    public static let sheetMargin: CGFloat = 56

    /// The sheet's width: the reading column and its margins.
    public var sheetWidth: CGFloat? { readingWidth.map { $0 + 2 * Self.sheetMargin } }

    public init(
        presentation: Presentation = .rich,
        theme: RectoEditorTheme = .twilight,
        typography: RectoTypography? = nil,
        readingFont: ReadingFont = .serif,
        readingWidth: CGFloat? = 720,
        spellChecking: Bool = true,
        undo: UndoPolicy = .external,
        convertsPastedHTML: Bool = true,
        showsSheet: Bool = false
    ) {
        self.presentation = presentation
        self.theme = theme
        self.readingFont = readingFont
        self.typography = typography ?? .forPresentation(presentation, readingFont: readingFont)
        self.readingWidth = readingWidth
        self.spellChecking = spellChecking
        self.undo = undo
        self.convertsPastedHTML = convertsPastedHTML
        self.showsSheet = showsSheet
    }

    /// The same styler at a different presentation, with the matching scale.
    /// Preserves the reader's text-size control across the switch.
    public func presenting(_ presentation: Presentation) -> MarkdownStyler {
        var copy = self
        copy.presentation = presentation
        copy.typography = .forPresentation(
            presentation, scale: typography.scale, readingFont: readingFont)
        return copy
    }

    // MARK: - Engine configuration

    /// Translate into the engine's configuration.
    ///
    /// Marker reveal is per inline node and per heading line, which is the
    /// engine's own behaviour and exactly design §4.2's rule — the caret
    /// entering a run reveals that run's markers and nothing else. Preview
    /// needs no separate marker setting: with editing off, the engine passes
    /// no caret location to the styler, so every marker in the document stays
    /// hidden.
    public func engineConfiguration() -> MarkdownEditorConfiguration {
        MarkdownEditorConfiguration(
            theme: engineTheme,
            services: MarkdownEditorServices(
                syntaxHighlighter: RectoCodeStyle(theme: theme)
            ),
            markers: MarkerStyle(hiddenMarkerFontSize: 0.1),
            codeBlock: CodeBlockStyle(fontSizeScale: 0.85, horizontalIndent: 12),
            inlineCode: InlineCodeStyle(fontSizeScale: 0.85),
            lists: ListStyle(
                // `helpersEnabled` is misleadingly named: as well as the
                // editing helpers it gates the DRAWN bullets, numbers and task
                // boxes. Off for preview would leave preview showing raw `-`
                // markers, so it tracks "not raw", not "editable".
                helpersEnabled: !presentation.showsSource,
                // Auto-closing pairs are pure input, and raw is source: what
                // the reader types is what the file gets.
                autoClosePairsEnabled: presentation == .rich
            ),
            headings: HeadingStyle(
                fontMultipliers: typography.headingMultipliers,
                topSpacingEm: typography.headingTopSpacingEm
            ),
            paragraph: ParagraphStyle(
                // Gap between paragraphs, in line heights.
                spacingFactor: 0,
                lineHeightExtraSpacing: typography.lineHeightExtraSpacing
            ),
            textInsets: TextInsets(horizontal: 0, vertical: 32),
            readingWidth: readingWidth,
            // Autocorrect is left to the OS setting: the web's toggle is the
            // squiggles, not what gets typed.
            spellChecking: SpellCheckingPolicy(
                continuousSpellChecking: spellChecking,
                grammarChecking: spellChecking
            ),
            undo: undo,
            rawSourceMode: presentation.showsSource,
            // The one construct beyond CommonMark + GFM tables that Recto's
            // dialect has and the engine does not build in.
            extensions: [StrikethroughExtension()],
            convertsPastedHTML: convertsPastedHTML
        )
    }

    private var engineTheme: MarkdownEditorTheme {
        MarkdownEditorTheme(
            bodyText: theme.ink,
            mutedText: theme.ink3,
            headingMarker: theme.ink3,
            link: theme.accent2,
            incompleteLink: theme.ink3,
            findMatchHighlight: theme.accent.withAlphaComponent(0.28),
            findCurrentMatchHighlight: theme.accent.withAlphaComponent(0.5),
            strikethroughColor: theme.ink3,
            highlightColor: theme.accent.withAlphaComponent(0.24)
        )
    }
}
