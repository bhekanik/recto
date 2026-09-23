import RectoEditor
import SwiftUI

/// `components/review/comments-panel.tsx` as a trailing panel: the composer
/// for a new comment on the selection, then each thread with its replies.
struct CommentsPanel: View {
    let comments: CommentsModel
    let theme: RectoEditorTheme
    let jump: (NSRange) -> Void
    let close: () -> Void
    @State private var replies: [String: String] = [:]

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Comments").font(.system(size: 12, weight: .medium)).foregroundStyle(Color(nsColor: theme.ink2))
                Spacer()
                Button(action: close) { Image(systemName: "xmark") }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color(nsColor: theme.ink3))
                    .help("Close comments")
                    .accessibilityLabel("Close comments")
            }
            .padding(.horizontal, 12)
            .frame(height: 40)
            Color(nsColor: theme.line).frame(height: 1)
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        composer
                        ForEach(comments.threads) { thread in
                            threadView(thread).id(thread.id)
                        }
                        if comments.threads.isEmpty, comments.draft == nil {
                            Text("No comments yet. Select text and add a comment.")
                                .font(.system(size: 12))
                                .foregroundStyle(Color(nsColor: theme.ink3))
                        }
                    }
                    .padding(12)
                }
                .onChange(of: comments.focusedId) { _, id in
                    if let id { withAnimation { proxy.scrollTo(id, anchor: .center) } }
                }
            }
        }
        .frame(width: 320)
        .background(Color(nsColor: theme.sheet))
        .overlay(alignment: .leading) { Color(nsColor: theme.line).frame(width: 1) }
        .alert("Comments", isPresented: Binding(
            get: { comments.errorMessage != nil }, set: { if !$0 { comments.errorMessage = nil } }
        )) {} message: {
            Text(comments.errorMessage ?? "")
        }
    }

    @ViewBuilder
    private var composer: some View {
        if let draft = comments.draft {
            VStack(alignment: .leading, spacing: 6) {
                quote(draft.anchor.quote)
                TextEditor(text: Binding(
                    get: { comments.draft?.body ?? "" }, set: { comments.draft?.body = $0 }))
                    .font(.system(size: 12))
                    .frame(minHeight: 60, maxHeight: 120)
                    .scrollContentBackground(.hidden)
                    .background(Color(nsColor: theme.canvas), in: RoundedRectangle(cornerRadius: 4))
                    .overlay(alignment: .topLeading) {
                        if (comments.draft?.body ?? "").isEmpty {
                            Text("Write a comment… (⌘Return to post)")
                                .font(.system(size: 12))
                                .foregroundStyle(Color(nsColor: theme.ink3))
                                .padding(6)
                                .allowsHitTesting(false)
                        }
                    }
                HStack {
                    Spacer()
                    Button("Cancel") { comments.draft = nil }
                    Button("Comment") { Task { await comments.post() } }
                        .keyboardShortcut(.return, modifiers: .command)
                        .disabled((comments.draft?.body ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .controlSize(.small)
            }
            .padding(8)
            .background(Color(nsColor: theme.raised), in: RoundedRectangle(cornerRadius: 6))
        }
    }

    private func threadView(_ thread: CommentsModel.Thread) -> some View {
        let root = thread.root
        let range = comments.located[root.id]
        return VStack(alignment: .leading, spacing: 6) {
            if range != nil {
                Button { if let range { comments.focusedId = root.id; jump(range) } } label: { quote(root.anchor.quote) }
                    .buttonStyle(.plain)
                    .help("Jump to highlighted text")
            } else {
                HStack(spacing: 4) {
                    quote(root.anchor.quote)
                    Text("anchor lost").font(.system(size: 10)).foregroundStyle(Color(nsColor: theme.ink3))
                }
            }
            commentBody(root, isRoot: true)
            ForEach(thread.replies) { reply in
                commentBody(reply, isRoot: false).padding(.leading, 12)
            }
            HStack {
                TextField("Reply…", text: Binding(get: { replies[root.id] ?? "" }, set: { replies[root.id] = $0 }))
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12))
                    .onSubmit { sendReply(root) }
            }
        }
        .padding(8)
        .background(
            Color(nsColor: root.id == comments.focusedId ? theme.accent.withAlphaComponent(0.12) : theme.raised),
            in: RoundedRectangle(cornerRadius: 6))
        .opacity(root.resolved ? 0.6 : 1)
    }

    private func sendReply(_ root: RemoteComment) {
        guard let text = replies[root.id] else { return }
        Task { if await comments.reply(to: root, body: text) { replies[root.id] = "" } }
    }

    private func commentBody(_ comment: RemoteComment, isRoot: Bool) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(comment.authorName).font(.system(size: 11, weight: .medium)).foregroundStyle(Color(nsColor: theme.ink2))
                Text(HistoryPanel.time(comment.createdAt)).font(.system(size: 10)).foregroundStyle(Color(nsColor: theme.ink3))
                Spacer()
                if isRoot {
                    Button { Task { await comments.setResolved(comment, !comment.resolved) } } label: {
                        Image(systemName: comment.resolved ? "arrow.uturn.backward" : "checkmark")
                    }
                    .buttonStyle(.plain)
                    .help(comment.resolved ? "Unresolve" : "Resolve")
                    .accessibilityLabel(comment.resolved ? "Unresolve" : "Resolve")
                }
                Button { Task { await comments.remove(comment) } } label: { Image(systemName: "trash") }
                    .buttonStyle(.plain)
                    .help("Delete")
                    .accessibilityLabel("Delete comment")
            }
            .foregroundStyle(Color(nsColor: theme.ink3))
            Text(comment.body).font(.system(size: 12)).foregroundStyle(Color(nsColor: theme.ink)).textSelection(.enabled)
        }
    }

    private func quote(_ text: String) -> some View {
        Text("“\(text)”")
            .font(.system(size: 11))
            .italic()
            .lineLimit(2)
            .foregroundStyle(Color(nsColor: theme.ink3))
    }
}
