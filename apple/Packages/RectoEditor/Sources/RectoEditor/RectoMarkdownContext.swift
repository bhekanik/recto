import Foundation
import MarkdownEngine

enum RectoMarkdownContext {
    static func intersectsFencedCode(in markdown: NSString, range: NSRange) -> Bool {
        semanticSpans(in: markdown).contains {
            $0.kind == .codeBlock
                && (intersects(range, $0.range)
                    || (range.length == 0
                        && range.location == NSMaxRange($0.range)
                        && $0.markerRanges.count == 1))
        }
    }

    static func semanticSpans(in markdown: NSString) -> [MarkdownSemanticSpan] {
        MarkdownSemanticProjection.make(
            markdown: markdown as String,
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
