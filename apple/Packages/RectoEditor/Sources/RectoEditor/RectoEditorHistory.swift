//
//  RectoEditorHistory.swift
//  RectoEditor
//

import Foundation

/// Which way through history.
public enum RectoHistoryDirection: Sendable, Equatable {
    case undo
    case redo
}

/// What a history step left behind.
public struct RectoHistoryOutcome: Sendable, Equatable {
    /// The whole document after the step.
    public let markdown: String
    /// UTF-16 offset in `markdown` where the restored change starts. Vim puts
    /// the caret there; a host that only has the two strings may diff them.
    public let patchStart: Int

    public init(markdown: String, patchStart: Int) {
        self.markdown = markdown
        self.patchStart = patchStart
    }
}

/// The host's undo, as the editor's key layers see it (plan 024 B4).
///
/// Recto owns history: the editor emits edits through `onEdit` and asks for
/// navigation through this. ⌘Z on the responder chain and vim's `u`/`<C-r>`
/// both end at the same conformer, so the two never disagree about what the
/// last step was. `RectoEditor` never registers an AppKit undo action of its
/// own.
///
/// `performHistory` is synchronous because vim needs the answer inside the
/// keystroke: the core resets its mirror to the returned text before the key
/// returns. A host whose history is asynchronous (a session actor) returns
/// `nil` after starting the navigation; the resulting storage change reaches
/// the key layer as an external edit and the caret lands near, not exactly on,
/// the change.
@MainActor
public protocol RectoEditorHistory: AnyObject {
    /// Perform the step, apply it to the storage, and describe it — or `nil`
    /// when there was nothing to do (or it could not be done synchronously).
    func performHistory(_ direction: RectoHistoryDirection) -> RectoHistoryOutcome?

    /// The edits reported through `onEdit` from now until `endCommandGroup` are
    /// one step. Vim opens one for an insert session (`iabc<Esc>u` removes
    /// `abc`, not `c`); a normal-mode command is one `onEdit` already.
    func beginCommandGroup()
    func endCommandGroup()

    /// The host's own Undo/Redo (the Edit menu, the toolbar) doesn't go
    /// through vim, so it closes an open command group itself — and tells the
    /// key layer here, before the navigation's storage change lands. The layer
    /// ends its session bookkeeping (the next edit opens a fresh group) and
    /// takes the change as mode-preserving: menu Undo mid-insert ends the
    /// session's undo step but the writer stays in insert.
    ///
    /// Set by the key layer when its history is wired up.
    var onExternalHistoryNavigation: (@MainActor @Sendable () -> Void)? { get set }

    /// Its pair: fired after the navigation's storage changes have landed. The
    /// popped group's closures post one change each, so the layer keeps taking
    /// them mode-preserving until this arrives.
    var onExternalHistoryNavigationEnded: (@MainActor @Sendable () -> Void)? { get set }
}

extension RectoEditorHistory {
    /// Hosts that never close a command group out from under vim — the cloud
    /// document's async session has no groups at all — need no storage.
    public var onExternalHistoryNavigation: (@MainActor @Sendable () -> Void)? {
        get { nil }
        set {}
    }

    public var onExternalHistoryNavigationEnded: (@MainActor @Sendable () -> Void)? {
        get { nil }
        set {}
    }
}
