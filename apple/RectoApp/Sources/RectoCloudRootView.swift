import RectoAuth
import SwiftUI

struct RectoCloudRootView: View {
    enum Route: Equatable {
        case opening
        case startupFailure(String)
        case signedOut
        case signedIn
        case blocked(owner: String, count: Int)
        case convexLoginRequired
    }

    let model: RectoApplicationModel

    var body: some View {
        Group {
            switch Self.route(startup: model.startupState, auth: model.authStatus) {
            case .opening:
                ProgressView("Opening Recto…")
                    .task { await model.start() }
            case .startupFailure(let message):
                ContentUnavailableView(
                    "Synced library is not configured",
                    systemImage: "exclamationmark.icloud",
                    description: Text("\(message) You can still use File > New to edit local Markdown files.")
                )
            case .signedOut:
                EmailSignInView(model: model)
            case .signedIn:
                CloudLibraryView(model: model)
            case .blocked(let owner, let count):
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
        .frame(minWidth: 800, minHeight: 560)
    }

    static func route(
        startup: RectoApplicationModel.StartupState, auth: AuthStatus
    ) -> Route {
        switch startup {
        case .idle, .loading: .opening
        case .failed(let message): .startupFailure(message)
        case .ready:
            switch auth {
            case .loading: .opening
            case .signedOut: .signedOut
            case .signedIn: .signedIn
            case .blockedByRetainedWork(let owner, let count): .blocked(owner: owner, count: count)
            case .convexLoginRequired: .convexLoginRequired
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
