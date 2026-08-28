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
    /// Width of the centred writing column. `nil` fills the view.
    public var readingWidth: CGFloat?
    /// Who owns undo. Recto's undo tree does, so the engine registers nothing.
    public var undo: UndoPolicy

    public init(
        presentation: Presentation = .rich,
        theme: RectoEditorTheme = .twilight,
        typography: RectoTypography? = nil,
        readingWidth: CGFloat? = 720,
        undo: UndoPolicy = .external
    ) {
        self.presentation = presentation
        self.theme = theme
        self.typography = typography ?? .forPresentation(presentation)
        self.readingWidth = readingWidth
        self.undo = undo
    }

    /// The same styler at a different presentation, with the matching scale.
    /// Preserves the reader's text-size control across the switch.
    public func presenting(_ presentation: Presentation) -> MarkdownStyler {
        var copy = self
        copy.presentation = presentation
        copy.typography = .forPresentation(presentation, scale: typography.scale)
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
                helpersEnabled: presentation != .raw,
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
                spacingFactor: 0.6,
                lineHeightExtraSpacing: typography.lineHeightExtraSpacing
            ),
            textInsets: TextInsets(horizontal: 0, vertical: 32),
            readingWidth: readingWidth,
            undo: undo,
            rawSourceMode: presentation == .raw,
            // The one construct beyond CommonMark + GFM tables that Recto's
            // dialect has and the engine does not build in.
            extensions: [StrikethroughExtension()]
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

    public static func == (lhs: MarkdownStyler, rhs: MarkdownStyler) -> Bool {
        lhs.presentation == rhs.presentation
            && lhs.theme == rhs.theme
            && lhs.typography == rhs.typography
            && lhs.readingWidth == rhs.readingWidth
            && lhs.undo == rhs.undo
    }
}

/// Code-block face and fill. No syntax highlighting yet — language colouring
/// is stage 2 (W9b), along with the language tag in the block's top-right.
struct RectoCodeStyle: SyntaxHighlighter {
    let theme: RectoEditorTheme

    func codeFont(size: CGFloat) -> NSFont {
        RectoFonts.register()
        return NSFont(name: RectoFonts.sourceFamily, size: size)
            ?? .monospacedSystemFont(ofSize: size, weight: .regular)
    }

    func backgroundColor() -> NSColor { theme.raised }

    func highlight(code: String, language: String?) -> NSAttributedString? { nil }

    var appearanceDidChangeNotification: Notification.Name? { nil }
}
