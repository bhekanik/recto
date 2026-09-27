import AppKit
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
        /// Function calls for features beyond sync (versions, sharing, AI).
        var api: (any RectoAPI)? = nil
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

    /// A keyboard move for the library window, from the palette, a menu or a
    /// new document. The serial makes asking twice a change the window sees.
    struct KeyboardRequest: Equatable {
        enum Kind: Equatable {
            case focusDocuments
            case focusEditor
            case toggleSidebar
            case focusSearch
        }

        let kind: Kind
        let serial: Int
    }

    private(set) var keyboardRequest: KeyboardRequest?

    func request(_ kind: KeyboardRequest.Kind) {
        keyboardRequest = KeyboardRequest(kind: kind, serial: (keyboardRequest?.serial ?? 0) + 1)
    }

    private(set) var store: RectoStore?
    private(set) var sync: SyncEngine?
    private(set) var registry: DocumentSessionRegistry?
    private(set) var library: DocumentLibrary?
    private(set) var auth: RectoAuth?
    private(set) var api: (any RectoAPI)?
    /// HTTPS origin of the web app. `nil` disables Open in web.
    var webURL: URL?
    var openURL: (URL) -> Bool = { NSWorkspace.shared.open($0) }
    private var emailChallenge: EmailCodeChallenge?
    private var authTask: Task<Void, Never>?
    private var syncTask: Task<Void, Never>?
    private let injectedComponents: Components?
    /// A document link waiting for its document: the link can arrive before
    /// this Mac has it (a note just made on the web, or a launch whose first
    /// sync is still under way), so it waits a while rather than failing.
    private var pendingOpen: (target: DocumentLink.Target, since: Date)?
    /// How long a link waits for its document to sync before giving up.
    var pendingOpenPatience: TimeInterval = 20
    @ObservationIgnored private var pendingOpenDeadline: Task<Void, Never>?
    /// The caret a document link carried, for the pane that opens it.
    var pendingCaret: PendingCaret?

    struct PendingCaret: Equatable {
        let localId: String
        let caret: DocumentLink.Caret
    }

    init(components: Components? = nil) {
        injectedComponents = components
    }

    func start(configuration: AppConfiguration? = nil) async {
        guard startupState == .idle else { return }
        startupState = .loading
        do {
            if let injectedComponents {
                install(injectedComponents)
                applyWebURL(configuration)
                startupState = .ready
                await injectedComponents.auth.start()
                await applyPendingOpen()
                return
            }
            let configuration = try configuration ?? AppConfiguration()
            applyWebURL(configuration)
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
                store: store, auth: auth, sync: sync, registry: registry, library: library,
                api: transport))
            startupState = .ready
            await auth.start()
            await applyPendingOpen()
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
            await applyPendingOpen()
            return
        }
        do {
            documents = try await library.documents()
            if selectedDocumentId == nil
                || !documents.contains(where: { $0.localId == selectedDocumentId }) {
                selectedDocumentId = documents.first?.localId
                errorMessage = nil
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        await applyPendingOpen()
    }

    /// The selected document's convex id as the published library knows it.
    /// Array-only because the menu items that read this run synchronously on
    /// the main actor; the store stays behind `await` in `applyPendingOpen`.
    var selectedConvexId: String? {
        guard let selectedDocumentId else { return nil }
        return documents.first(where: { $0.localId == selectedDocumentId })?.convexId
    }

    var canOpenSelectedDocumentInWeb: Bool {
        WebHandoff.isEnabled(convexId: selectedConvexId, webOrigin: webURL)
    }

    func openSelectedDocumentInWeb() {
        guard let origin = webURL, let convexId = selectedConvexId,
              let url = DocumentLink.webURL(origin: origin, convexId: convexId)
        else { return }
        _ = openURL(url)
    }

    /// `recto://document/<convexId>`. Returns false for anything else, without throwing.
    @discardableResult
    func openDocument(from url: URL) async -> Bool {
        guard let target = DocumentLink.target(url) else { return false }
        pendingOpen = (target, Date())
        await applyPendingOpen()
        return true
    }

    func createDocument() async {
        guard let library else { return }
        do {
            let document = try await library.createDocument(title: "Untitled")
            await refreshDocuments()
            selectedDocumentId = document.localId
            errorMessage = nil
            // A new document is for writing in.
            request(.focusEditor)
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
        WritingStatsModel.shared.flush()
        await registry?.flushAll()
    }

    /// The server's daily totals while signed in, so days written on other
    /// devices count toward the streak here too.
    private func followWritingStats(_ status: AuthStatus) {
        guard case .signedIn = status, let api else {
            WritingStatsModel.shared.stopFollowingRemote()
            return
        }
        Task { [api] in
            let days: AsyncThrowingStream<[RemoteWritingStat], any Error> =
                await api.subscribe(ConvexFunction.writingStatsList, args: [:])
            WritingStatsModel.shared.followRemote(days)
        }
    }

    func enterForeground() async {
        guard let auth, let sync else { return }
        guard !auth.isTransitioning else {
            await sync.stop()
            return
        }
        switch Self.foregroundSyncAction(for: auth.status) {
        case .stayStopped:
            await sync.stop()
            return
        case .resume:
            break
        case .recoverThenResume:
            guard await auth.recoverConvexLoginIfNeeded() else {
                await sync.stop()
                return
            }
        }
        guard !auth.isTransitioning, case .signedIn = auth.status else {
            await sync.stop()
            return
        }
        await sync.resume()
        guard !auth.isTransitioning, case .signedIn = auth.status else {
            await sync.stop()
            return
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
        followWritingStats(status)
        if case .signedOut = status { emailChallenge = nil }
        await refreshDocuments()
    }

    private func applyWebURL(_ configuration: AppConfiguration?) {
        webURL = configuration?.webURL.flatMap(URL.init(string:))
    }

    private func localId(forConvexId convexId: String) async -> String? {
        if let id = documents.first(where: { $0.convexId == convexId })?.localId {
            return id
        }
        // The published list can lag a just-landed sync by one event loop, so
        // ask the mirror itself before declaring the document unknown.
        if let record = try? await store?.document(convexId: convexId) {
            return record.localId
        }
        return nil
    }

    private func applyPendingOpen() async {
        guard let pending = pendingOpen else { return }
        if let localId = await localId(forConvexId: pending.target.convexId) {
            selectedDocumentId = localId
            pendingCaret = pending.target.caret.map { PendingCaret(localId: localId, caret: $0) }
            pendingOpen = nil
            pendingOpenDeadline?.cancel()
            pendingOpenDeadline = nil
            errorMessage = nil
            // Handed over to keep writing: the text takes the keyboard.
            request(.focusEditor)
            return
        }
        guard store != nil, startupState == .ready else { return }
        let waited = Date().timeIntervalSince(pending.since)
        if waited < pendingOpenPatience {
            // Syncs that land meanwhile retry through refreshDocuments; this
            // is the last look, when the wait is over.
            guard pendingOpenDeadline == nil else { return }
            let remaining = pendingOpenPatience - waited
            pendingOpenDeadline = Task { [weak self] in
                try? await Task.sleep(for: .seconds(remaining))
                self?.pendingOpenDeadline = nil
                await self?.applyPendingOpen()
            }
            return
        }
        pendingOpen = nil
        errorMessage = "This document isn't on this Mac yet. Sign in and wait for it to sync, then open the link again."
    }

    private func install(_ components: Components) {
        let statsStore = components.store
        WritingStatsModel.shared.install(
            read: { try await statsStore.writingStats() },
            record: { date, words in try? await statsStore.recordWritingStat(date: date, words: words) }
        )
        store = components.store
        auth = components.auth
        sync = components.sync
        registry = components.registry
        library = components.library
        api = components.api
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
