import CoreGraphics
import MarkdownEngine

/// A visible fenced-code block that Recto can decorate without exposing the
/// editor engine's internal selection model.
public struct RectoCodeBlockAnchor: Identifiable, Equatable, Sendable {
    public let id: Int
    public let rect: CGRect
    public let language: String?
    public let code: String

    public init(id: Int, rect: CGRect, language: String?, code: String) {
        self.id = id
        self.rect = rect
        self.language = language
        self.code = code
    }

    init(_ selection: CodeBlockSelection) {
        self.init(
            id: selection.id,
            rect: selection.rect,
            language: selection.language,
            code: selection.code
        )
    }
}
