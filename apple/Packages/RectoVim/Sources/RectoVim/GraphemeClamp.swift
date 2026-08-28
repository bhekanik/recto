import Foundation

/// Snaps UTF-16 offsets to grapheme-cluster boundaries.
///
/// **The JS mirror is the authority, and this is not a second implementation of
/// the clamping.** `packages/recto-vim-js/src/grapheme.js` decides where the vim
/// core may put a cursor or an edit; this runs in one direction only, on offsets
/// of **native** origin — a mouse click, a caret the app placed, a range a host
/// `setText` reports — on their way *into* the engine. Offsets coming *out* of
/// the engine are applied verbatim, and `RectoVimTests` asserts this clamp is
/// the identity on every one of them, which is what would catch the two drifting
/// apart.
///
/// ## Why `Character` and not `NSString`
///
/// This used `NSString.rangeOfComposedCharacterSequence(at:)`, which is not
/// UAX #29: it splits `\r\n`, and it is a *composed character sequence*, a
/// narrower thing than an extended grapheme cluster. Swift's `Character` is the
/// extended grapheme cluster, from the same ICU the JS side's `Intl.Segmenter`
/// uses, and both are gated against Unicode's own `GraphemeBreakTest.txt`
/// (`GraphemeConformanceTests`, and the Bun suite on the other side). Agreeing
/// with the same conformance data is a far stronger claim than agreeing with
/// each other on the cases someone thought to write down — the previous pair
/// passed a hand-written suite while splitting Hangul syllables and CRLF.
///
/// ## Why a window
///
/// Walking `Character`s from the start of the document would be O(n) per
/// lookup, and the debug assertion in `VimTextViewAdapter` runs on every edit.
/// A cluster boundary is *provable* between two ASCII printable characters
/// (GB999 breaks between two Other-class scalars, and no ASCII printable is
/// Extend, ZWJ, Prepend, SpacingMark or a regional indicator), so scanning back
/// a short way for such a pair gives a start position that is certainly a
/// boundary, and the walk only has to cover the window from there.
public enum GraphemeClamp {
    /// How far back to look for a provable boundary before giving up and
    /// starting from the beginning of the string. Long enough to clear any
    /// cluster that occurs in real text by orders of magnitude.
    private static let contextWindow = 256

    /// The start of the cluster containing `offset`, clamped to the string.
    public static func clusterStart(in text: NSString, offset: Int) -> Int {
        if offset <= 0 { return 0 }
        if offset >= text.length { return text.length }
        return cluster(in: text, containing: offset).location
    }

    /// The end of the cluster containing `offset`, or `offset` on a boundary.
    public static func clusterEnd(in text: NSString, offset: Int) -> Int {
        if offset <= 0 { return 0 }
        if offset >= text.length { return text.length }
        let range = cluster(in: text, containing: offset)
        return range.location == offset ? offset : NSMaxRange(range)
    }

    /// True when `offset` already sits on a boundary.
    public static func isBoundary(in text: NSString, offset: Int) -> Bool {
        clusterStart(in: text, offset: offset) == offset
    }

    /// A caret position: pulled back to the start of its cluster.
    public static func caret(in text: NSString, offset: Int) -> Int {
        clusterStart(in: text, offset: min(max(offset, 0), text.length))
    }

    /// A selection: widened outwards so it never bisects a cluster.
    public static func range(in text: NSString, _ range: NSRange) -> NSRange {
        let lower = clusterStart(in: text, offset: min(max(range.location, 0), text.length))
        let upper = clusterEnd(in: text, offset: min(max(NSMaxRange(range), 0), text.length))
        return NSRange(location: lower, length: max(0, upper - lower))
    }

    /// Every cluster boundary in `text`, ascending, including 0 and its length.
    /// O(n) — for the conformance suite, not for the editing path.
    public static func boundaries(in text: NSString) -> [Int] {
        var result = [0]
        var at = 0
        for character in text as String {
            at += character.utf16.count
            result.append(at)
        }
        return result
    }

    /// The cluster containing `offset`, found by walking `Character`s from a
    /// position that is provably a boundary.
    private static func cluster(in text: NSString, containing offset: Int) -> NSRange {
        let start = provableBoundary(in: text, atOrBefore: offset)
        let windowLength = min(text.length - start, contextWindow + (offset - start) + 1)
        let window = text.substring(with: NSRange(location: start, length: windowLength))

        var at = start
        for character in window {
            let width = character.utf16.count
            if offset < at + width {
                return NSRange(location: at, length: width)
            }
            at += width
        }
        // The window ended inside the cluster containing `offset`, which only
        // happens for a cluster longer than the window. Fall back to the whole
        // tail rather than guessing.
        return clusterByFullWalk(in: text, containing: offset, from: start)
    }

    private static func clusterByFullWalk(
        in text: NSString, containing offset: Int, from start: Int
    ) -> NSRange {
        var at = start
        for character in text.substring(from: start) {
            let width = character.utf16.count
            if offset < at + width {
                return NSRange(location: at, length: width)
            }
            at += width
        }
        return NSRange(location: offset, length: 0)
    }

    /// The largest offset at or before `offset` that is certainly a cluster
    /// boundary, or 0 if none is found within `contextWindow`.
    private static func provableBoundary(in text: NSString, atOrBefore offset: Int) -> Int {
        var candidate = offset
        let floor = max(0, offset - contextWindow)
        while candidate > floor {
            if isASCIIPrintable(text.character(at: candidate - 1)),
                isASCIIPrintable(text.character(at: candidate))
            {
                return candidate
            }
            candidate -= 1
        }
        return floor == 0 ? 0 : floor
    }

    /// Space through tilde: all Grapheme_Cluster_Break=Other, so two of them in
    /// a row always break. Excludes CR and LF deliberately — those are the one
    /// ASCII pair that does *not* break.
    private static func isASCIIPrintable(_ unit: unichar) -> Bool {
        unit >= 0x20 && unit <= 0x7E
    }
}
