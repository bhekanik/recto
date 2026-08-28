import Foundation

/// Snaps UTF-16 offsets to grapheme-cluster boundaries.
///
/// **The JS mirror is the authority, and this is not a second implementation of
/// it.** `packages/recto-vim-js/src/grapheme.js` does the clamping that keeps
/// ZWJ families, flags, skin tones and combining marks intact, using the same
/// UAX #29 code CodeMirror 6 uses. A Swift clamp that disagreed with it by one
/// code unit would desynchronise the two buffers, which is a far worse failure
/// than a caret in an odd place.
///
/// So this runs in exactly one direction: on offsets of **native origin** — a
/// mouse click, a caret the app placed, a range a host `setText` reports — on
/// their way *into* the engine. Offsets coming *out* of the engine are applied
/// verbatim, and `RectoVimTests` asserts this clamp is the identity on every one
/// of them, which is what would catch the two implementations drifting apart.
///
/// `NSString.rangeOfComposedCharacterSequence(at:)` is ICU's grapheme
/// segmentation, the same data `Character` uses. It and UAX #29 agree on
/// everything in the fixture set; the assertion above is what keeps that honest.
public enum GraphemeClamp {
    /// The start of the cluster containing `offset`, clamped to the string.
    public static func clusterStart(in text: NSString, offset: Int) -> Int {
        if offset <= 0 { return 0 }
        if offset >= text.length { return text.length }
        return text.rangeOfComposedCharacterSequence(at: offset).location
    }

    /// The end of the cluster containing `offset`, or `offset` on a boundary.
    public static func clusterEnd(in text: NSString, offset: Int) -> Int {
        if offset <= 0 { return 0 }
        if offset >= text.length { return text.length }
        let range = text.rangeOfComposedCharacterSequence(at: offset)
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
}
