import Foundation
import MarkdownEngine

enum RectoMarkdownContext {
    static func intersectsFencedCode(in markdown: NSString, range: NSRange) -> Bool {
        semanticSpans(in: markdown, intersecting: range).contains {
            $0.kind == .codeBlock && intersectsCodeSpan(
                $0,
                range: range,
                documentLength: markdown.length
            )
        }
    }

    static func intersectsCodeSpan(
        _ span: MarkdownSemanticSpan,
        range: NSRange,
        documentLength: Int
    ) -> Bool {
        intersects(range, span.range)
            || (span.kind == .codeBlock
                && range.length == 0
                && range.location == documentLength
                && NSMaxRange(span.range) == documentLength
                && span.markerRanges.count < 2)
    }

    static func semanticSpans(
        in markdown: NSString,
        intersecting range: NSRange
    ) -> [MarkdownSemanticSpan] {
        MarkdownSemanticProjection.make(
            markdown: markdown as String,
            intersecting: range,
            configuration: MarkdownEditorConfiguration(
                extensions: [StrikethroughExtension()]
            )
        ).spans
    }

    static func intersects(_ lhs: NSRange, _ rhs: NSRange) -> Bool {
        if lhs.length == 0 {
            return lhs.location >= rhs.location && lhs.location < NSMaxRange(rhs)
        }
        return lhs.location < NSMaxRange(rhs) && NSMaxRange(lhs) > rhs.location
    }
}
