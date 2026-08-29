import SwiftUI

@main
struct RectoApp: App {
    var body: some Scene {
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
