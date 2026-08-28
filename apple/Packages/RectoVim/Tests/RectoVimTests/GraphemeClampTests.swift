import Foundation
import Testing

@testable import RectoVim

/// `GraphemeClamp` guards positions of *native* origin on their way into the
/// engine. These are the clusters the N0c spike showed the vim core severing.
@Suite("GraphemeClamp")
struct GraphemeClampTests {
    static let samples: [(name: String, cluster: String)] = [
        ("ZWJ family", "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}"),
        ("regional-indicator flag", "\u{1F1FF}\u{1F1E6}"),
        ("skin-tone modifier", "\u{1F44D}\u{1F3FD}"),
        ("combining mark", "e\u{0301}"),
        ("single-codepoint emoji", "\u{1F3A9}"),
    ]

    @Test("every interior offset resolves to the same cluster", arguments: samples)
    func interiorOffsets(sample: (name: String, cluster: String)) {
        let text = "a\(sample.cluster)b" as NSString
        let width = sample.cluster.utf16.count
        for offset in 2..<(1 + width) {
            #expect(GraphemeClamp.clusterStart(in: text, offset: offset) == 1, "\(sample.name)")
            #expect(
                GraphemeClamp.clusterEnd(in: text, offset: offset) == 1 + width, "\(sample.name)")
            #expect(!GraphemeClamp.isBoundary(in: text, offset: offset), "\(sample.name)")
        }
    }

    @Test("boundaries are fixed points", arguments: samples)
    func boundaries(sample: (name: String, cluster: String)) {
        let text = "a\(sample.cluster)b" as NSString
        for offset in [0, 1, 1 + sample.cluster.utf16.count, text.length] {
            #expect(GraphemeClamp.clusterStart(in: text, offset: offset) == offset)
            #expect(GraphemeClamp.clusterEnd(in: text, offset: offset) == offset)
            #expect(GraphemeClamp.isBoundary(in: text, offset: offset))
        }
    }

    @Test("a range that bisects a cluster is widened", arguments: samples)
    func rangeWidens(sample: (name: String, cluster: String)) {
        let text = "a\(sample.cluster)b" as NSString
        let width = sample.cluster.utf16.count
        let bisecting = NSRange(location: 1, length: 1)
        #expect(
            GraphemeClamp.range(in: text, bisecting) == NSRange(location: 1, length: width),
            "\(sample.name)")
    }

    @Test("clamping is total for out-of-range offsets")
    func outOfRange() {
        let text = "ab" as NSString
        #expect(GraphemeClamp.caret(in: text, offset: -5) == 0)
        #expect(GraphemeClamp.caret(in: text, offset: 99) == 2)
        #expect(
            GraphemeClamp.range(in: text, NSRange(location: -3, length: 99))
                == NSRange(location: 0, length: 2))
    }

    @Test("ASCII is untouched")
    func ascii() {
        let text = "hello" as NSString
        for offset in 0...text.length {
            #expect(GraphemeClamp.caret(in: text, offset: offset) == offset)
        }
    }
}
