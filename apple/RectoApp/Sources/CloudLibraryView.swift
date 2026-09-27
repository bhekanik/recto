import AppKit
import RectoEditor
import RectoStore
import SwiftUI

struct CloudLibraryView: View {
    let model: RectoApplicationModel
    @State private var layout = PaneLayout()
    @State private var documents = PaneDocuments()
    /// A citation to land on once its document opens.
    @State private var pendingJump: (localId: String, offset: Int)?
    @State private var columnVisibility = NavigationSplitViewVisibility.automatic
    /// What the sidebar was before zen hid it, to put it back after.
    @State private var visibilityBeforeZen: NavigationSplitViewVisibility?
    @FocusState private var documentsFocused: Bool
    /// The active pane's editor should take the keyboard once it is on
    /// screen. True at first, so opening the app lands in the text; a
    /// selection made by arrowing through the list leaves it false, so the
    /// list keeps the keyboard while the writer browses.
    @State private var editorWantsKeyboard = true
    @State private var searchQuery = ""
    @FocusState private var searchFocused: Bool

    private var theme: RectoEditorTheme { StudioSettings.shared.theme }

    var body: some View {
        @Bindable var model = model
        NavigationSplitView(columnVisibility: $columnVisibility) {
            let groups = LibraryGroups.groups(model.documents, matching: searchQuery)
            List(selection: $model.selectedDocumentId) {
                ForEach(groups, id: \.title) { group in
                    Section {
                        ForEach(group.documents, id: \.localId) { document in
                            documentRow(document)
                        }
                    } header: {
                        Text(group.title)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .overlay {
                if groups.isEmpty, !searchQuery.isEmpty {
                    ContentUnavailableView.search(text: searchQuery)
                }
            }
            .searchable(text: $searchQuery, placement: .sidebar, prompt: "Search")
            .searchFocused($searchFocused)
            // Return in the search field opens the first match for writing.
            .onSubmit(of: .search) {
                guard let first = groups.first?.documents.first else { return }
                model.selectedDocumentId = first.localId
                model.request(.focusEditor)
            }
            .scrollContentBackground(.hidden)
            .background(Color(nsColor: theme.canvas))
            .focused($documentsFocused)
            // Return opens the highlighted document for writing.
            .onKeyPress(.return) {
                model.request(.focusEditor)
                return .handled
            }
            .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 380)
            .navigationTitle("Documents")
            .toolbar {
                ToolbarItemGroup {
                    Button("New document", systemImage: "square.and.pencil") {
                        Task { await model.createDocument() }
                    }
                    .help(CommandRegistry.help("New document", command: "new-document"))
                    Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right") {
                        Task { await model.signOut() }
                    }
                    .help("Sign out")
                }
            }
        } detail: {
            PaneTreeView(node: layout.root) { pane in
                paneView(pane)
            }
            // No title-bar fill: the document's backdrop runs up under it, so
            // the window is one surface rather than a grey band over the page.
            .toolbarBackgroundVisibility(.hidden, for: .windowToolbar)
        }
        .onAppear {
            if layout.activePane?.documentId == nil { layout.setActiveDocument(model.selectedDocumentId) }
        }
        .onChange(of: model.selectedDocumentId) { _, selected in
            // The sidebar and the palette open documents in the active pane.
            if layout.activePane?.documentId != selected { layout.setActiveDocument(selected) }
        }
        .onChange(of: layout.activePane?.documentId) { _, active in
            if model.selectedDocumentId != active { model.selectedDocumentId = active }
        }
        .onChange(of: model.keyboardRequest) { _, request in
            guard let request else { return }
            handle(request.kind)
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

extension CloudLibraryView {
    private func documentRow(_ document: DocumentRecord) -> some View {
        let isSelected = document.localId == model.selectedDocumentId
        return DocumentRow(document: document)
            .tag(document.localId)
            .background(SystemSelectionHidden())
            // The design's accent wash instead of the system's solid
            // highlight, deeper while the list has the keyboard so the
            // writer can see where typing would go.
            .listRowBackground(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color(nsColor: theme.accent.withAlphaComponent(
                        isSelected ? (documentsFocused ? 0.26 : 0.15) : 0)))
                    .padding(.horizontal, 8)
            )
    }

    private func handle(_ request: RectoApplicationModel.KeyboardRequest.Kind) {
        switch request {
        case .focusDocuments:
            if columnVisibility == .detailOnly { columnVisibility = .all }
            documentsFocused = true
        case .focusEditor:
            editorWantsKeyboard = true
        case .toggleSidebar:
            columnVisibility = columnVisibility == .detailOnly ? .all : .detailOnly
        case .focusSearch:
            if columnVisibility == .detailOnly { columnVisibility = .all }
            searchFocused = true
        }
    }

    private func openCitation(_ convexId: String, _ offset: Int) {
        guard let localId = model.documents.first(where: { $0.convexId == convexId })?.localId else {
            model.errorMessage = "That draft isn't on this Mac yet."
            return
        }
        pendingJump = (localId, offset)
        layout.setActiveDocument(localId)
    }

    private var commands: PaneCommands {
        PaneCommands(
            split: { axis in layout.split(axis) },
            close: { layout.closeActive() },
            focus: { step in layout.focus(by: step) }
        )
    }

    @ViewBuilder
    private func paneView(_ pane: PaneLayout.Pane) -> some View {
        let isActive = pane.id == layout.activePaneId
        let multiple = layout.panes.count > 1
        Group {
            if let localId = pane.documentId, let registry = model.registry {
                CloudDocumentView(
                    localId: localId, registry: registry, api: model.api,
                    panes: PaneContext(
                        documents: documents, paneId: pane.id, isActive: isActive,
                        activate: { layout.activate(pane.id) }, commands: commands,
                        openDocument: openCitation,
                        pendingJump: isActive && pendingJump?.localId == localId ? pendingJump?.offset : nil,
                        clearJump: { pendingJump = nil },
                        pendingCaret: isActive && model.pendingCaret?.localId == localId
                            ? model.pendingCaret?.caret : nil,
                        clearCaret: { model.pendingCaret = nil },
                        wantsKeyboard: isActive && editorWantsKeyboard,
                        tookKeyboard: { editorWantsKeyboard = false }))
                    .id("\(pane.id)-\(localId)")
            } else {
                ContentUnavailableView(
                    "No document selected",
                    systemImage: "doc.text",
                    description: Text(multiple
                        ? "Pick a document in the sidebar to show it in this pane."
                        : "Press ⌘N to start a document. ⌘K finds every command.")
                )
                .contentShape(Rectangle())
                .onTapGesture { layout.activate(pane.id) }
            }
        }
        // With more than one pane, the one the palette and menus act on is marked.
        .overlay {
            if multiple, isActive {
                Rectangle().strokeBorder(Color.accentColor.opacity(0.6), lineWidth: 2).allowsHitTesting(false)
            }
        }
    }
}

/// Title, then when and how long, in the sidebar's own type sizes. The sync
/// glyph appears only when something needs the writer: a synced or syncing
/// document is the normal case and would put an icon on every row.
private struct DocumentRow: View {
    let document: DocumentRecord

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(document.title.isEmpty ? "Untitled" : document.title)
                    .font(.system(size: 13, weight: .medium))
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let problem {
                    Image(systemName: problem.symbol)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(problem.color)
                        .accessibilityLabel(statusHelp)
                }
            }
            Text(meta)
                .font(.system(size: 11))
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.vertical, 4)
        .help(statusHelp)
    }

    private var meta: String {
        let edited = Date(timeIntervalSince1970: document.updatedAt / 1000)
            .formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
        let words = document.wordCount == 1 ? "1 word" : "\(document.wordCount.formatted()) words"
        return "\(edited) · \(words)"
    }

    private var problem: (symbol: String, color: Color)? {
        switch document.syncState {
        case .synced, .pending, .syncing: nil
        case .diverged: ("arrow.triangle.branch", .orange)
        case .failed: ("exclamationmark.icloud", .red)
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

/// Turns off the sidebar table's own selection highlight so the row's
/// ``listRowBackground`` is the selection. macOS draws that highlight in the
/// system accent with white text on top, which no palette's accent carries at
/// a readable contrast; SwiftUI has no modifier for it, so this reaches the
/// table from inside a row.
private struct SystemSelectionHidden: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { Probe() }
    func updateNSView(_ view: NSView, context: Context) {}

    private final class Probe: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            var ancestor = superview
            while let view = ancestor, !(view is NSTableView) { ancestor = view.superview }
            if let table = ancestor as? NSTableView, table.selectionHighlightStyle != .none {
                table.selectionHighlightStyle = .none
            }
        }
    }
}
