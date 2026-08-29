import SwiftUI

@main
struct RectoApp: App {
    var body: some Scene {
        Window("Recto editor smoke", id: "editor-smoke") {
            EditorHostView()
        }
        .defaultSize(width: 1_000, height: 720)
        .windowResizability(.contentMinSize)
    }
}
