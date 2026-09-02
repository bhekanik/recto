import RectoCore
import RectoEditor
import RectoStore
import SwiftUI

struct CloudDocumentView: View {
    let localId: String
    let registry: DocumentSessionRegistry
    private let settings: StudioSettings
    @State private var model: CloudDocumentModel?
    @State private var openingError: String?
    @State private var chrome: EditorHostController
    @AppStorage(PresentationPreference.key) private var storedPresentation: String?
    /// This window's lens. `nil` until it appears, when it takes the stored
    /// default; after that only the writer's own choice moves it.
    @State private var chosenPresentation: Presentation?

    init(localId: String, registry: DocumentSessionRegistry, settings: StudioSettings = .shared) {
        self.localId = localId
        self.registry = registry
        self.settings = settings
        _chrome = State(initialValue: EditorHostController(settings: settings))
    }

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
        .onAppear {
            if chosenPresentation == nil {
                chosenPresentation = PresentationPreference.choice(from: storedPresentation)
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

    private func styler(_ model: CloudDocumentModel) -> MarkdownStyler {
        settings.styler(presentation: PresentationPreference.presentation(
            chosen: chosenPresentation,
            stored: storedPresentation,
            isEditable: model.isEditable
        ))
    }

    private func choose(_ presentation: Presentation) {
        chosenPresentation = presentation
        storedPresentation = presentation.rawValue
    }

    private func editor(_ model: CloudDocumentModel) -> some View {
        let styler = styler(model)
        return VStack(spacing: 0) {
            if model.state.syncState == .diverged {
                divergenceBanner(model)
            } else if let error = model.editError {
                statusBanner(error, color: .red)
            } else if model.state.syncState == .failed {
                statusBanner("Sync failed. Your changes remain on this Mac.", color: .orange)
            }
            if settings.showToolbar {
                TopFormatToolbar(
                    theme: styler.theme,
                    presentation: styler.presentation,
                    actions: chrome.formatToolbarActions
                )
            }
            RectoEditorView(
                storage: model.storage,
                styler: styler,
                placeholder: "Start writing…",
                onAttach: chrome.attach,
                onEdit: model.accept,
                writingController: chrome.writingController
            )
            .frame(minWidth: 620, minHeight: 500)
            .background(WritingControlsHost(controller: chrome.writingController))
            if settings.showStatusBar {
                EditorStatusBar(
                    presentation: styler.presentation,
                    isEditable: model.isEditable,
                    storage: model.storage,
                    settings: settings,
                    theme: styler.theme,
                    onSelect: choose
                ) {
                    SyncStateLabel(state: model.state.syncState, pendingCount: model.pendingEditCount)
                }
            }
        }
        .onAppear {
            chrome.undo = { [model] in Task { await model.undo() } }
            chrome.redo = { [model] in Task { await model.redo() } }
            chrome.choosePresentation = choose
        }
        .onChange(of: settings.spellcheck) { chrome.applySettings() }
        .onChange(of: settings.typewriter) { chrome.applySettings() }
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
            let opened = try await CloudDocumentModel.open(
                localId: localId,
                registry: registry,
                waitForEditableHolder: true
            )
            if Task.isCancelled {
                await opened.close()
                return
            }
            model = opened
        } catch is CancellationError {
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
