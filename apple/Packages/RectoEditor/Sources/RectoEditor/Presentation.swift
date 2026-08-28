//
//  Presentation.swift
//  RectoEditor
//

import Foundation

/// How one document is shown. The text storage is the same in every case —
/// only what the reader sees changes.
///
/// `.vim` is deliberately absent: the modal layer is a key-handling shell over
/// `.raw` and lands after the N0c JavaScriptCore spike reports.
public enum Presentation: String, Sendable, CaseIterable, Codable {
    /// Markdown rendered in place: markers hidden except on the block or
    /// inline run the caret is in, prose type scale, drawn bullets and task
    /// boxes. Editable.
    case rich

    /// The Markdown source, unstyled beyond monospace. Editable, and smart
    /// input (list continuation, auto-pairs) is off — what you type is what
    /// the file gets.
    case raw

    /// `rich` with editing off, the caret hidden, and every marker hidden
    /// regardless of where the selection is. Selection and copy still work.
    case preview

    /// Whether the reader can type into this presentation.
    public var isEditable: Bool {
        switch self {
        case .rich, .raw: return true
        case .preview: return false
        }
    }

    /// Whether the type scale is prose (serif) rather than source (mono).
    public var usesProseScale: Bool {
        switch self {
        case .rich, .preview: return true
        case .raw: return false
        }
    }
}
