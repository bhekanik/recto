import Foundation
import Testing
@testable import Recto

/// `lib/review/anchor.test.ts`, case for case.
@Suite("Comment anchors")
struct CommentAnchorTests {
    private func at(_ text: String, _ needle: String) -> Int { (text as NSString).range(of: needle).location }
    private func slice(_ text: String, _ range: NSRange?) -> String? { range.map { (text as NSString).substring(with: $0) } }

    @Test("captures the quote plus a bounded context window")
    func create() {
        let md = "The quick brown fox jumps over the lazy dog."
        let from = at(md, "brown fox")
        let anchor = CommentAnchor.create(in: md, from: from, to: from + 9)
        #expect(anchor.quote == "brown fox")
        #expect(anchor.offsetHint == Double(from))
        #expect(anchor.suffix.hasPrefix(" jumps"))
        #expect(anchor.prefix.hasSuffix("quick "))
        #expect(anchor.prefix.utf16.count <= CommentAnchor.contextLength && anchor.suffix.utf16.count <= CommentAnchor.contextLength)
    }

    @Test("an empty selection grows to its word; a reversed range is normalized")
    func grows() {
        let md = "alpha beta gamma"
        #expect(CommentAnchor.create(in: md, from: at(md, "beta") + 2, to: at(md, "beta") + 2).quote == "beta")
        let three = "one two three"
        #expect(CommentAnchor.create(in: three, from: at(three, "two") + 3, to: at(three, "two")).quote == "two")
    }

    @Test("an unchanged document relocates to the original range")
    func unchanged() {
        let md = "The quiet river wound through the valley before the storm."
        let from = at(md, "wound through")
        let anchor = CommentAnchor.create(in: md, from: from, to: from + 13)
        #expect(anchor.locate(in: md) == NSRange(location: from, length: 13))
    }

    @Test("edits before and after the quote move it by its text")
    func insertions() {
        let md = "The river wound through the valley."
        let from = at(md, "wound through")
        let anchor = CommentAnchor.create(in: md, from: from, to: from + 13)
        let before = "A long new opening sentence was added here. \(md)"
        #expect(slice(before, anchor.locate(in: before)) == "wound through")
        #expect(anchor.locate(in: before)?.location != Int(anchor.offsetHint))
        let after = "\(md) It kept flowing for many more miles afterwards."
        #expect(slice(after, anchor.locate(in: after)) == "wound through")
    }

    @Test("a repeated quote is told apart by its context, either occurrence")
    func repeated() {
        let md = "Set the value to ten. Later, reset the value to zero."
        let second = (md as NSString).range(of: "the value", options: .backwards).location
        #expect(at(md, "the value") != second)
        #expect(CommentAnchor.create(in: md, from: second, to: second + 9).locate(in: md)?.location == second)
        let first = at(md, "the value")
        #expect(CommentAnchor.create(in: md, from: first, to: first + 9).locate(in: md)?.location == first)
    }

    @Test("a lightly edited quote is found approximately; a deleted one is lost")
    func fuzzyAndOrphan() {
        let md = "The committee reviewed the quarterly financial report in detail."
        let from = at(md, "quarterly financial report")
        let anchor = CommentAnchor.create(in: md, from: from, to: from + 26)
        let edited = "The committee reviewed the quarterly financials report in detail."
        #expect(slice(edited, anchor.locate(in: edited))?.contains("financials report") == true)

        let md2 = "Keep this paragraph. Delete the targeted sentence entirely here."
        let from2 = at(md2, "the targeted sentence entirely")
        let gone = CommentAnchor.create(in: md2, from: from2, to: from2 + 30)
        #expect(gone.locate(in: "Keep this paragraph. Different unrelated content now.") == nil)
        #expect(CommentAnchor(quote: "", prefix: "", suffix: "", offsetHint: 0).locate(in: "anything") == nil)
    }

    @Test("offsets are UTF-16 so the web reads the same anchor")
    func utf16() {
        let md = "😀 emoji first, then the quote here."
        let from = at(md, "the quote")
        let anchor = CommentAnchor.create(in: md, from: from, to: from + 9)
        #expect(anchor.offsetHint == 21, "the index JavaScript gives")
        #expect(anchor.locate(in: md) == NSRange(location: 21, length: 9))
    }
}
