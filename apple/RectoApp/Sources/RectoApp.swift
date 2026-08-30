import SwiftUI

@main
struct RectoApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = RectoApplicationModel()

    var body: some Scene {
        WindowGroup("Recto", id: "cloud-library") {
            RectoCloudRootView(model: model)
                .onChange(of: scenePhase) { _, phase in
                    guard phase != .active else { return }
                    Task { await model.flushOpenDocuments() }
                }
        }
        .defaultSize(width: 1_100, height: 760)
        .windowResizability(.contentMinSize)

        DocumentGroup(newDocument: RectoDocument()) { configuration in
            EditorHostView(
                document: configuration.$document,
                isEditable: configuration.isEditable
            )
        }
        .defaultSize(width: 1_000, height: 720)
        .windowResizability(.contentMinSize)
    }
}
