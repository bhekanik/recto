//
//  RectoTextStorage.swift
//  RectoEditor
//

import AppKit
import MarkdownEngine
import Observation

/// One editor's text.
///
/// The Markdown string is the document — there is no parallel model to keep in
/// step. This type owns that string, hands edits to the attached editor as
/// patches (never by reassigning the text, which would reset the caret), and
/// re-reads the frontmatter when the header could have changed.
///
/// ### Two windows on one document
///
/// One storage drives one editor view. Marker hiding is a font size and a kern,
/// so presentation-dependent styling is written into the text storage itself
/// and two views over one storage overwrite each other's attributes — TextKit 2
/// rendering attributes cannot collapse a marker's advance, so there is no
/// overlay that would fix it.
///
/// A second window is therefore a second `RectoTextStorage`, and the app keeps
/// the two in step with the halves this type already exposes: ``onEdit``
/// publishes what the reader did, and ``apply(_:)`` takes what someone else
/// did. The Mac app's `DocumentSession` integration will fan that patch stream
/// out to every window's storage. Each window then has its own caret, scroll
/// position, undo stack and presentation — one can be in raw while the other
/// stays rich, which sharing a storage could never allow.
@Observable
@MainActor
public final class RectoTextStorage {
    /// Stable identity. The engine keys per-document state on it.
    public let documentId: String

    /// The newline sequence inserted by native editing and paste operations.
    public let lineEnding: MarkdownLineEnding

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

    /// The engine's content storage, once the editor is on screen.
    ///
    /// Read-only: layout and drawing belong to the engine. Exposed so tests can
    /// assert the string in the storage matches ``markdown`` byte for byte.
    @ObservationIgnored
    public var contentStorage: NSTextContentStorage? {
        controller.textView?.textContentStorage
    }

    /// Fires for every edit the reader makes, in UTF-16 coordinates, so the
    /// undo tree and the sync outbox see the same descriptors.
    @ObservationIgnored
    public var onEdit: ((MarkdownTextMutation) -> Void)?

    @ObservationIgnored
    private var acceptedChangeObserver: NSObjectProtocol?

    /// `true` while the storage is applying an external change, so a listener
    /// can tell the reader's typing from a patch it caused itself.
    @ObservationIgnored
    public private(set) var isApplyingExternalEdit = false

    public init(
        documentId: String,
        markdown: String = "",
        lineEnding: MarkdownLineEnding? = nil
    ) {
        self.documentId = documentId
        self.markdown = markdown
        self.lineEnding = lineEnding ?? MarkdownLineEnding(detecting: markdown)
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
    @discardableResult
    func editorDidWriteBack(_ text: String) -> Bool {
        guard markdown != text else { return false }
        let patch = MarkdownTextPatch.diff(from: markdown, to: text)
        return editorDidMutate(MarkdownTextMutation(
            range: patch.range,
            replacement: patch.replacement
        ))
    }

    /// One accepted edit, in UTF-16 display coordinates. Suppressed while the
    /// storage is applying a patch of its own, so a listener never sees its
    /// own change come back.
    @discardableResult
    func editorDidMutate(_ mutation: MarkdownTextMutation) -> Bool {
        guard !isApplyingExternalEdit else { return false }
        if controller.textView?.string == markdown { return false }
        guard let normalized = lineEnding.applying(mutation, to: markdown)
        else { return false }

        isApplyingExternalEdit = true
        withoutReconciling { markdown = normalized.markdown }
        if controller.textView?.string != normalized.markdown {
            controller.applyText(normalized.markdown)
        }
        isApplyingExternalEdit = false
        onEdit?(normalized.mutation)
        return true
    }

    func observeAcceptedChanges(
        in textView: NSTextView?,
        onTextChange: ((String) -> Void)?
    ) {
        if let acceptedChangeObserver {
            NotificationCenter.default.removeObserver(acceptedChangeObserver)
            self.acceptedChangeObserver = nil
        }
        guard let textView else { return }
        acceptedChangeObserver = NotificationCenter.default.addObserver(
            forName: NSText.didChangeNotification,
            object: textView,
            queue: .main
        ) { [weak self, weak textView] _ in
            MainActor.assumeIsolated {
                guard let self, let textView,
                      self.controller.textView === textView,
                      !textView.hasMarkedText(),
                      textView.string != self.markdown else { return }
                let patch = MarkdownTextPatch.diff(from: self.markdown, to: textView.string)
                let mutation = MarkdownTextMutation(
                    range: patch.range,
                    replacement: patch.replacement
                )
                if self.editorDidMutate(mutation) {
                    onTextChange?(self.markdown)
                }
            }
        }
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
