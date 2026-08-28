#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

import Foundation

/// Translates a platform key event into the key name the vim core expects.
///
/// The core already knows how to spell chords (`<C-w>`, `<S-Tab>`) — it does
/// that in `vimKeyFromEvent`, inside the extracted bundle. So Swift's job stops
/// at producing a DOM-style `KeyboardEvent.key` name plus a modifier mask, and
/// vim key naming stays in one place instead of being reimplemented per platform
/// and drifting from the web.
public enum VimKeyEvent {
    /// Special keys as `KeyboardEvent.key` names. Both AppKit and UIKit report
    /// these as private-use unicode scalars, which the core would otherwise try
    /// to insert as text.
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

    /// `charactersIgnoringModifiers` plus a modifier mask, whatever produced it.
    ///
    /// Shift is already baked into the character the system hands over ("A", not
    /// "a"), and the core only consults `shiftKey` for named keys and chords, so
    /// leaving it set on a plain letter is correct.
    static func translate(characters: String, modifiers: VimModifiers) -> (String, VimModifiers)? {
        guard let scalar = characters.unicodeScalars.first else { return nil }

        if let name = functionKeyNames[Int(scalar.value)] {
            return (name, modifiers)
        }
        switch scalar.value {
        case 0x1B: return ("Escape", modifiers)
        case 0x0D, 0x03: return ("Enter", modifiers)  // Return and keypad Enter
        case 0x7F, 0x08: return ("Backspace", modifiers)
        case 0x09, 0x19: return ("Tab", modifiers)  // Tab and back-tab
        case 0x20: return (" ", modifiers)
        default: return (String(scalar), modifiers)
        }
    }

    #if canImport(AppKit)
    public static func translate(_ event: NSEvent) -> (key: String, mods: VimModifiers)? {
        var modifiers: VimModifiers = []
        let flags = event.modifierFlags
        if flags.contains(.control) { modifiers.insert(.control) }
        if flags.contains(.option) { modifiers.insert(.option) }
        if flags.contains(.command) { modifiers.insert(.command) }
        if flags.contains(.shift) { modifiers.insert(.shift) }

        // `charactersIgnoringModifiers` is what gives `<C-w>` the letter "w"
        // rather than the control character AppKit would otherwise deliver.
        guard let raw = event.charactersIgnoringModifiers else { return nil }
        return translate(characters: raw, modifiers: modifiers)
    }
    #endif

    #if canImport(UIKit)
    /// A hardware-keyboard press. Vim and desktop chords are gated on a keyboard
    /// being attached, not on device class (plan 023 D-N6) — an iPad with a
    /// Magic Keyboard is a desktop, an iPad on the sofa is not.
    public static func translate(_ press: UIPress) -> (key: String, mods: VimModifiers)? {
        guard let key = press.key else { return nil }
        var modifiers: VimModifiers = []
        if key.modifierFlags.contains(.control) { modifiers.insert(.control) }
        if key.modifierFlags.contains(.alternate) { modifiers.insert(.option) }
        if key.modifierFlags.contains(.command) { modifiers.insert(.command) }
        if key.modifierFlags.contains(.shift) { modifiers.insert(.shift) }
        return translate(characters: key.charactersIgnoringModifiers, modifiers: modifiers)
    }
    #endif
}

#if !canImport(AppKit)
// UIKit does not define the `NS*FunctionKey` constants, but it reports the same
// private-use scalars for these keys, so the table above is shared.
private let NSUpArrowFunctionKey = 0xF700
private let NSDownArrowFunctionKey = 0xF701
private let NSLeftArrowFunctionKey = 0xF702
private let NSRightArrowFunctionKey = 0xF703
private let NSInsertFunctionKey = 0xF727
private let NSDeleteFunctionKey = 0xF728
private let NSHomeFunctionKey = 0xF729
private let NSEndFunctionKey = 0xF72B
private let NSPageUpFunctionKey = 0xF72C
private let NSPageDownFunctionKey = 0xF72D
#endif
