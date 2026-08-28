//
//  RectoTextStorage.swift
//  RectoEditor
//

import AppKit
import MarkdownEngine
import Observation

/// One open document's text, shared by every editor view showing it.
///
/// The Markdown string is the document — there is no parallel model to keep in
/// step. This type owns that string, hands edits to the attached editor as
/// patches (never by reassigning the text, which would reset the caret), and
/// re-reads the frontmatter when the header could have changed.
///
/// One instance per document, not per view: two Mac windows on the same
/// document share this and therefore share the caret-preserving edit path.
/// Plan 023 allows that once `DocumentSession`'s tests pass.
@Observable
@MainActor
public final class RectoTextStorage {
    /// Stable identity. The engine keys per-document state on it.
    public let documentId: String

    /// The document, in canonical Markdown.
    ///
    /// Assigning reconciles the attached editor by patch, so a whole-document
    /// replacement from sync or a history jump keeps the reader where they
    /// were. Reads are cheap; the string is the storage.
    public var markdown: String {
        didSet {
            guard markdown != oldValue else { return }
            frontmatter = Frontmatter.parse(markdown)
            reconcileEditor()
        }
    }

    /// The leading `---` block as data, or `nil`. Re-read on every change.
    public private(set) var frontmatter: Frontmatter?

    /// Handle on the attached editor. `nil` until a `RectoEditorView` for this
    /// document is on screen.
    @ObservationIgnored
    public let controller = MarkdownEditorController()

    /// The engine's content storage for this document, once the editor is on
    /// screen — one `NSTextContentStorage` per document, which is what makes
    /// showing the same document in two windows cheap.
    ///
    /// Read-only: layout and drawing belong to the engine. Exposed so a second
    /// view can be attached to the same storage and so tests can assert the
    /// string in the storage matches ``markdown`` byte for byte.
    @ObservationIgnored
    public var contentStorage: NSTextContentStorage? {
        controller.textView?.textContentStorage
    }

    /// Fires for every edit the reader makes, in UTF-16 coordinates, so the
    /// undo tree and the sync outbox see the same descriptors.
    @ObservationIgnored
    public var onEdit: ((MarkdownTextMutation) -> Void)?

    /// `true` while the storage is applying an external change, so a listener
    /// can tell the reader's typing from a patch it caused itself.
    @ObservationIgnored
    public private(set) var isApplyingExternalEdit = false

    public init(documentId: String, markdown: String = "") {
        self.documentId = documentId
        self.markdown = markdown
        self.frontmatter = Frontmatter.parse(markdown)
    }

    // MARK: - Editing

    /// Apply an edit from outside the editor — a remote change, an undo-tree
    /// navigation, a canonicalisation pass.
    ///
    /// - Returns: `false` when the range does not fit the current text.
    @discardableResult
    public func apply(_ patch: MarkdownTextPatch) -> Bool {
        let ns = markdown as NSString
        guard patch.range.location != NSNotFound, patch.range.length >= 0,
              NSMaxRange(patch.range) <= ns.length else { return false }
        let updated = ns.replacingCharacters(in: patch.range, with: patch.replacement)
        isApplyingExternalEdit = true
        defer { isApplyingExternalEdit = false }
        if controller.isAttached {
            guard controller.applyPatch(range: patch.range, replacement: patch.replacement) else {
                return false
            }
        }
        // The editor is already there; reconciling would only re-diff it.
        withoutReconciling { markdown = updated }
        return true
    }

    /// The editor writing its text back after an edit. The editor is already
    /// in this state, so `didSet`'s reconciliation is suppressed — patching it
    /// back would be a no-op at best.
    func editorDidWriteBack(_ text: String) {
        guard markdown != text else { return }
        withoutReconciling { markdown = text }
    }

    /// One accepted edit, in UTF-16 display coordinates. Suppressed while the
    /// storage is applying a patch of its own, so a listener never sees its
    /// own change come back.
    func editorDidMutate(_ mutation: MarkdownTextMutation) {
        guard !isApplyingExternalEdit else { return }
        onEdit?(mutation)
    }

    private var isReconciling = false

    private func withoutReconciling(_ body: () -> Void) {
        isReconciling = true
        body()
        isReconciling = false
    }

    /// Bring the attached editor to `markdown` by patching the one changed run.
    ///
    /// Bracketed by `isApplyingExternalEdit` for the same reason `apply(_:)` is:
    /// the patch runs the engine's edit path, which publishes through
    /// `onTextMutation`, and this change did not come from the reader. Without
    /// the guard a sync or history assignment came back out of `onEdit` as
    /// local input — a duplicate undo entry, or a sync echo.
    private func reconcileEditor() {
        guard !isReconciling, controller.isAttached else { return }
        isApplyingExternalEdit = true
        defer { isApplyingExternalEdit = false }
        controller.applyText(markdown)
    }
}
