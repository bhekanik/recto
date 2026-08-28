#if canImport(AppKit)
import AppKit

/// Translates an `NSEvent` into the key name the vim core expects.
///
/// The core already knows how to spell chords (`<C-w>`, `<S-Tab>`) — it does
/// that in `vimKeyFromEvent`, which is inside the extracted bundle. So Swift's
/// job stops at producing a DOM-style `key` name plus a modifier mask, and vim
/// key naming stays in one place instead of being reimplemented here and
/// drifting from the web.
public enum VimKeyEvent {
    /// Special keys as `KeyboardEvent.key` names. AppKit reports these as
    /// private-use unicode scalars, which the core would otherwise try to
    /// insert as text.
    private static let functionKeyNames: [Int: String] = [
        NSUpArrowFunctionKey: "ArrowUp",
        NSDownArrowFunctionKey: "ArrowDown",
        NSLeftArrowFunctionKey: "ArrowLeft",
        NSRightArrowFunctionKey: "ArrowRight",
        NSDeleteFunctionKey: "Delete",
        NSHomeFunctionKey: "Home",
        NSEndFunctionKey: "End",
        NSPageUpFunctionKey: "PageUp",
        NSPageDownFunctionKey: "PageDown",
        NSInsertFunctionKey: "Insert",
    ]

    public static func translate(_ event: NSEvent) -> (key: String, mods: VimModifiers)? {
        var mods: VimModifiers = []
        let flags = event.modifierFlags
        if flags.contains(.control) { mods.insert(.control) }
        if flags.contains(.option) { mods.insert(.option) }
        if flags.contains(.command) { mods.insert(.command) }
        if flags.contains(.shift) { mods.insert(.shift) }

        // `charactersIgnoringModifiers` is what gives `<C-w>` the letter "w"
        // rather than the control character AppKit would otherwise deliver.
        guard let raw = event.charactersIgnoringModifiers, let scalar = raw.unicodeScalars.first
        else { return nil }

        if let name = functionKeyNames[Int(scalar.value)] {
            return (name, mods)
        }

        switch scalar.value {
        case 0x1B: return ("Escape", mods)
        case 0x0D, 0x03: return ("Enter", mods)  // Return and keypad Enter
        case 0x7F, 0x08: return ("Backspace", mods)
        case 0x09, 0x19: return ("Tab", mods)  // Tab and back-tab
        case 0x20: return (" ", mods)
        default: break
        }

        // Shift is already baked into the character AppKit gives us ("A", not
        // "a"), and the core only consults `shiftKey` for named keys and
        // chords, so leaving it set on a plain letter is correct.
        return (String(scalar), mods)
    }
}
#endif
