import RectoStore
import SwiftUI

struct CloudLibraryView: View {
    let model: RectoApplicationModel
    @State private var columnVisibility = NavigationSplitViewVisibility.automatic
    /// What the sidebar was before zen hid it, to put it back after.
    @State private var visibilityBeforeZen: NavigationSplitViewVisibility?

    var body: some View {
        @Bindable var model = model
        NavigationSplitView(columnVisibility: $columnVisibility) {
            List(model.documents, id: \.localId, selection: $model.selectedDocumentId) { document in
                DocumentRow(document: document)
                    .tag(document.localId)
            }
            .navigationTitle("Documents")
            .toolbar {
                ToolbarItemGroup {
                    Button("New document", systemImage: "square.and.pencil") {
                        Task { await model.createDocument() }
                    }
                    Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right") {
                        Task { await model.signOut() }
                    }
                }
            }
        } detail: {
            if let localId = model.selectedDocumentId, let registry = model.registry {
                CloudDocumentView(localId: localId, registry: registry, api: model.api)
                    .id(localId)
            } else {
                ContentUnavailableView(
                    "No document selected",
                    systemImage: "doc.text",
                    description: Text("Create a document to start writing offline.")
                )
            }
        }
        .onPreferenceChange(ZenPreferenceKey.self) { isZen in
            if isZen {
                visibilityBeforeZen = visibilityBeforeZen ?? columnVisibility
                columnVisibility = .detailOnly
            } else if let previous = visibilityBeforeZen {
                columnVisibility = previous
                visibilityBeforeZen = nil
            }
        }
        .overlay(alignment: .bottom) {
            if let errorMessage = model.errorMessage {
                Text(errorMessage)
                    .padding(10)
                    .background(.regularMaterial, in: .rect(cornerRadius: 8))
                    .padding()
                    .textSelection(.enabled)
            }
        }
    }
}

private struct DocumentRow: View {
    let document: DocumentRecord

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(document.title)
                    .lineLimit(1)
                Text("\(document.wordCount) words")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: statusSymbol)
                .foregroundStyle(statusColor)
                .help(statusHelp)
        }
    }

    private var statusSymbol: String {
        switch document.syncState {
        case .synced: "checkmark.icloud"
        case .pending, .syncing: "arrow.trianglehead.2.clockwise.rotate.90.icloud"
        case .diverged: "arrow.triangle.branch"
        case .failed: "exclamationmark.icloud"
        }
    }

    private var statusColor: Color {
        switch document.syncState {
        case .synced: .secondary
        case .pending, .syncing: .blue
        case .diverged: .orange
        case .failed: .red
        }
    }

    private var statusHelp: String {
        switch document.syncState {
        case .synced: "Synced"
        case .pending: "Saved locally, waiting to sync"
        case .syncing: "Syncing"
        case .diverged: "Needs review"
        case .failed: "Sync failed, changes remain local"
        }
    }
}
