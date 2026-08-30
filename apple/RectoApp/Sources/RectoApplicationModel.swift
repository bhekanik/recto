import Foundation
import Observation
import RectoAuth
import RectoCore
import RectoStore
import RectoSync

@MainActor
@Observable
final class RectoApplicationModel {
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

    func start(configuration: AppConfiguration? = nil) async {
        guard startupState == .idle else { return }
        startupState = .loading
        do {
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

            self.store = store
            self.auth = auth
            self.sync = sync
            self.registry = registry
            self.library = library
            observe(auth: auth, sync: sync)
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
            emailChallenge = challenge
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
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
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func retryConnection() async {
        guard let auth else { return }
        _ = await auth.recoverConvexLoginIfNeeded()
        await refreshDocuments()
    }

    func flushOpenDocuments() async {
        await registry?.flushAll()
    }

    private func observe(auth: RectoAuth, sync: SyncEngine) {
        authTask?.cancel()
        authTask = Task { [weak self] in
            for await status in auth.statusUpdates {
                guard let self else { return }
                authStatus = status
                await refreshDocuments()
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
