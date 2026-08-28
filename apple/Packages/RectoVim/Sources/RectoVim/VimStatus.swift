import Foundation

/// Everything a status bar needs from one keystroke.
///
/// Platform-neutral on purpose: the Mac status bar, the iPad one and the tests
/// all render the same struct, and the adapters only have to hand it over.
public struct VimStatus: Sendable, Equatable {
    /// Raw mode name from the core: `normal`, `insert`, `replace`, `visual`.
    public let mode: String
    /// `-- INSERT --`, `-- VISUAL LINE --`, or empty in normal mode.
    public let label: String
    /// Keys of a half-typed command (`3d` waiting for a motion), shown on the
    /// right of the status line as vim does.
    public let pending: String
    /// The open `:` or `/` line, prefix included, or nil.
    public let prompt: String?
    /// A one-shot message (`:noh`, "recording @q", an ex error).
    public let message: String?
    /// Caret shape the mode calls for.
    public let caret: VimCaretShape

    public init(result: VimResult) {
        mode = result.mode
        pending = result.pending
        prompt = result.prompt.map { $0.prefix + $0.value }
        message = result.notification?.text
        caret = VimCaretShape(mode: result.mode)
        switch result.mode {
        case "insert": label = "-- INSERT --"
        case "replace": label = "-- REPLACE --"
        case let mode where mode.hasPrefix("visual"):
            switch result.subMode {
            case "linewise": label = "-- VISUAL LINE --"
            case "blockwise": label = "-- VISUAL BLOCK --"
            default: label = "-- VISUAL --"
            }
        default: label = ""
        }
    }
}
