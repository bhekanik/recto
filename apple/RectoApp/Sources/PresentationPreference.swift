import RectoEditor

/// The lens an editable document opens in.
///
/// Each window holds its own choice, as the web holds one per pane: one window
/// can show the source while another stays rich. The last choice made anywhere
/// is kept in `UserDefaults` and is what the next window opens in.
enum PresentationPreference {
    static let key = "editor.presentation"

    /// The lenses a new window may open in, in the web's `MODE_RING` order.
    /// Preview is switchable but never stored: a window opened read-only
    /// because the last one was previewed would look broken.
    static let choices: [Presentation] = [.rich, .raw, .vim]

    /// The web's `MODE_RING`: every lens the switcher and the cycle chords reach.
    static let ring: [Presentation] = choices + [.preview]

    /// `nextMode` / `prevMode` in `lib/modes/types.ts`.
    static func cycled(from current: Presentation, by step: Int) -> Presentation {
        let index = ring.firstIndex(of: current) ?? 0
        return ring[((index + step) % ring.count + ring.count) % ring.count]
    }

    /// Whether choosing `presentation` should become the next window's default.
    static func isStorable(_ presentation: Presentation) -> Bool {
        choices.contains(presentation)
    }

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
