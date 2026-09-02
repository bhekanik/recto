import RectoEditor

/// The lens an editable document opens in.
///
/// Each window holds its own choice, as the web holds one per pane: one window
/// can show the source while another stays rich. The last choice made anywhere
/// is kept in `UserDefaults` and is what the next window opens in.
enum PresentationPreference {
    static let key = "editor.presentation"

    /// What the writer can pick, in the web's `MODE_RING` order. Preview is not
    /// a choice: it is what a read-only document gets, whatever is stored.
    static let choices: [Presentation] = [.rich, .raw, .vim]

    /// The stored raw value as a choice. Absent, unknown or unpickable → rich.
    static func choice(from stored: String?) -> Presentation {
        guard let stored, let presentation = Presentation(rawValue: stored),
              choices.contains(presentation) else { return .rich }
        return presentation
    }

    /// The lens to show a document through: the window's own choice once it has
    /// one, the stored default until then.
    static func presentation(
        chosen: Presentation? = nil,
        stored: String?,
        isEditable: Bool
    ) -> Presentation {
        isEditable ? chosen ?? choice(from: stored) : .preview
    }
}
