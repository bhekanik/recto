import AppKit
import RectoCore
import RectoEditor
import SwiftUI

struct CloudDocumentView: View {
    let localId: String
    let registry: DocumentSessionRegistry
    private let settings: StudioSettings
    @State private var model: CloudDocumentModel?
    @State private var openingError: String?
    @State private var chrome: EditorHostController
    @State private var vim = VimHostState()
    @Environment(\.rectoWebOrigin) private var webOrigin
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
                onAttach: { seam in
                    chrome.attach(seam)
                    vim.sync(seam: seam, presentation: styler.presentation)
                },
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
                    vimController: vim.controller,
                    onSelect: choose
                ) {
                    HStack(spacing: 8) {
                        OpenInWebButton(
                            enabled: WebHandoff.isEnabled(
                                convexId: model.state.convexId, webOrigin: webOrigin),
                            help: WebHandoff.disabledReason(
                                convexId: model.state.convexId, webOrigin: webOrigin),
                            theme: styler.theme
                        ) {
                            openInWeb(convexId: model.state.convexId)
                        }
                        SyncIndicator(
                            state: model.state.syncState,
                            pendingCount: model.pendingEditCount,
                            theme: styler.theme
                        )
                    }
                }
            }
        }
        .onAppear {
            chrome.undo = { [model] in Task { await model.undo() } }
            chrome.redo = { [model] in Task { await model.redo() } }
            chrome.choosePresentation = choose
            vim.controller.history = model
            vim.controller.onSave = { Task { await model.save() } }
        }
        .onChange(of: settings.spellcheck) { chrome.applySettings() }
        .onChange(of: settings.typewriter) { chrome.applySettings() }
        .onChange(of: styler.presentation) { _, presentation in
            vim.sync(seam: model.storage.textView, presentation: presentation)
        }
        .navigationTitle(model.state.title)
        // No window-toolbar undo/redo: TopFormatToolbar owns the buttons (web
        // parity) and the Edit menu owns the chords, dispatched through
        // EditorHostRegistry so ⌘Z still undoes in this window.
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

    private func openInWeb(convexId: String?) {
        guard let origin = webOrigin, let convexId,
              let url = DocumentLink.webURL(origin: origin, convexId: convexId)
        else { return }
        NSWorkspace.shared.open(url)
    }
}

private struct OpenInWebButton: View {
    let enabled: Bool
    let help: String
    let theme: RectoEditorTheme
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "globe")
                .font(.system(size: 12))
                .frame(width: 24, height: 24)
                .foregroundStyle(Color(nsColor: theme.ink3))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focusable(false)
        .disabled(!enabled)
        .help(help)
        .accessibilityLabel("Open in web app")
    }
}
