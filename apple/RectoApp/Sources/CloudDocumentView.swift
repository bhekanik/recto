import RectoCore
import RectoEditor
import RectoStore
import SwiftUI

struct CloudDocumentView: View {
    let localId: String
    let registry: DocumentSessionRegistry
    @State private var model: CloudDocumentModel?
    @State private var openingError: String?

    var body: some View {
        Group {
            if let model {
                editor(model)
            } else if let openingError {
                ContentUnavailableView(
                    "Could not open document",
                    systemImage: "exclamationmark.triangle",
                    description: Text(openingError)
                )
            } else {
                ProgressView("Opening…")
            }
        }
        .task(id: localId) {
            await open()
        }
        .onDisappear {
            let closing = model
            model = nil
            Task { await closing?.close() }
        }
    }

    private func editor(_ model: CloudDocumentModel) -> some View {
        VStack(spacing: 0) {
            if model.state.syncState == .diverged {
                divergenceBanner(model)
            } else if let error = model.editError {
                statusBanner(error, color: .red)
            } else if model.state.syncState == .failed {
                statusBanner("Sync failed. Your changes remain on this Mac.", color: .orange)
            }
            RectoEditorView(
                storage: model.storage,
                styler: MarkdownStyler(
                    presentation: model.isEditable ? .rich : .preview,
                    theme: .twilight,
                    undo: .external
                ),
                placeholder: "Start writing…",
                onTextChange: model.accept
            )
            .frame(minWidth: 620, minHeight: 500)
        }
        .navigationTitle(model.state.title)
        .toolbar {
            ToolbarItemGroup {
                Button("Undo", systemImage: "arrow.uturn.backward") {
                    Task { await model.undo() }
                }
                .keyboardShortcut("z", modifiers: .command)
                .disabled(!model.state.canUndo)
                Button("Redo", systemImage: "arrow.uturn.forward") {
                    Task { await model.redo() }
                }
                .keyboardShortcut("z", modifiers: [.command, .shift])
                .disabled(!model.state.canRedo)
                SyncStateLabel(state: model.state.syncState, pendingCount: model.pendingEditCount)
            }
        }
    }

    private func divergenceBanner(_ model: CloudDocumentModel) -> some View {
        HStack {
            Text("This document changed on another device. Both versions are safe.")
            Spacer()
            Button("Keep this Mac's version") {
                Task { await model.keepLocalBranch() }
            }
            Button("Use remote version") {
                Task { await model.keepRemoteBranch() }
            }
        }
        .padding(10)
        .background(.orange.opacity(0.18))
    }

    private func statusBanner(_ message: String, color: Color) -> some View {
        Text(message)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(color.opacity(0.16))
            .textSelection(.enabled)
    }

    private func open() async {
        await model?.close()
        model = nil
        openingError = nil
        do {
            model = try await CloudDocumentModel.open(localId: localId, registry: registry)
        } catch {
            openingError = error.localizedDescription
        }
    }
}

private struct SyncStateLabel: View {
    let state: SyncState
    let pendingCount: Int

    var body: some View {
        Label(title, systemImage: symbol)
            .foregroundStyle(color)
            .help(helpText)
    }

    private var title: String {
        if pendingCount > 0 { return "Saving" }
        return switch state {
        case .synced: "Synced"
        case .pending: "Pending"
        case .syncing: "Syncing"
        case .diverged: "Needs review"
        case .failed: "On this Mac"
        }
    }

    private var symbol: String {
        switch state {
        case .synced: "checkmark.icloud"
        case .pending, .syncing: "arrow.trianglehead.2.clockwise.rotate.90.icloud"
        case .diverged: "arrow.triangle.branch"
        case .failed: "exclamationmark.icloud"
        }
    }

    private var color: Color {
        switch state {
        case .synced: .secondary
        case .pending, .syncing: .blue
        case .diverged: .orange
        case .failed: .red
        }
    }

    private var helpText: String {
        switch state {
        case .synced: "This document matches Recto on the web."
        case .pending, .syncing: "Changes are saved locally and waiting to sync."
        case .diverged: "Choose which branch should become current."
        case .failed: "Sync failed. Changes remain in the local database."
        }
    }
}
