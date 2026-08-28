import Foundation

/// Heading outline, matching `lib/outline/extract.ts` exactly.
///
/// Offsets are **UTF-16 code units** into the markdown, which is what
/// `NSTextContentStorage` and `NSRange` speak, so a heading offset can be
/// scrolled to without conversion. Empty headings are kept so `index` still
/// lines up with rendered document order.
///
/// This is the typing-path outline; `RectoCore.parseOutline` is the authority.
/// `SwiftPortTests` asserts the two agree on every corpus case.
public enum Outline {
    public static func parse(_ markdown: String) -> [OutlineHeading] {
        MarkdownProse.headings(in: markdown)
    }
}
