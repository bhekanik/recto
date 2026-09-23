import Foundation
import Observation
import RectoEditor
import RectoSync
import SwiftUI

/// One document's comments: the live list from `review.listComments`, where
/// each one sits in the current text, and the composer. The web's comments
/// panel and highlight plumbing, without the view.
@MainActor
@Observable
final class CommentsModel {
    struct Thread: Identifiable, Equatable {
        let root: RemoteComment
        let replies: [RemoteComment]
        var id: String { root.id }
    }

    /// A comment being written on a selection.
    struct Draft: Equatable {
        let anchor: CommentAnchor
        var body = ""
    }

    private(set) var comments: [RemoteComment] = []
    /// Where each comment's anchor is in the current text; absent when lost.
    private(set) var located: [String: NSRange] = [:]
    var draft: Draft?
    var focusedId: String?
    var errorMessage: String?

    @ObservationIgnored private var cloud: CloudDocumentContext?
    @ObservationIgnored private var subscription: Task<Void, Never>?

    /// Top-level comments with their replies, oldest first, as the web lists them.
    var threads: [Thread] {
        let sorted = comments.sorted { $0.createdAt < $1.createdAt }
        let replies = Dictionary(grouping: sorted.filter { $0.threadParentId != nil }, by: { $0.threadParentId! })
        return sorted.filter { $0.threadParentId == nil }.map { Thread(root: $0, replies: replies[$0.id] ?? []) }
    }

    func follow(_ cloud: CloudDocumentContext?) {
        self.cloud = cloud
        subscription?.cancel()
        guard let cloud, let convexId = cloud.convexId else {
            comments = []
            return
        }
        subscription = Task { [weak self] in
            let stream: AsyncThrowingStream<[RemoteComment], any Error> =
                await cloud.api.subscribe(ConvexFunction.reviewListComments, args: ["documentId": .string(convexId)])
            do {
                for try await list in stream { self?.comments = list }
            } catch {
                self?.errorMessage = error.localizedDescription
            }
        }
    }

    func stop() {
        subscription?.cancel()
        subscription = nil
    }

    /// Re-find every anchor in `markdown`.
    func relocate(in markdown: String) {
        var result: [String: NSRange] = [:]
        for comment in comments {
            if let range = comment.anchor.locate(in: markdown) { result[comment.id] = range }
        }
        if result != located { located = result }
    }

    /// The highlights to draw: open comments whose anchor was found.
    var marks: [RectoDecorationController.CommentMark] {
        comments.filter { !$0.resolved }.compactMap { comment in
            located[comment.id].map { .init(range: $0, id: comment.id, isFocused: comment.id == focusedId) }
        }
    }

    /// `add-comment`: anchor the selection (or the word at the caret) and open
    /// the composer.
    func startDraft(markdown: String, selection: NSRange) {
        let anchor = CommentAnchor.create(in: markdown, from: selection.location, to: NSMaxRange(selection))
        guard !anchor.quote.isEmpty else {
            errorMessage = "Select some text to comment on."
            return
        }
        draft = Draft(anchor: anchor)
    }

    func post() async {
        guard let draft, !draft.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        if await add(anchor: draft.anchor, body: draft.body, parent: nil) { self.draft = nil }
    }

    @discardableResult
    func reply(to root: RemoteComment, body: String) async -> Bool {
        guard !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return await add(anchor: root.anchor, body: body, parent: root.id)
    }

    func setResolved(_ comment: RemoteComment, _ resolved: Bool) async {
        await call(ConvexFunction.reviewSetCommentResolved, ["commentId": .string(comment.id), "resolved": .bool(resolved)])
    }

    func remove(_ comment: RemoteComment) async {
        await call(ConvexFunction.reviewRemoveComment, ["commentId": .string(comment.id)])
    }

    private func add(anchor: CommentAnchor, body: String, parent: String?) async -> Bool {
        guard let convexId = cloud?.convexId else {
            errorMessage = "This document hasn't synced yet, so it can't take comments."
            return false
        }
        let anchorValue: ConvexValue = [
            "quote": .string(anchor.quote), "prefix": .string(anchor.prefix),
            "suffix": .string(anchor.suffix), "offsetHint": .number(anchor.offsetHint),
        ]
        return await call(ConvexFunction.reviewAddComment, ConvexValue.arguments([
            "documentId": .string(convexId), "anchor": anchorValue, "body": .string(body),
            "threadParentId": parent.map(ConvexValue.string),
        ]))
    }

    @discardableResult
    private func call(_ name: String, _ args: [String: ConvexValue]) async -> Bool {
        guard let cloud else { return false }
        do {
            let _: ConvexVoid = try await cloud.api.mutation(name, args: args)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }
}

/// Re-finds the comments in the text as it changes and hands the highlights
/// to the editor. A zero-size view so only it observes the text.
struct CommentHighlightTracker: View {
    let storage: RectoTextStorage
    let comments: CommentsModel
    let decorations: RectoDecorationController

    var body: some View {
        let markdown = storage.markdown
        Color.clear
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
            .task(id: HighlightInput(markdown: markdown, comments: comments.comments, focused: comments.focusedId)) {
                // A short pause: relocating is cheap, but not per keystroke.
                try? await Task.sleep(for: .milliseconds(150))
                guard !Task.isCancelled else { return }
                comments.relocate(in: markdown)
                decorations.commentMarks = comments.marks
            }
    }
}

private struct HighlightInput: Equatable {
    let markdown: String
    let comments: [RemoteComment]
    let focused: String?

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.comments == rhs.comments && lhs.focused == rhs.focused
            && (lhs.markdown as NSString).isEqual(to: rhs.markdown)
    }
}
