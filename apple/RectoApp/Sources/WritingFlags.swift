import AppKit
import Observation
import RectoCoreJS
import RectoEditor
import SwiftUI

/// Whether a host's notes panel is open. A pinned panel (`notesPinned`) is
/// open whatever this says.
@MainActor
@Observable
final class NotesPanelState {
    var isOpen = false

    func isVisible(_ settings: StudioSettings) -> Bool { isOpen || settings.notesPinned }

    /// `toggle-notes`. Closing a pinned panel unpins it, or it could not close.
    func toggle(_ settings: StudioSettings) {
        setOpen(!isVisible(settings), settings)
    }

    func setOpen(_ open: Bool, _ settings: StudioSettings) {
        if !open, settings.notesPinned { settings.toggleNotesPinned() }
        isOpen = open
    }
}

/// Writing flags (`lib/markdown/flags.ts`): ⌘⇧X drops `<!--flag-->` at the
/// caret and opens a note for it; the notes panel lists, jumps to and
/// resolves them. Every edit goes through the writing controller, so it is
/// undoable and syncs like any other.
extension EditorHostController {
    /// `add-flag`. Nothing in preview, where the text can't change.
    func addFlag() {
        guard let markdown = writingController.markdown, let textView = seam?.nsTextView else { return }
        let selection = textView.selectedRange()
        let at = NSMaxRange(selection)
        let insertion = Flags.insertion(in: markdown, at: at)
        let length = (insertion as NSString).length
        guard writingController.replace(
            NSRange(location: at, length: 0), with: insertion,
            selection: NSRange(location: at + length, length: 0), actionName: "Flag")
        else { return }
        let guardLength = insertion.hasPrefix(Flags.guardCharacter) ? (Flags.guardCharacter as NSString).length : 0
        showNote(for: WritingFlag(from: at, to: at + length, tokenFrom: at + guardLength, note: ""))
    }

    /// Open the note field under `flag`, the one just dropped or clicked.
    func showNote(for flag: WritingFlag) {
        guard let textView = seam?.nsTextView else { return }
        notePopover?.close()
        let popover = FlagNotePopover(note: flag.note) { [weak self] result in
            guard let self else { return }
            self.notePopover = nil
            if case .save(let note) = result, note != flag.note {
                self.setNote(note, of: flag)
            } else {
                self.goTo(flag)
            }
        }
        notePopover = popover
        popover.show(at: glyphRect(of: flag, in: textView), in: textView)
    }

    /// Rewrite `flag`'s note and put the caret back after it.
    func setNote(_ note: String, of flag: WritingFlag) {
        guard let markdown = writingController.markdown, Self.isFlag(flag, in: markdown) else { return }
        let token = Flags.token(note)
        let end = flag.tokenFrom + (token as NSString).length
        writingController.replace(
            NSRange(location: flag.tokenFrom, length: flag.to - flag.tokenFrom), with: token,
            selection: NSRange(location: end, length: 0), actionName: "Flag Note")
    }

    /// Resolve: take `flag` out of the text.
    func resolve(_ flag: WritingFlag) {
        guard let markdown = writingController.markdown, Self.isFlag(flag, in: markdown) else { return }
        let range = Flags.removalRange(of: flag, in: markdown)
        writingController.replace(
            range, with: "", selection: NSRange(location: range.location, length: 0), actionName: "Resolve Flag")
    }

    /// Caret just after `flag`, on screen, with the keyboard.
    func goTo(_ flag: WritingFlag) {
        jump(to: NSRange(location: flag.to, length: 0))
    }

    /// A flag's offsets come from a parse that may be a keystroke old; edit
    /// only when they still hold the same token.
    static func isFlag(_ flag: WritingFlag, in markdown: String) -> Bool {
        let text = markdown as NSString
        guard flag.tokenFrom >= 0, flag.to <= text.length, flag.tokenFrom < flag.to else { return false }
        let token = text.substring(with: NSRange(location: flag.tokenFrom, length: flag.to - flag.tokenFrom))
        return token.hasPrefix(Flags.open) && token.hasSuffix(Flags.close)
    }

    /// The drawn flag, in the text view's coordinates: the glyph rides on the
    /// token's first character, whose kern is the glyph's width.
    func glyphRect(of flag: WritingFlag, in textView: NSTextView) -> NSRect {
        var actual = NSRange()
        let screen = textView.firstRect(forCharacterRange: NSRange(location: flag.tokenFrom, length: 1), actualRange: &actual)
        guard let window = textView.window, screen != .zero else { return textView.visibleRect }
        return textView.convert(window.convertFromScreen(screen), from: nil)
    }

    /// A click on a drawn flag opens its note. The engine puts the caret at
    /// either edge of the collapsed flag; the click point tells a click on
    /// the glyph from one in the text beside it.
    func openNoteIfFlagClicked(in textView: NSTextView) {
        guard notePopover == nil,
            let event = NSApp.currentEvent, event.type == .leftMouseDown || event.type == .leftMouseUp,
            event.window === textView.window,
            textView.selectedRange().length == 0,
            let flag = Self.flag(touching: textView.selectedRange().location, in: textView.string)
        else { return }
        let point = textView.convert(event.locationInWindow, from: nil)
        guard glyphRect(of: flag, in: textView).insetBy(dx: -2, dy: -2).contains(point) else { return }
        showNote(for: flag)
    }

    /// The flag token that starts or ends at `location` on its line, if any.
    static func flag(touching location: Int, in markdown: String) -> WritingFlag? {
        let text = markdown as NSString
        let line = text.lineRange(for: NSRange(location: min(location, text.length), length: 0))
        let lineText = text.substring(with: line) as NSString
        var search = NSRange(location: 0, length: lineText.length)
        while true {
            let open = lineText.range(of: Flags.open, range: search)
            guard open.location != NSNotFound else { return nil }
            let rest = NSRange(location: NSMaxRange(open), length: lineText.length - NSMaxRange(open))
            let close = lineText.range(of: Flags.close, range: rest)
            guard close.location != NSNotFound else { return nil }
            let tokenFrom = line.location + open.location
            let to = line.location + NSMaxRange(close)
            if location == tokenFrom || location == to {
                let token = text.substring(with: NSRange(location: tokenFrom, length: to - tokenFrom))
                let guarded = tokenFrom > 0
                    && text.substring(with: NSRange(location: tokenFrom - 1, length: 1)) == Flags.guardCharacter
                let inner = token.dropFirst(Flags.open.count).dropLast(Flags.close.count)
                let note = inner.hasPrefix(":") ? String(inner.dropFirst()).trimmingCharacters(in: .whitespaces) : ""
                return WritingFlag(from: guarded ? tokenFrom - 1 : tokenFrom, to: to, tokenFrom: tokenFrom, note: note)
            }
            search = NSRange(location: NSMaxRange(close), length: lineText.length - NSMaxRange(close))
        }
    }
}

/// The one-line note under a flag. Return saves, Escape keeps the note as it
/// was, and clicking away saves, so a half-written note is never lost. Either
/// way the caret goes back after the flag.
@MainActor
final class FlagNotePopover: NSObject, NSPopoverDelegate {
    enum Result { case save(String), cancel }

    private let popover = NSPopover()
    private let model: Model
    private let done: (Result) -> Void
    private var finished = false

    @MainActor
    @Observable
    final class Model {
        var note: String
        init(note: String) { self.note = note }
    }

    init(note: String, done: @escaping (Result) -> Void) {
        model = Model(note: note)
        self.done = done
        super.init()
        popover.behavior = .transient
        popover.animates = false
        popover.delegate = self
        popover.contentViewController = NSHostingController(rootView: FlagNoteField(
            model: model,
            save: { [weak self] in self?.finish(.save(self?.model.note ?? "")) },
            cancel: { [weak self] in self?.finish(.cancel) }))
    }

    func show(at rect: NSRect, in view: NSView) {
        popover.show(relativeTo: rect, of: view, preferredEdge: .maxY)
    }

    func close() {
        finish(.cancel)
    }

    /// Clicked away: save what was typed.
    func popoverDidClose(_ notification: Notification) {
        finish(.save(model.note))
    }

    private func finish(_ result: Result) {
        guard !finished else { return }
        finished = true
        if popover.isShown { popover.performClose(nil) }
        done(result)
    }
}

private struct FlagNoteField: View {
    @Bindable var model: FlagNotePopover.Model
    let save: () -> Void
    let cancel: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        TextField("What’s missing here?", text: $model.note)
            .textFieldStyle(.roundedBorder)
            .frame(width: 260)
            .padding(10)
            .focused($focused)
            .onSubmit(save)
            .onExitCommand(perform: cancel)
            .onAppear { focused = true }
            .accessibilityLabel("Flag note")
    }
}

/// The web's `headingsWithFlags`: headings whose section holds a flag.
enum FlaggedHeadings {
    static func indexes(_ outline: [OutlineHeading], _ flags: [WritingFlag]) -> Set<Int> {
        var flagged = Set<Int>()
        for flag in flags {
            if let owner = outline.last(where: { $0.offset <= flag.from }) { flagged.insert(owner.index) }
        }
        return flagged
    }
}
