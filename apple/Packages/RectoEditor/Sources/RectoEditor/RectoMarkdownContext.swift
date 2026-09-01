import Foundation

enum RectoMarkdownContext {
    static func intersectsFencedCode(in markdown: NSString, range: NSRange) -> Bool {
        var fence: (character: unichar, length: Int, start: Int)?
        var cursor = 0
        while cursor <= markdown.length {
            var lineStart = 0
            var lineEnd = 0
            var contentsEnd = 0
            markdown.getLineStart(
                &lineStart,
                end: &lineEnd,
                contentsEnd: &contentsEnd,
                for: NSRange(location: min(cursor, markdown.length), length: 0)
            )
            let line = markdown.substring(with: NSRange(location: lineStart, length: contentsEnd - lineStart)) as NSString
            if let current = fence {
                if isClosingFence(line, character: current.character, minimumLength: current.length) {
                    if intersects(range, NSRange(location: current.start, length: lineEnd - current.start)) { return true }
                    fence = nil
                }
            } else if let opening = openingFence(line) {
                fence = (opening.character, opening.length, lineStart)
            }
            guard lineEnd > cursor else { break }
            cursor = lineEnd
        }
        if let fence {
            if range.length == 0 {
                return range.location >= fence.start && range.location <= markdown.length
            }
            return intersects(range, NSRange(location: fence.start, length: markdown.length - fence.start))
        }
        return false
    }

    private static func openingFence(_ line: NSString) -> (character: unichar, length: Int)? {
        var index = 0
        while index < line.length, index < 4, line.character(at: index) == 32 { index += 1 }
        guard index <= 3, index < line.length else { return nil }
        let character = line.character(at: index)
        guard character == 96 || character == 126 else { return nil }
        let start = index
        while index < line.length, line.character(at: index) == character { index += 1 }
        guard index - start >= 3 else { return nil }
        if character == 96,
           line.substring(from: index).contains("`") { return nil }
        return (character, index - start)
    }

    private static func isClosingFence(_ line: NSString, character: unichar, minimumLength: Int) -> Bool {
        var index = 0
        while index < line.length, index < 4, line.character(at: index) == 32 { index += 1 }
        guard index <= 3 else { return false }
        let start = index
        while index < line.length, line.character(at: index) == character { index += 1 }
        guard index - start >= minimumLength else { return false }
        while index < line.length, line.character(at: index) == 32 || line.character(at: index) == 9 { index += 1 }
        return index == line.length
    }

    private static func intersects(_ lhs: NSRange, _ rhs: NSRange) -> Bool {
        if lhs.length == 0 { return lhs.location >= rhs.location && lhs.location < NSMaxRange(rhs) }
        return lhs.location < NSMaxRange(rhs) && NSMaxRange(lhs) > rhs.location
    }
}
