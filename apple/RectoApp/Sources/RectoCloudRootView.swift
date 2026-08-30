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
            RetainedWorkView(model: model, owner: owner, count: count)
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

private struct RetainedWorkView: View {
    let model: RectoApplicationModel
    let owner: String
    let count: Int
    @State private var confirmingDiscard = false

    var body: some View {
        VStack(spacing: 16) {
            ContentUnavailableView(
                "Unsynced work is protected",
                systemImage: "externaldrive.badge.exclamationmark",
                description: Text("\(count) change(s) belong to \(owner). Sign back into that account to recover them.")
            )
            Button("Use the retained account") {
                Task { await model.cancelBlockedSignIn() }
            }
            Button("Discard retained work", role: .destructive) {
                confirmingDiscard = true
            }
        }
        .confirmationDialog(
            "Permanently discard \(count) unsynced change(s)?",
            isPresented: $confirmingDiscard,
            titleVisibility: .visible
        ) {
            Button("Discard", role: .destructive) {
                Task { await model.discardRetainedWork() }
            }
        }
    }
}
