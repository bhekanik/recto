import RectoAuth
import SwiftUI

struct RectoCloudRootView: View {
    let model: RectoApplicationModel

    var body: some View {
        Group {
            switch model.startupState {
            case .idle, .loading:
                ProgressView("Opening Recto…")
                    .task { await model.start() }
            case .failed(let message):
                ContentUnavailableView(
                    "Synced library is not configured",
                    systemImage: "exclamationmark.icloud",
                    description: Text("\(message) You can still use File > New to edit local Markdown files.")
                )
            case .ready:
                authenticatedContent
            }
        }
        .frame(minWidth: 800, minHeight: 560)
    }

    @ViewBuilder
    private var authenticatedContent: some View {
        switch model.authStatus {
        case .loading:
            ProgressView("Checking your session…")
        case .signedOut:
            EmailSignInView(model: model)
        case .signedIn:
            CloudLibraryView(model: model)
        case .blockedByRetainedWork(let owner, let count):
            ContentUnavailableView(
                "Unsynced work is protected",
                systemImage: "externaldrive.badge.exclamationmark",
                description: Text("\(count) change(s) belong to \(owner). Sign back into that account to recover them.")
            )
        case .convexLoginRequired:
            VStack(spacing: 16) {
                ContentUnavailableView(
                    "Cannot reach Recto",
                    systemImage: "icloud.slash",
                    description: Text("Your local documents are locked until Recto can verify the signed-in account.")
                )
                Button("Retry") {
                    Task { await model.retryConnection() }
                }
            }
        }
    }
}
