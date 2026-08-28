import Foundation

/// One text replacement, in UTF-16 code units — the same units as `NSRange`,
/// so these drop straight into `NSTextStorage` with no conversion.
///
/// Offsets are relative to the document *as of that edit*, so a batch must be
/// applied in order. JS produced them by applying them to its own mirror in
/// exactly this sequence.
public struct VimEdit: Decodable, Sendable, Equatable {
    public let from: Int
    public let to: Int
    public let insert: String

    public var range: NSRange { NSRange(location: from, length: to - from) }
}

public struct VimSelection: Decodable, Sendable, Equatable {
    public let anchor: Int
    public let head: Int

    public init(anchor: Int, head: Int) {
        self.anchor = anchor
        self.head = head
    }

    public var range: NSRange {
        NSRange(location: min(anchor, head), length: abs(head - anchor))
    }
}

public struct VimPrompt: Decodable, Sendable, Equatable {
    /// The `:` or `/` vim shows at the head of the line.
    public let prefix: String
    public let value: String
}

public struct VimNotification: Decodable, Sendable, Equatable {
    public let text: String
    public let duration: Double
}

public struct VimScrollRequest: Decodable, Sendable, Equatable {
    public let kind: String
    public let offset: Int?
    public let margin: Double?
    public let x: Double?
    public let y: Double?
}

/// Everything one keystroke produced. This is the whole return channel — if a
/// piece of vim state is not here, Swift cannot see it.
public struct VimResult: Decodable, Sendable {
    public let handled: Bool
    public let edits: [VimEdit]
    public let selections: [VimSelection]
    public let mainIndex: Int
    public let mode: String
    public let subMode: String
    public let modeChanged: Bool
    /// Keys of a half-typed command (`3d` waiting for a motion).
    public let pending: String
    public let insertMode: Bool
    public let visualMode: Bool
    public let prompt: VimPrompt?
    public let notification: VimNotification?
    public let scroll: VimScrollRequest?
    /// Source of the live `/` regex, for match highlighting.
    public let search: String?
    /// The host's own undo came back through JS; the edits were already applied
    /// by the host and must not be replayed.
    public let resynced: Bool
    /// The cursor handoff that produced this result has to start a new undo
    /// block — vim's rule for a cursor key in insert mode, which `<C-g>U`
    /// suppresses. Every other call leaves it false.
    public let undoBreak: Bool

    public var primarySelection: VimSelection {
        guard mainIndex >= 0, mainIndex < selections.count else {
            return VimSelection(anchor: 0, head: 0)
        }
        return selections[mainIndex]
    }
}

/// Who made a text change the vim layer did not make.
///
/// The distinction decides two things that used to be wrong together. A
/// composition must keep insert mode — routing it through the cancelling
/// `setText` path left the engine in normal mode after a commit, so the next
/// typed character ran as an operator. A genuinely external edit must close the
/// vim undo group *before* it registers its own undo action, or one `u` throws
/// away the edit and the whole insert session with it.
public enum VimTextChangeSource: Sendable, Equatable {
    /// The input system is rewriting its own marked text, or committing it.
    case composition
    /// Anything else: a menu command, a drag, a sync landing, a programmatic
    /// edit made through the text view.
    case external
}

/// Why replaying the edit journal onto the text storage had to stop.
///
/// Every one of these means the engine's mirror and the storage would have
/// diverged, so the adapter resyncs the engine from the storage and reports
/// this. Continuing past a failed edit is what makes every later journal range
/// point at the wrong text.
public enum VimReplayFailure: Sendable, Equatable {
    /// A delegate returned false from `shouldChangeText` / `shouldChangeTextIn`.
    case rejectedByDelegate(NSRange)
    /// The range does not fit the document — the two were already out of step,
    /// or a host edit landed between the keystroke and the replay.
    case rangeOutOfBounds(NSRange, documentLength: Int)
    /// The text view has no storage to write to.
    case noTextStorage

    public var description: String {
        switch self {
        case .rejectedByDelegate(let range):
            return "the text view's delegate rejected the edit at \(range)"
        case .rangeOutOfBounds(let range, let length):
            return "the edit range \(range) does not fit a document of \(length) units"
        case .noTextStorage:
            return "the text view has no text storage"
        }
    }
}

/// Caret shape per mode, as the design plan specifies (§4.3).
public enum VimCaretShape: Sendable {
    case block   // normal
    case bar     // insert
    case hollow  // visual — selection carries the emphasis

    public init(mode: String) {
        switch mode {
        case "insert": self = .bar
        case let m where m.hasPrefix("visual"): self = .hollow
        default: self = .block
        }
    }
}
