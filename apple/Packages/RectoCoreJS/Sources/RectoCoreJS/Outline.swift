import Foundation

/// Fast typing-path model of `lib/outline/extract.ts`.
///
/// Offsets are **UTF-16 code units** into the markdown, which is what
/// `NSTextContentStorage` and `NSRange` speak, so a heading offset can be
/// scrolled to without conversion. Empty headings are kept so `index` still
/// lines up with rendered document order.
///
/// It matches the JS core on the fixture, adversarial, and 256-document
/// differential gates. `RectoCore.parseOutline` remains the authority and
/// corrects this value at document boundaries. A real divergence is a new gate
/// case. `MarkdownProse` lists the omitted constructs.
public enum Outline {
    public static func parse(_ markdown: String) -> [OutlineHeading] {
        MarkdownProse.headings(in: markdown)
    }
}
