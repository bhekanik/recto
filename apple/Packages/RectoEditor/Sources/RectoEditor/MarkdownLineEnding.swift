import Foundation
import MarkdownEngine

/// The newline sequence Recto inserts into a Markdown document.
public enum MarkdownLineEnding: String, Sendable {
    case lineFeed = "\n"
    case carriageReturnLineFeed = "\r\n"

    public init(detecting markdown: String) {
        let source = markdown as NSString
        for location in 0..<source.length {
            switch source.character(at: location) {
            case 0x0A:
                self = .lineFeed
                return
            case 0x0D where location + 1 < source.length
                && source.character(at: location + 1) == 0x0A:
                self = .carriageReturnLineFeed
                return
            case 0x0D:
                self = .lineFeed
                return
            default:
                continue
            }
        }
        self = .lineFeed
    }

    func applying(_ mutation: MarkdownTextMutation, to markdown: String)
        -> (markdown: String, mutation: MarkdownTextMutation)? {
        let source = markdown as NSString
        guard mutation.range.location != NSNotFound,
              mutation.range.location >= 0,
              mutation.range.length >= 0,
              NSMaxRange(mutation.range) <= source.length else { return nil }

        var range = mutation.range
        var replacement = normalize(mutation.replacement)
        if range.length == 0, splitsCRLF(at: range.location, in: source) {
            range = NSRange(location: range.location - 1, length: 2)
            replacement = rawValue + replacement
        } else if range.length > 0 {
            if splitsCRLF(at: range.location, in: source) {
                range.location -= 1
                range.length += 1
            }
            if splitsCRLF(at: NSMaxRange(range), in: source) {
                range.length += 1
            }
        }

        let normalized = MarkdownTextMutation(range: range, replacement: replacement)
        return (
            source.replacingCharacters(in: range, with: replacement),
            normalized
        )
    }

    public func normalize(_ text: String) -> String {
        var result = ""
        result.reserveCapacity(text.utf8.count)
        let scalars = text.unicodeScalars
        var index = scalars.startIndex
        while index < scalars.endIndex {
            let scalar = scalars[index]
            if scalar.value == 0x0D {
                let next = scalars.index(after: index)
                if next < scalars.endIndex, scalars[next].value == 0x0A {
                    index = next
                }
                result += rawValue
            } else if scalar.value == 0x0A {
                result += rawValue
            } else {
                result.unicodeScalars.append(scalar)
            }
            index = scalars.index(after: index)
        }
        return result
    }

    private func splitsCRLF(at location: Int, in text: NSString) -> Bool {
        location > 0 && location < text.length
            && text.character(at: location - 1) == 0x0D
            && text.character(at: location) == 0x0A
    }
}
