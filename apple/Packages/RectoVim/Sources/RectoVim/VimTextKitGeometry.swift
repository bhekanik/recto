#if canImport(AppKit)
import AppKit

/// The layout questions vim asks, answered from TextKit 2 for any `NSTextView`.
///
/// Shared by `VimTextViewAdapter` and the product's controller over the
/// engine-owned text view, so the fragment walk lives once. Nothing here
/// touches `layoutManager`: reading it silently drops the view back to
/// TextKit 1. Geometry goes through `NSTextLayoutManager` and
/// `NSTextLayoutFragment`.
///
/// ## Coordinate space
///
/// `charCoords`, `offsetAtCoords` and `scrollInfo` all speak the scroll view's
/// **document** coordinates: what the clip view's `bounds.origin` is measured
/// in. That is what lets the core compute `zz`/`zt`/`zb` and page moves from
/// `scrollInfo.top` and a character's `top` without knowing how the text view
/// is inset or where it sits inside its document view (the engine centres it in
/// a reading column inside a container). A text view with no scroll view
/// answers in its own coordinates, which is the same thing with a zero offset.
@MainActor
public struct VimTextKitGeometry {
    public unowned let textView: NSTextView

    public init(textView: NSTextView) {
        self.textView = textView
    }

    public func lineHeight() -> Double {
        let font = textView.font ?? NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        return Double(font.ascender - font.descender + font.leading)
    }

    /// Where the *character* is, not where its line starts.
    ///
    /// `H`/`M`/`L` and the goal column of `gj`/`gk` are the callers; returning
    /// the line fragment's origin made every column look like column zero, so a
    /// `gj` from the middle of a wrapped line landed at its start.
    public func charCoords(offset: Int) -> (left: Double, top: Double, bottom: Double) {
        guard let line = displayLine(containing: offset) else { return (0, 0, lineHeight()) }
        let frame = toDocument(line.frame)
        let x = frame.minX + line.x(of: offset)
        return (Double(x), Double(frame.minY), Double(frame.maxY))
    }

    /// The inverse: which offset is under this point, on the display line the
    /// point falls in rather than at the start of the paragraph.
    public func offsetAtCoords(left: Double, top: Double) -> Int {
        let point = toContainer(CGPoint(x: left, y: top))
        guard let line = displayLine(at: point) else { return 0 }
        return line.offset(atX: point.x - line.frame.minX)
    }

    public func scrollInfo() -> (top: Double, height: Double, clientHeight: Double) {
        guard let scrollView = textView.enclosingScrollView else {
            return (0, Double(textView.bounds.height), Double(textView.bounds.height))
        }
        let documentHeight = scrollView.documentView?.bounds.height ?? textView.bounds.height
        return (
            Double(scrollView.contentView.bounds.origin.y),
            Double(documentHeight),
            Double(scrollView.contentView.bounds.height)
        )
    }

    /// `j`/`k` over **display** lines, which is what soft wrapping needs.
    ///
    /// Without this JS falls back to document lines, so a wrapped paragraph is
    /// one `j` tall — visibly wrong with wrapping on, which is our default.
    /// TextKit 2 has no "line fragment at index" call, so this walks the
    /// `NSTextLineFragment`s inside each layout fragment.
    ///
    /// All the index arithmetic stays in one coordinate system: an
    /// `NSTextLineFragment` indexes and positions characters relative to its
    /// *paragraph*, so `goal` is an x within the line fragment and never has to
    /// be converted into container coordinates.
    ///
    /// Returning nil hands the move back to JS's document-line fallback, which
    /// is the right answer for `page` moves — vim sizes those from the viewport
    /// and the core already has that from `scrollInfo`.
    public func verticalMove(
        from offset: Int, amount: Int, unit: String, goalColumn: Double?
    ) -> (offset: Int, hitSide: Bool)? {
        guard unit == "line", amount != 0, let current = displayLine(containing: offset)
        else { return nil }

        let goal = goalColumn.map { CGFloat($0) } ?? current.x(of: offset)
        var line = current
        var hitSide = false
        for _ in 0..<abs(amount) {
            guard let next = displayLine(adjacentTo: line, forward: amount > 0) else {
                hitSide = true
                break
            }
            line = next
        }
        return (line.offset(atX: goal), hitSide)
    }

    // MARK: - Coordinate spaces

    /// Container → document coordinates: through the text container origin
    /// (which carries `textContainerInset`) and the text view's place in the
    /// scroll view's document view.
    private func toDocument(_ rect: CGRect) -> CGRect {
        let origin = textView.textContainerOrigin
        let inView = rect.offsetBy(dx: origin.x, dy: origin.y)
        guard let document = textView.enclosingScrollView?.documentView, document !== textView
        else { return inView }
        return textView.convert(inView, to: document)
    }

    private func toContainer(_ point: CGPoint) -> CGPoint {
        var inView = point
        if let document = textView.enclosingScrollView?.documentView, document !== textView {
            inView = textView.convert(point, from: document)
        }
        let origin = textView.textContainerOrigin
        return CGPoint(x: inView.x - origin.x, y: inView.y - origin.y)
    }

    // MARK: - Display lines

    /// One laid-out display line, plus everything needed to map offsets on it.
    private struct DisplayLine {
        let fragment: NSTextLayoutFragment
        let index: Int
        /// Document offset of the paragraph this line belongs to.
        let paragraphStart: Int

        var line: NSTextLineFragment { fragment.textLineFragments[index] }

        /// Frame in container coordinates.
        var frame: CGRect {
            line.typographicBounds.offsetBy(
                dx: fragment.layoutFragmentFrame.minX, dy: fragment.layoutFragmentFrame.minY)
        }

        func x(of documentOffset: Int) -> CGFloat {
            line.locationForCharacter(at: documentOffset - paragraphStart).x
        }

        func offset(atX x: CGFloat) -> Int {
            let point = CGPoint(x: x, y: line.typographicBounds.height / 2)
            return paragraphStart + line.characterIndex(for: point)
        }
    }

    private func displayLine(containing offset: Int) -> DisplayLine? {
        guard let layoutManager = textView.textLayoutManager,
            let contentManager = layoutManager.textContentManager,
            let location = contentManager.location(
                contentManager.documentRange.location, offsetBy: offset),
            let fragment = layoutManager.textLayoutFragment(for: location)
        else { return nil }
        let paragraphStart = contentManager.offset(
            from: contentManager.documentRange.location, to: fragment.rangeInElement.location)
        for (index, line) in fragment.textLineFragments.enumerated() {
            let lower = paragraphStart + line.characterRange.location
            if offset >= lower && offset <= lower + line.characterRange.length {
                return DisplayLine(
                    fragment: fragment, index: index, paragraphStart: paragraphStart)
            }
        }
        return nil
    }

    private func displayLine(adjacentTo line: DisplayLine, forward: Bool) -> DisplayLine? {
        let next = line.index + (forward ? 1 : -1)
        if next >= 0 && next < line.fragment.textLineFragments.count {
            return DisplayLine(
                fragment: line.fragment, index: next, paragraphStart: line.paragraphStart)
        }
        guard let layoutManager = textView.textLayoutManager,
            let contentManager = layoutManager.textContentManager,
            let sibling = forward
                ? layoutManager.textLayoutFragment(for: line.fragment.rangeInElement.endLocation)
                : previousFragment(before: line.fragment),
            sibling !== line.fragment, !sibling.textLineFragments.isEmpty
        else { return nil }
        return DisplayLine(
            fragment: sibling,
            index: forward ? 0 : sibling.textLineFragments.count - 1,
            paragraphStart: contentManager.offset(
                from: contentManager.documentRange.location, to: sibling.rangeInElement.location))
    }

    private func previousFragment(before fragment: NSTextLayoutFragment) -> NSTextLayoutFragment? {
        guard let layoutManager = textView.textLayoutManager else { return nil }
        var previous: NSTextLayoutFragment?
        layoutManager.enumerateTextLayoutFragments(
            from: fragment.rangeInElement.location, options: [.reverse, .ensuresLayout]
        ) { candidate in
            if candidate !== fragment {
                previous = candidate
                return false
            }
            return true
        }
        return previous
    }

    /// `point` is in container coordinates.
    private func displayLine(at point: CGPoint) -> DisplayLine? {
        guard let layoutManager = textView.textLayoutManager,
            let contentManager = layoutManager.textContentManager,
            let fragment = layoutManager.textLayoutFragment(for: point)
        else { return nil }
        let paragraphStart = contentManager.offset(
            from: contentManager.documentRange.location, to: fragment.rangeInElement.location)
        let origin = fragment.layoutFragmentFrame.origin
        for index in fragment.textLineFragments.indices {
            let bounds = fragment.textLineFragments[index].typographicBounds
                .offsetBy(dx: origin.x, dy: origin.y)
            if point.y < bounds.maxY {
                return DisplayLine(
                    fragment: fragment, index: index, paragraphStart: paragraphStart)
            }
        }
        return DisplayLine(
            fragment: fragment, index: max(0, fragment.textLineFragments.count - 1),
            paragraphStart: paragraphStart)
    }
}
#endif
