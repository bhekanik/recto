import Foundation
import Observation
import RectoAuth
import RectoCore
import RectoStore
import RectoSync

@MainActor
@Observable
final class RectoApplicationModel {
    struct Components {
        let store: RectoStore
        let auth: RectoAuth
        let sync: SyncEngine
        let registry: DocumentSessionRegistry
        let library: DocumentLibrary
        var beforeAuthConsumption: (@MainActor @Sendable () async -> Void)? = nil
    }
    enum ForegroundSyncAction: Equatable {
        case stayStopped
        case resume
        case recoverThenResume
    }
    enum StartupState: Equatable {
        case idle
        case loading
        case ready
        case failed(String)
    }

    private(set) var startupState: StartupState = .idle
    private(set) var authStatus: AuthStatus = .loading
    private(set) var documents: [DocumentRecord] = []
    var selectedDocumentId: String?
    var errorMessage: String?

    private(set) var store: RectoStore?
    private(set) var sync: SyncEngine?
    private(set) var registry: DocumentSessionRegistry?
    private(set) var library: DocumentLibrary?
    private(set) var auth: RectoAuth?
    private var emailChallenge: EmailCodeChallenge?
    private var authTask: Task<Void, Never>?
    private var syncTask: Task<Void, Never>?
    private let injectedComponents: Components?

    init(components: Components? = nil) {
        injectedComponents = components
    }

    func start(configuration: AppConfiguration? = nil) async {
        guard startupState == .idle else { return }
        startupState = .loading
        do {
            if let injectedComponents {
                install(injectedComponents)
                startupState = .ready
                await injectedComponents.auth.start()
                return
            }
            let configuration = try configuration ?? AppConfiguration()
            RectoAuth.configureClerk(publishableKey: configuration.clerkPublishableKey)
            let store = try RectoStore(url: RectoStore.defaultURL())
            let auth = RectoAuth(store: store)
            let transport = await ConvexTransport(
                deploymentURL: configuration.convexURL,
                authProvider: auth.convexAuthProvider
            )
            let origin = try await SyncEngine.resolveOrigin(store: store)
            let sync = SyncEngine(store: store, transport: transport, origin: origin)
            let registry = DocumentSessionRegistry(
                store: store,
                sync: sync,
                origin: origin
            )
            let library = DocumentLibrary(store: store, sync: sync, origin: origin)
            auth.attach(sync: sync)
            auth.attach(sessions: registry)

            install(Components(
                store: store, auth: auth, sync: sync, registry: registry, library: library))
            startupState = .ready
            await auth.start()
        } catch {
            startupState = .failed(error.localizedDescription)
        }
    }

    func sendEmailCode(to emailAddress: String) async {
        guard let auth else { return }
        do {
            emailChallenge = try await auth.signInWithEmailCode(emailAddress: emailAddress)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    var isWaitingForEmailCode: Bool { emailChallenge != nil }

    func verifyEmailCode(_ code: String) async {
        guard var challenge = emailChallenge else { return }
        do {
            try await challenge.verify(code: code)
            emailChallenge = nil
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func useAnotherEmail() {
        emailChallenge = nil
        errorMessage = nil
    }

    func refreshDocuments() async {
        guard case .signedIn = authStatus, let library else {
            documents = []
            selectedDocumentId = nil
            return
        }
        do {
            documents = try await library.documents()
            if let selectedDocumentId,
               documents.contains(where: { $0.localId == selectedDocumentId }) {
                return
            }
            selectedDocumentId = documents.first?.localId
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func createDocument() async {
        guard let library else { return }
        do {
            let document = try await library.createDocument(title: "Untitled")
            await refreshDocuments()
            selectedDocumentId = document.localId
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func signOut() async {
        guard let auth else { return }
        do {
            try await auth.signOut()
            emailChallenge = nil
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func cancelBlockedSignIn() async {
        do {
            try await auth?.cancelBlockedSignIn()
            emailChallenge = nil
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func discardRetainedWork() async {
        guard let auth else { return }
        guard await auth.discardRetainedWorkAndClaim() else {
            errorMessage = "Recto could not discard the retained work."
            return
        }
        errorMessage = nil
    }

    func retryConnection() async {
        guard let auth else { return }
        _ = await auth.recoverConvexLoginIfNeeded()
        await refreshDocuments()
    }

    func leaveActive() async {
        await registry?.flushAll()
    }

    func enterForeground() async {
        guard let auth, let sync else { return }
        switch Self.foregroundSyncAction(for: auth.status) {
        case .stayStopped:
            await sync.stop()
            return
        case .resume:
            await sync.resume()
        case .recoverThenResume:
            guard await auth.recoverConvexLoginIfNeeded() else { return }
            await sync.resume()
        }
        await refreshDocuments()
    }

    static func foregroundSyncAction(for status: AuthStatus) -> ForegroundSyncAction {
        switch status {
        case .signedIn: .resume
        case .convexLoginRequired: .recoverThenResume
        case .loading, .signedOut, .blockedByRetainedWork: .stayStopped
        }
    }

    func receiveAuthStatus(_ status: AuthStatus) async {
        authStatus = status
        if case .signedOut = status { emailChallenge = nil }
        await refreshDocuments()
    }

    private func install(_ components: Components) {
        store = components.store
        auth = components.auth
        sync = components.sync
        registry = components.registry
        library = components.library
        authStatus = components.auth.status
        observe(
            auth: components.auth,
            sync: components.sync,
            beforeAuthConsumption: components.beforeAuthConsumption
        )
    }

    private func observe(
        auth: RectoAuth,
        sync: SyncEngine,
        beforeAuthConsumption: (@MainActor @Sendable () async -> Void)?
    ) {
        authTask?.cancel()
        let statuses = auth.statusUpdates
        authTask = Task { [weak self] in
            await beforeAuthConsumption?()
            for await status in statuses {
                guard let self else { return }
                await receiveAuthStatus(status)
            }
        }
        syncTask?.cancel()
        syncTask = Task { [weak self] in
            for await event in await sync.events {
                guard let self else { return }
                switch event {
                case .libraryChanged, .documentChanged, .syncStateChanged,
                     .diverged, .unsyncedWorkOnRemovedDocument, .jobUnsendable:
                    await refreshDocuments()
                }
            }
        }
    }
}
