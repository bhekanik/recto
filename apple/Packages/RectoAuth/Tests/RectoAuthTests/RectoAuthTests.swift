import Foundation
import RectoStore
import Testing

@testable import RectoAuth

/// A JWT with the given claims. Unsigned — nothing here verifies signatures;
/// Convex does that server-side.
private func makeJWT(audience: String?, subject: String = "user_1", ttl: TimeInterval = 60)
  -> String
{
  func segment(_ object: [String: Any]) -> String {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    return data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
  let issuedAt = Date().timeIntervalSince1970
  var claims: [String: Any] = [
    "sub": subject,
    "iss": "https://musical-flounder-88.clerk.accounts.dev",
    "iat": issuedAt,
    "exp": issuedAt + ttl,
  ]
  if let audience { claims["aud"] = audience }
  return "\(segment(["alg": "RS256", "typ": "JWT"])).\(segment(claims)).signature"
}

@Suite("JWT claims")
struct JWTClaimsTests {
  @Test("a convex-template token is recognised")
  func templatedToken() throws {
    let claims = try #require(JWTClaims(token: makeJWT(audience: "convex")))
    #expect(claims.audience == "convex")
    #expect(claims.subject == "user_1")
    #expect(claims.lifetimeSeconds == 60)
    #expect(claims.isExpired() == false)
    #expect(claims.fingerprint.count == 8)
  }

  @Test("the default session token has no convex audience")
  func defaultToken() throws {
    // This is what `clerk-convex-swift`'s stock provider produces, and what
    // Convex rejects as a silent one-second reconnect loop (N0a).
    let claims = try #require(JWTClaims(token: makeJWT(audience: nil)))
    #expect(claims.audience == nil)
    #expect(claims.description.contains("aud=<none>"))
  }

  @Test("expiry is reported with leeway")
  func expiry() throws {
    let claims = try #require(JWTClaims(token: makeJWT(audience: "convex", ttl: 30)))
    #expect(claims.isExpired() == false)
    // Clerk's convex-template tokens live 60s; anything treating one as durable
    // across an app suspend is wrong.
    #expect(claims.isExpired(leeway: 45))
  }

  @Test("fingerprints identify a token without revealing it")
  func fingerprints() throws {
    let token = makeJWT(audience: "convex")
    let other = makeJWT(audience: "convex", subject: "user_2")
    let a = try #require(JWTClaims(token: token))
    let b = try #require(JWTClaims(token: token))
    let c = try #require(JWTClaims(token: other))
    #expect(a.fingerprint == b.fingerprint)
    #expect(a.fingerprint != c.fingerprint)
    #expect(!token.contains(a.fingerprint))
  }

  @Test("garbage is rejected rather than half-parsed")
  func garbage() {
    #expect(JWTClaims(token: "") == nil)
    #expect(JWTClaims(token: "not.a.jwt") == nil)
    #expect(JWTClaims(token: "onlyonesegment") == nil)
  }
}

@Suite("auth features")
struct AuthFeatureTests {
  @Test("Apple and passkeys are off until the Clerk dashboard is configured")
  func defaultsOff() {
    #expect(AuthFeatures.current.appleSignIn == false)
    #expect(AuthFeatures.current.passkeys == false)
  }

  @Test("a disabled method reports why instead of failing at the provider")
  func disabledMethodsThrow() async throws {
    let auth = await RectoAuth(store: try RectoStore.inMemory(), features: AuthFeatures())
    await #expect(throws: RectoAuthError.featureDisabled("Sign in with Apple")) {
      try await auth.signInWithApple()
    }
    await #expect(throws: RectoAuthError.featureDisabled("Passkeys")) {
      try await auth.signInWithPasskey()
    }
  }

  @Test("status starts as loading, not signed out")
  func startsLoading() async throws {
    // Showing the signed-out screen before Clerk has restored the keychain
    // session is the difference between "sign in again" and a cold launch.
    let auth = await RectoAuth(store: try RectoStore.inMemory())
    #expect(await auth.status == .loading)
    #expect(await auth.status.userId == nil)
  }
}

@Suite("cold session restoration")
struct ColdSessionRestorationTests {
  @MainActor
  private final class ActiveSession {
    var id: String?

    init(_ id: String?) { self.id = id }
  }

  private actor RestoreGate {
    private var entered = false
    private var entryWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiter: CheckedContinuation<Void, Never>?

    func suspend() async {
      entered = true
      let waiters = entryWaiters
      entryWaiters.removeAll()
      waiters.forEach { $0.resume() }
      await withCheckedContinuation { releaseWaiter = $0 }
    }

    func waitUntilEntered() async {
      guard !entered else { return }
      await withCheckedContinuation { entryWaiters.append($0) }
    }

    func release() {
      releaseWaiter?.resume()
      releaseWaiter = nil
    }
  }

  private actor Coordinator: SyncControlling, EditSessionCoordinating {
    private(set) var events: [String] = []
    func stop() async { events.append("sync.stop") }
    func start() async { events.append("sync.start") }
    func freezeAndFlushAll() async { events.append("sessions.freeze") }
    func resumeAll() async { events.append("sessions.resume") }
    func invalidateAll() async { events.append("sessions.invalidate") }
  }

  @Test("a restored Clerk session authenticates Convex and starts sync")
  func restoredSessionStartsSync() async throws {
    let store = try RectoStore.inMemory()
    try await store.setMirrorOwner("user-restored")
    let auth = await RectoAuth(store: store)
    let coordinator = Coordinator()
    await auth.attach(sync: coordinator)
    await auth.attach(sessions: coordinator)
    let logins = Counter()
    await MainActor.run {
      auth.convexAuthProvider.activeSessionID = { "session-restored" }
      auth.convexAuthProvider.cachedLogin = { await logins.bump(); return true }
    }

    await auth.restoreSessionForTesting(userId: "user-restored")

    #expect(await logins.value == 1)
    #expect(await auth.status == .signedIn(userId: "user-restored"))
    #expect(await coordinator.events == ["sessions.resume", "sync.start"])
  }

  @Test("a failed restored login locks the mirror and keeps sync stopped")
  func restoredSessionFailureBlocksSync() async throws {
    let store = try RectoStore.inMemory()
    try await store.setMirrorOwner("user-restored")
    let auth = await RectoAuth(store: store)
    let coordinator = Coordinator()
    await auth.attach(sync: coordinator)
    await auth.attach(sessions: coordinator)
    await MainActor.run {
      auth.convexAuthProvider.activeSessionID = { "session-restored" }
      auth.convexAuthProvider.cachedLogin = { false }
    }

    await auth.restoreSessionForTesting(userId: "user-restored")

    #expect(await auth.status == .convexLoginRequired(userId: "user-restored"))
    #expect(await coordinator.events.contains("sync.start") == false)
  }

  @Test("an auth event emitted during session restoration is not lost")
  func eventDuringRestoreIsBuffered() async throws {
    let store = try RectoStore.inMemory()
    try await store.setMirrorOwner("user-restored")
    let auth = await RectoAuth(store: store)
    let coordinator = Coordinator()
    await auth.attach(sync: coordinator)
    await auth.attach(sessions: coordinator)
    let gate = RestoreGate()
    await MainActor.run {
      auth.convexAuthProvider.activeSessionID = { "session-restored" }
      auth.convexAuthProvider.cachedLogin = {
        await gate.suspend()
        return true
      }
    }
    let (events, continuation) = AsyncStream<RectoAuth.LifecycleEvent>.makeStream()

    let start = Task {
      await auth.startForTesting(
        restoredUserId: "user-restored", restoredSessionID: "session-restored", events: events)
    }
    await gate.waitUntilEntered()
    continuation.yield(.sessionChanged(userId: nil, sessionID: nil))
    continuation.finish()
    await gate.release()
    await start.value
    await auth.waitForEventListenerForTesting()

    #expect(await auth.status == .signedOut)
    #expect(await coordinator.events.contains("sync.stop"))
  }

  @MainActor
  @Test("a restored user snapshot without its session cannot publish")
  func restoredSnapshotMustMatchCurrentSession() async throws {
    let store = try RectoStore.inMemory()
    try await store.setMirrorOwner("user-A")
    let auth = RectoAuth(store: store)
    let coordinator = Coordinator()
    auth.attach(sync: coordinator)
    auth.attach(sessions: coordinator)
    auth.convexAuthProvider.activeSessionID = { "session-B" }
    auth.convexAuthProvider.cachedLogin = { true }
    let (events, _) = AsyncStream<RectoAuth.LifecycleEvent>.makeStream()

    await auth.startForTesting(restoredUserId: "user-A", events: events)

    #expect(auth.status != .signedIn(userId: "user-A"))
    #expect(await coordinator.events.contains("sync.start") == false)
  }

  @MainActor
  @Test("a session event superseded during login never publishes the stale user")
  func eventSupersededDuringLogin() async throws {
    let store = try RectoStore.inMemory()
    try await store.setMirrorOwner("user-A")
    let auth = RectoAuth(store: store)
    let coordinator = Coordinator()
    auth.attach(sync: coordinator)
    auth.attach(sessions: coordinator)
    let session = ActiveSession("session-A")
    let loginGate = RestoreGate()
    auth.convexAuthProvider.activeSessionID = { session.id }
    auth.convexAuthProvider.cachedLogin = {
      if session.id == "session-B" { await loginGate.suspend() }
      return true
    }
    let (events, continuation) = AsyncStream<RectoAuth.LifecycleEvent>.makeStream()
    await auth.startForTesting(
      restoredUserId: "user-A", restoredSessionID: "session-A", events: events)

    session.id = "session-B"
    continuation.yield(.sessionChanged(userId: "user-B", sessionID: "session-B"))
    await loginGate.waitUntilEntered()
    session.id = "session-C"
    continuation.yield(.sessionChanged(userId: "user-C", sessionID: "session-C"))
    await loginGate.release()
    continuation.finish()
    await auth.waitForEventListenerForTesting()

    #expect(auth.status == .signedIn(userId: "user-C"))
    #expect(await coordinator.events.filter { $0 == "sync.start" }.count == 2)
  }
}

@Suite("sign-out safety")
struct SignOutTests {
  /// Records the stop/start calls an identity change makes.
  private actor RecordingSync: SyncControlling {
    private(set) var events: [String] = []
    func stop() async { events.append("stop") }
    func start() async { events.append("start") }
  }

  @Test("sign-out refuses while unsent work exists, and says how much")
  func refusesToDiscardSilently() async throws {
    let store = try RectoStore.inMemory()
    try await store.save(
      DocumentRecord(
        localId: "doc-1", title: "native-spike", markdown: "", wordCount: 0,
        localHeadNodeId: "root", updatedAt: 0, createdAt: 0))
    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: "doc-1", kind: .commitEdit, clientMutationId: "m1", payload: "{}",
        createdAt: 0))

    let auth = await RectoAuth(store: store)
    #expect(try await auth.unsyncedWork().count == 1)

    // Offline commits are the user's only copy; deleting them on a train is not
    // a security win, it is data loss.
    await #expect(throws: RectoAuthError.unsyncedWork(count: 1)) {
      try await auth.signOut()
    }
    #expect(try await store.pendingJobCount() == 1)
    #expect(try await store.documents().count == 1)
  }

  @Test("a draft row counts as unsent work")
  func draftCountsAsUnsent() async throws {
    let store = try RectoStore.inMemory()
    try await store.save(
      DocumentRecord(
        localId: "doc-1", title: "native-spike", markdown: "committed",
        draftMarkdown: "typed but not committed", wordCount: 1, localHeadNodeId: "root",
        updatedAt: 0, createdAt: 0))
    let auth = await RectoAuth(store: store)
    #expect(try await auth.unsyncedWork().count == 1)
    await #expect(throws: RectoAuthError.unsyncedWork(count: 1)) { try await auth.signOut() }
  }

  @Test("an explicit discard purges everything, after sync has stopped")
  func explicitDiscardPurges() async throws {
    let store = try RectoStore.inMemory()
    try await store.save(
      DocumentRecord(
        localId: "doc-1", title: "native-spike", markdown: "x", wordCount: 1,
        localHeadNodeId: "root", updatedAt: 0, createdAt: 0))
    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: "doc-1", kind: .commitEdit, clientMutationId: "m1", payload: "{}",
        createdAt: 0))

    let auth = await RectoAuth(store: store)
    let sync = RecordingSync()
    await auth.attach(sync: sync)
    try await auth.signOut(discardingUnsynced: true)

    #expect(try await store.documents().isEmpty)
    #expect(try await store.pendingJobCount() == 0)
    #expect(await auth.status == .signedOut)
    // Stopped BEFORE the purge, or a subscription tick re-inserts rows behind
    // the delete.
    #expect(await sync.events == ["stop"])
  }

  @Test("a clean store signs out without ceremony")
  func cleanSignOut() async throws {
    let store = try RectoStore.inMemory()
    let auth = await RectoAuth(store: store)
    try await auth.signOut()
    #expect(await auth.status == .signedOut)
  }
}

@Suite("round-3 auth")
struct Round3AuthTests {
  /// Records the ordering of everything auth drives, and can write into the
  /// store from inside `freezeAndFlushAll` to reproduce the check-to-purge race.
  private actor Coordinator: SyncControlling, EditSessionCoordinating {
    private(set) var events: [String] = []
    private var onFreeze: (@Sendable () async -> Void)?

    init(onFreeze: (@Sendable () async -> Void)? = nil) { self.onFreeze = onFreeze }

    func stop() async { events.append("sync.stop") }
    func start() async { events.append("sync.start") }
    func freezeAndFlushAll() async {
      events.append("sessions.freeze")
      await onFreeze?()
    }
    func resumeAll() async { events.append("sessions.resume") }
    func invalidateAll() async { events.append("sessions.invalidate") }
  }

  private func store(withDocument markdown: String = "") throws -> RectoStore {
    let store = try RectoStore.inMemory()
    return store
  }

  @Test("editing is frozen and flushed before the unsynced count is taken")
  func freezesBeforeCounting() async throws {
    let store = try RectoStore.inMemory()
    try await store.save(
      DocumentRecord(
        localId: "doc-1", title: "native-spike", markdown: "", wordCount: 0,
        localHeadNodeId: "root", updatedAt: 0, createdAt: 0))

    // A draft persisted DURING the freeze — the race the old order allowed:
    // count, then two awaits, then purge.
    let coordinator = Coordinator {
      _ = try? await store.saveDraft(
        documentLocalId: "doc-1", markdown: "typed while signing out", selection: nil,
        wordCount: 4, job: nil)
    }
    let auth = await RectoAuth(store: store)
    await auth.attach(sync: coordinator)
    await auth.attach(sessions: coordinator)

    await #expect(throws: RectoAuthError.unsyncedWork(count: 1)) { try await auth.signOut() }
    #expect(try await store.document(localId: "doc-1")?.draftMarkdown == "typed while signing out")
    // Refused, so the app is put back the way it was.
    #expect(await coordinator.events == [
      "sessions.freeze", "sync.stop", "sessions.resume", "sync.start",
    ])
  }

  @Test("a cold start refuses to open a mirror that belongs to someone else")
  func coldStartOwnership() async throws {
    let store = try RectoStore.inMemory()
    try await store.setMirrorOwner("user_A")
    try await store.save(
      DocumentRecord(
        localId: "doc-1", title: "A's document", markdown: "A's private text", wordCount: 3,
        localHeadNodeId: "root", updatedAt: 0, createdAt: 0))

    // `claimMirror` is what `start()` calls before publishing a restored session.
    let auth = await RectoAuth(store: store)
    let coordinator = Coordinator()
    await auth.attach(sync: coordinator)
    #expect(try await auth.claimMirrorForTesting(userId: "user_B"))

    #expect(try await store.documents().isEmpty, "B never sees A's rows")
    #expect(try await store.mirrorOwner() == "user_B")
  }

  @Test("the same user coming back keeps their data")
  func coldStartSameOwner() async throws {
    let store = try RectoStore.inMemory()
    try await store.setMirrorOwner("user_A")
    try await store.save(
      DocumentRecord(
        localId: "doc-1", title: "A's document", markdown: "still here", wordCount: 2,
        localHeadNodeId: "root", updatedAt: 0, createdAt: 0))

    let auth = await RectoAuth(store: store)
    #expect(try await auth.claimMirrorForTesting(userId: "user_A"))
    #expect(try await store.documents().count == 1)
  }

  @Test("an ownership marker survives a purge so the next launch still knows")
  func ownerSurvivesPurge() async throws {
    let store = try RectoStore.inMemory()
    try await store.setMirrorOwner("user_A")
    try await store.saveSetting(key: "theme", json: "paper")
    try await store.purgeEverything()
    #expect(try await store.mirrorOwner() == "user_A")
    #expect(try await store.setting("theme") == nil)
  }

  @Test("a revoked session with unsent work retains it instead of deleting it")
  func revokedSessionRetainsWork() async throws {
    let store = try RectoStore.inMemory()
    try await store.setMirrorOwner("user_A")
    try await store.save(
      DocumentRecord(
        localId: "doc-1", title: "native-spike", markdown: "", wordCount: 0,
        localHeadNodeId: "root", updatedAt: 0, createdAt: 0))
    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: "doc-1", kind: .commitEdit, clientMutationId: "m1", payload: "{}",
        createdAt: 0))

    let auth = await RectoAuth(store: store)
    let coordinator = Coordinator()
    await auth.attach(sync: coordinator)
    await auth.attach(sessions: coordinator)

    // Clerk ended the session elsewhere: no chance to ask for consent.
    await auth.handleSessionRevokedForTesting(previousUserId: "user_A")

    #expect(await auth.status == .signedOut)
    #expect(try await store.pendingJobCount() == 1, "the work is retained, not deleted")
    #expect(await auth.retainedUnsyncedWork == 1)
    // Still owned by A, so `claimMirror` keeps anyone else out of it.
    #expect(try await store.mirrorOwner() == "user_A")
  }
}

@Suite("round-4 auth")
struct Round4AuthTests {
  @Test("signing in as another owner is blocked while retained work exists")
  func ownerMismatchWithRetainedWorkIsBlocked() async throws {
    let store = try RectoStore.inMemory()
    try await store.setMirrorOwner("user_A")
    try await store.save(
      DocumentRecord(
        localId: "doc-1", title: "A's work", markdown: "", wordCount: 0,
        localHeadNodeId: "root", updatedAt: 0, createdAt: 0))
    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: "doc-1", kind: .commitEdit, clientMutationId: "m1", payload: "{}",
        createdAt: 0))

    let auth = await RectoAuth(store: store)
    // A's session was revoked and their work retained; B must not be able to
    // take the mirror over by simply signing in.
    #expect(try await auth.claimMirrorForTesting(userId: "user_B") == false)
    #expect(try await store.pendingJobCount() == 1, "A's only copy is still here")
    #expect(try await store.mirrorOwner() == "user_A")
    #expect(await auth.status == .blockedByRetainedWork(owner: "user_A", count: 1))
    #expect(await auth.retainedUnsyncedWork == 1)
  }

  @Test("an explicit discard lets the new owner take the mirror")
  func ownerMismatchWithExplicitDiscard() async throws {
    let store = try RectoStore.inMemory()
    try await store.setMirrorOwner("user_A")
    try await store.save(
      DocumentRecord(
        localId: "doc-1", title: "A's work", markdown: "", wordCount: 0,
        localHeadNodeId: "root", updatedAt: 0, createdAt: 0))
    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: "doc-1", kind: .commitEdit, clientMutationId: "m1", payload: "{}",
        createdAt: 0))

    let auth = await RectoAuth(store: store)
    await MainActor.run {
      auth.convexAuthProvider.activeSessionID = { "session-B" }
      auth.convexAuthProvider.cachedLogin = { true }
    }
    #expect(await auth.discardRetainedWorkAndClaimForTesting(userId: "user_B"))
    #expect(try await store.documents().isEmpty)
    #expect(try await store.mirrorOwner() == "user_B")
  }

  @Test("a clean mirror still transfers without ceremony")
  func ownerMismatchOnCleanMirror() async throws {
    let store = try RectoStore.inMemory()
    try await store.setMirrorOwner("user_A")
    try await store.save(
      DocumentRecord(
        localId: "doc-1", title: "synced", markdown: "x", wordCount: 1,
        localHeadNodeId: "root", syncState: .synced, updatedAt: 0, createdAt: 0))

    let auth = await RectoAuth(store: store)
    #expect(try await auth.claimMirrorForTesting(userId: "user_B"))
    #expect(try await store.documents().isEmpty)
    #expect(try await store.mirrorOwner() == "user_B")
  }
}

@Suite("round-5 auth")
struct Round5AuthTests {
  private actor Coordinator: SyncControlling, EditSessionCoordinating {
    private(set) var events: [String] = []
    func stop() async { events.append("sync.stop") }
    func start() async { events.append("sync.start") }
    func freezeAndFlushAll() async { events.append("sessions.freeze") }
    func resumeAll() async { events.append("sessions.resume") }
    func invalidateAll() async { events.append("sessions.invalidate") }
  }

  private func storeOwnedByA(withWork: Bool) async throws -> RectoStore {
    let store = try RectoStore.inMemory()
    try await store.setMirrorOwner("user_A")
    try await store.save(
      DocumentRecord(
        localId: "doc-1", title: "A's work", markdown: "", wordCount: 0,
        localHeadNodeId: "root", updatedAt: 0, createdAt: 0))
    if withWork {
      _ = try await store.enqueue(
        OutboxJob(
          documentLocalId: "doc-1", kind: .commitEdit, clientMutationId: "m1", payload: "{}",
          createdAt: 0))
    }
    return store
  }

  @Test("a direct A-to-B switch checks ownership before deleting anything")
  func directSwitchDoesNotPurgeBeforeChecking() async throws {
    let store = try await storeOwnedByA(withWork: true)
    let auth = await RectoAuth(store: store)
    let coordinator = Coordinator()
    await auth.attach(sync: coordinator)
    await auth.attach(sessions: coordinator)
    await MainActor.run {
      auth.convexAuthProvider.activeSessionID = { "session-B" }
    }

    // Clerk hands us an active B while A is the published user. Purging here
    // would give `claimMirror` a clean store and remove its chance to object.
    await auth.handleSessionSwitchForTesting(from: "user_A", toUserId: "user_B")

    #expect(try await store.pendingJobCount() == 1, "A's only copy survives the switch")
    #expect(try await store.documents().count == 1)
    #expect(try await store.mirrorOwner() == "user_A")
    #expect(await auth.status == .blockedByRetainedWork(owner: "user_A", count: 1))
  }

  @Test("an explicit discard leaves the app signed in and running")
  func explicitDiscardCompletesTheTransition() async throws {
    let store = try await storeOwnedByA(withWork: true)
    let auth = await RectoAuth(store: store)
    let coordinator = Coordinator()
    await auth.attach(sync: coordinator)
    await auth.attach(sessions: coordinator)
    await MainActor.run {
      auth.convexAuthProvider.activeSessionID = { "session-B" }
      auth.convexAuthProvider.cachedLogin = { true }
    }
    #expect(try await auth.claimMirrorForTesting(userId: "user_B") == false)

    #expect(await auth.discardRetainedWorkAndClaimForTesting(userId: "user_B"))

    // Rows gone, ownership moved — and the app is actually usable again rather
    // than blocked over a store that has already been emptied.
    #expect(try await store.documents().isEmpty)
    #expect(try await store.mirrorOwner() == "user_B")
    #expect(await auth.status == .signedIn(userId: "user_B"))
    #expect(await coordinator.events.contains("sessions.resume"))
    #expect(await coordinator.events.contains("sync.start"))
  }

  @Test("cancelling a blocked switch signs out without deleting retained work")
  func cancelBlockedSwitchPreservesOwner() async throws {
    let store = try await storeOwnedByA(withWork: true)
    let auth = await RectoAuth(store: store)
    let coordinator = Coordinator()
    await auth.attach(sync: coordinator)
    #expect(try await auth.claimMirrorForTesting(userId: "user_B") == false)

    try await auth.cancelBlockedSignIn()

    #expect(await auth.status == .signedOut)
    #expect(try await store.mirrorOwner() == "user_A")
    #expect(try await store.documents().count == 1)
    #expect(try await store.pendingJobCount() == 1)
    #expect(await coordinator.events.contains("sync.stop"))
  }

  @Test("a store that cannot be counted blocks rather than authorises a purge")
  func countFailureFailsClosed() async throws {
    let store = try await storeOwnedByA(withWork: true)
    // Closing the database makes every read throw.
    try await store.closeForTesting()

    let auth = await RectoAuth(store: store)
    #expect(try await auth.claimMirrorForTesting(userId: "user_B") == false)
    #expect(await auth.status == .signedOut)
  }
}

@Suite("round-6 auth")
struct Round6AuthTests {
  @MainActor
  private final class ActiveSession {
    var id: String?

    init(_ id: String?) { self.id = id }
  }

  private actor OvertakingCoordinator: SyncControlling, EditSessionCoordinating {
    private var firstStopGate: CheckedContinuation<Void, Never>?
    private var firstStopObservers: [CheckedContinuation<Void, Never>] = []
    private(set) var stopCount = 0
    private(set) var startCount = 0

    func stop() async {
      stopCount += 1
      guard stopCount == 1 else { return }
      let observers = firstStopObservers
      firstStopObservers.removeAll()
      observers.forEach { $0.resume() }
      await withCheckedContinuation { firstStopGate = $0 }
    }

    func start() { startCount += 1 }
    func freezeAndFlushAll() async {}
    func resumeAll() async {}
    func invalidateAll() async {}

    func waitUntilFirstStop() async {
      guard stopCount == 0 else { return }
      await withCheckedContinuation { firstStopObservers.append($0) }
    }

    func releaseFirstStop() {
      firstStopGate?.resume()
      firstStopGate = nil
    }
  }

  /// Records the order of everything an identity change drives, and holds
  /// `stop()` open the way a subscription that has not torn down yet would.
  private actor Coordinator: SyncControlling, EditSessionCoordinating {
    private(set) var events: [String] = []
    private let suspendStop: Bool
    /// `stop()` parked here until the test lets it finish. A real `stop()`
    /// awaits subscriptions that are still delivering; anything that reaches
    /// the auth bridge in this window is talking to a client whose sockets the
    /// previous account is still using.
    private var stopGate: CheckedContinuation<Void, Never>?

    init(suspendStop: Bool = false) { self.suspendStop = suspendStop }

    func record(_ event: String) { events.append(event) }

    func stop() async {
      events.append("sync.stop.begin")
      if suspendStop {
        await withCheckedContinuation { self.stopGate = $0 }
      }
      events.append("sync.stop.end")
    }
    func releaseStop() {
      stopGate?.resume()
      stopGate = nil
    }
    /// Suspend until `stop()` is parked, so the test knows the window is open.
    func awaitStopBegan() async {
      // Bounded: a regression that never stops the sockets must fail the test,
      // not hang the suite.
      for _ in 0..<10_000 where !events.contains("sync.stop.begin") { await Task.yield() }
    }
    func start() async { events.append("sync.start") }
    func clear() { events.removeAll() }
    func freezeAndFlushAll() async { events.append("sessions.freeze") }
    func resumeAll() async { events.append("sessions.resume") }
    func invalidateAll() async { events.append("sessions.invalidate") }
  }

  private func storeOwnedByA() async throws -> RectoStore {
    let store = try RectoStore.inMemory()
    try await store.setMirrorOwner("user_A")
    try await store.save(
      DocumentRecord(
        localId: "doc-1", title: "A's work", markdown: "synced", wordCount: 1,
        localHeadNodeId: "root", syncState: .synced, updatedAt: 0, createdAt: 0))
    return store
  }

  @MainActor
  private func makeBlockedRecovery() async throws -> (
    auth: RectoAuth,
    coordinator: OvertakingCoordinator,
    session: ActiveSession
  ) {
    let store = try RectoStore.inMemory()
    try await store.setMirrorOwner("user_A")
    let auth = RectoAuth(store: store)
    let coordinator = OvertakingCoordinator()
    auth.attach(sync: coordinator)
    auth.attach(sessions: coordinator)
    let session = ActiveSession("sess_A")
    auth.convexAuthProvider.activeSessionID = { session.id }
    auth.convexAuthProvider.cachedLogin = { false }
    await auth.restoreSessionForTesting(userId: "user_A")
    #expect(auth.status == .convexLoginRequired(userId: "user_A"))
    auth.convexAuthProvider.cachedLogin = { true }
    return (auth, coordinator, session)
  }

  // MARK: - 1. Only RectoAuth may change the Convex identity, and only quiesced

  @Test("the Convex identity changes after the old account's sockets have stopped")
  func convexLoginWaitsForSocketTeardown() async throws {
    let store = try await storeOwnedByA()
    let auth = await RectoAuth(store: store)
    let coordinator = Coordinator(suspendStop: true)
    await auth.attach(sync: coordinator)
    await auth.attach(sessions: coordinator)
    await MainActor.run {
      auth.convexAuthProvider.activeSessionID = { "sess_B" }
      auth.convexAuthProvider.cachedLogin = {
        await coordinator.record("convex.login")
        return true
      }
    }

    let transition = Task { @MainActor in
      await auth.handleSessionSwitchForTesting(from: "user_A", toUserId: "user_B")
    }
    await coordinator.awaitStopBegan()
    // Wide open: nothing is holding the main actor, so a second listener would
    // have had every chance to reach `loginFromCache()` by now.
    for _ in 0..<50 { await Task.yield() }

    // The provider used to run its own `Clerk.shared.auth.events` listener, and
    // Clerk broadcasts to both streams with no ordering between them.
    #expect(
      await coordinator.events.contains("convex.login") == false,
      "the Convex identity changed while the previous account's sockets were up")

    await coordinator.releaseStop()
    await transition.value

    #expect(await coordinator.events == [
      "sessions.freeze", "sync.stop.begin", "sync.stop.end", "sessions.invalidate",
      "convex.login", "sessions.resume", "sync.start",
    ])
    #expect(await auth.status == .signedIn(userId: "user_B"))
  }

  @Test("a revoked session logs the Convex client out")
  func revocationLogsConvexOut() async throws {
    let store = try await storeOwnedByA()
    let auth = await RectoAuth(store: store)
    let coordinator = Coordinator()
    await auth.attach(sync: coordinator)
    await auth.attach(sessions: coordinator)
    await MainActor.run {
      auth.convexAuthProvider.activeSessionID = { nil }
      auth.convexAuthProvider.convexLogout = { await coordinator.record("convex.logout") }
    }

    await auth.handleSessionRevokedForTesting(previousUserId: "user_A")

    #expect(await auth.status == .signedOut)
    #expect(await coordinator.events.contains("convex.logout"))
    // Clerk is already gone; the client would otherwise hold a dead FFI bridge.
    let events = await coordinator.events
    let stopIndex = try #require(events.firstIndex(of: "sync.stop.end"))
    let logoutIndex = try #require(events.firstIndex(of: "convex.logout"))
    #expect(stopIndex < logoutIndex)
  }

  // MARK: - 2. An unowned mirror is purged before the new owner can read it

  @Test("a clean unowned mirror is emptied, not relabelled")
  func cleanUnownedMirrorIsPurged() async throws {
    let store = try RectoStore.inMemory()
    // No ownership marker: a mirror migrated from a build that predates them.
    try await store.save(
      DocumentRecord(
        localId: "doc-1", title: "an earlier session's work", markdown: "private text",
        wordCount: 2, localHeadNodeId: "root", syncState: .synced, updatedAt: 0, createdAt: 0))

    let auth = await RectoAuth(store: store)
    #expect(try await auth.claimMirrorForTesting(userId: "user_B"))

    // `stray == 0` used to be read as "this is safe to hand over", and B could
    // read the previous session's documents until sync eventually removed them.
    #expect(try await store.documents().isEmpty)
    #expect(try await store.mirrorOwner() == "user_B")
    #expect(await auth.status != .blockedByRetainedWork(owner: "an earlier session", count: 0))
  }

  @Test("a dirty unowned mirror blocks, and an explicit discard really discards")
  func dirtyUnownedMirrorRequiresConsent() async throws {
    let store = try RectoStore.inMemory()
    try await store.save(
      DocumentRecord(
        localId: "doc-1", title: "an earlier session's work", markdown: "", wordCount: 0,
        localHeadNodeId: "root", updatedAt: 0, createdAt: 0))
    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: "doc-1", kind: .commitEdit, clientMutationId: "m1", payload: "{}",
        createdAt: 0))

    let auth = await RectoAuth(store: store)
    await MainActor.run {
      auth.convexAuthProvider.activeSessionID = { "session-B" }
      auth.convexAuthProvider.cachedLogin = { true }
    }
    #expect(try await auth.claimMirrorForTesting(userId: "user_B") == false)
    #expect(try await store.pendingJobCount() == 1)
    #expect(await auth.status == .blockedByRetainedWork(owner: "an earlier session", count: 1))

    // The discard path only moved the marker, so the work the user had just
    // agreed to destroy was handed to B instead.
    #expect(await auth.discardRetainedWorkAndClaimForTesting(userId: "user_B"))
    #expect(try await store.documents().isEmpty)
    #expect(try await store.pendingJobCount() == 0)
    #expect(try await store.mirrorOwner() == "user_B")
  }

  // MARK: - 7. One failed login must not suppress every retry

  @Test("a failed cached login is retried for the same Clerk session")
  func failedLoginIsRetried() async throws {
    let store = try RectoStore.inMemory()
    try await store.setMirrorOwner("user_B")
    let auth = await RectoAuth(store: store)
    let coordinator = Coordinator()
    await auth.attach(sync: coordinator)
    await auth.attach(sessions: coordinator)

    let attempts = Counter()
    await MainActor.run {
      auth.convexAuthProvider.activeSessionID = { "sess_B" }
      auth.convexAuthProvider.cachedLogin = { await attempts.bump() > 1 }
      auth.convexAuthProvider.convexLogout = { await coordinator.record("convex.logout") }
    }

    // First transition: the token fetch fails. Recording the session id before
    // looking at the result made every later attempt return early, and a user
    // with an empty outbox never reaches the drain's auth-error recovery.
    await auth.handleSessionSwitchForTesting(from: "user_A", toUserId: "user_B")
    #expect(await attempts.value == 1)
    #expect(await auth.convexAuthProvider.needsCachedLogin, "the session is still unauthenticated")
    // NOT `.signedIn`. convex-swift keeps A's bridge when B's login fails, so a
    // socket started now can authenticate as A into a mirror that is already
    // B's. The transition is incomplete and the app has to say so.
    #expect(await auth.status == .convexLoginRequired(userId: "user_B"))
    #expect(await coordinator.events.contains("sync.start") == false, "sync stayed stopped")
    #expect(await coordinator.events.contains("sessions.resume") == false)
    #expect(
      await coordinator.events.contains("convex.logout"),
      "the previous account's auth bridge was removed")

    // Reconnect or foreground, with the sockets stopped for the bridge swap.
    #expect(await auth.recoverConvexLoginIfNeeded())
    #expect(await attempts.value == 2)
    #expect(await auth.convexAuthProvider.needsCachedLogin == false)
    #expect(await auth.status == .signedIn(userId: "user_B"))
    #expect(await coordinator.events.contains("sync.start"))

    // And it is a no-op once the session is synced — a login per foreground
    // would replace the auth bridge for no reason.
    #expect(await auth.recoverConvexLoginIfNeeded())
    #expect(await attempts.value == 2)
  }

  @Test("the retry stops the sockets before it replaces the bridge")
  func retryIsQuiesced() async throws {
    let store = try RectoStore.inMemory()
    try await store.setMirrorOwner("user_B")
    let auth = await RectoAuth(store: store)
    let coordinator = Coordinator(suspendStop: true)
    await auth.attach(sync: coordinator)
    await auth.attach(sessions: coordinator)

    let attempts = Counter()
    await MainActor.run {
      auth.convexAuthProvider.activeSessionID = { "sess_B" }
      auth.convexAuthProvider.cachedLogin = {
        await coordinator.record("convex.login")
        return await attempts.bump() > 1
      }
    }
    let first = Task { @MainActor in
      await auth.handleSessionSwitchForTesting(from: "user_A", toUserId: "user_B")
    }
    await coordinator.awaitStopBegan()
    await coordinator.releaseStop()
    await first.value
    await coordinator.clear()

    let retry = Task { @MainActor in await auth.recoverConvexLoginIfNeeded() }
    await coordinator.awaitStopBegan()
    for _ in 0..<50 { await Task.yield() }
    #expect(
      await coordinator.events.contains("convex.login") == false,
      "the retry replaced the auth bridge before the sockets were down")
    await coordinator.releaseStop()
    #expect(await retry.value)

    #expect(await coordinator.events == [
      "sync.stop.begin", "sync.stop.end", "convex.login", "sessions.resume", "sync.start",
    ])
  }

  @Test("a read-only session still hydrates once the login lands")
  func readOnlyLibraryHydratesAfterRecovery() async throws {
    let store = try RectoStore.inMemory()
    try await store.setMirrorOwner("user_B")
    let auth = await RectoAuth(store: store)
    let coordinator = Coordinator()
    await auth.attach(sync: coordinator)
    await auth.attach(sessions: coordinator)

    let attempts = Counter()
    await MainActor.run {
      auth.convexAuthProvider.activeSessionID = { "sess_B" }
      auth.convexAuthProvider.cachedLogin = { await attempts.bump() > 1 }
    }
    await auth.handleSessionSwitchForTesting(from: "user_A", toUserId: "user_B")

    // Nothing is queued, so no drain will ever fail and re-authenticate. The
    // recovery path is the only thing that can bring the library back.
    #expect(try await store.pendingJobCount() == 0)
    #expect(await auth.convexAuthProvider.needsCachedLogin)

    // The failed transition started nothing, so there is no socket to carry the
    // library — and nothing else will ever retry.
    #expect(await coordinator.events.contains("sync.start") == false)

    #expect(await auth.recoverConvexLoginIfNeeded())
    #expect(await auth.convexAuthProvider.needsCachedLogin == false)
    // Started exactly once, by the recovery that succeeded.
    #expect(await coordinator.events.filter { $0 == "sync.start" }.count == 1)
  }

  @MainActor
  @Test("a revoked session leaves a failed-login user signed out")
  func revokedSessionCannotRetryFailedIdentity() async throws {
    let (auth, coordinator, session) = try await makeBlockedRecovery()

    session.id = nil
    let revocation = Task { await auth.handleSessionChangeForTesting(to: nil) }
    await coordinator.waitUntilFirstStop()
    await coordinator.releaseFirstStop()
    await revocation.value

    #expect(auth.status == .signedOut)
    #expect(await auth.recoverConvexLoginIfNeeded() == false)
    #expect(await coordinator.startCount == 0)
  }

  @MainActor
  @Test("an account switch invalidates a suspended cached-login recovery")
  func accountSwitchOvertakesRecovery() async throws {
    let (auth, coordinator, session) = try await makeBlockedRecovery()

    let recovery = Task { await auth.recoverConvexLoginIfNeeded() }
    await coordinator.waitUntilFirstStop()
    session.id = "sess_B"
    await auth.handleSessionChangeForTesting(to: "user_B")
    #expect(auth.status == .signedIn(userId: "user_B"))
    #expect(await coordinator.startCount == 1)

    await coordinator.releaseFirstStop()
    #expect(await recovery.value == false)
    #expect(auth.status == .signedIn(userId: "user_B"))
    #expect(await coordinator.startCount == 1)
  }

  @MainActor
  @Test("sign-out invalidates a suspended cached-login recovery")
  func signOutOvertakesRecovery() async throws {
    let (auth, coordinator, session) = try await makeBlockedRecovery()

    let recovery = Task { await auth.recoverConvexLoginIfNeeded() }
    await coordinator.waitUntilFirstStop()
    session.id = nil
    try await auth.signOut(discardingUnsynced: true)
    #expect(auth.status == .signedOut)

    await coordinator.releaseFirstStop()
    #expect(await recovery.value == false)
    #expect(auth.status == .signedOut)
    #expect(await coordinator.startCount == 0)
  }

  @MainActor
  @Test("account deletion invalidates a suspended cached-login recovery")
  func accountDeletionOvertakesRecovery() async throws {
    let (auth, coordinator, session) = try await makeBlockedRecovery()

    let recovery = Task { await auth.recoverConvexLoginIfNeeded() }
    await coordinator.waitUntilFirstStop()
    session.id = nil
    await auth.handleAccountDeletedForTesting()
    #expect(auth.status == .signedOut)

    await coordinator.releaseFirstStop()
    #expect(await recovery.value == false)
    #expect(auth.status == .signedOut)
    #expect(await coordinator.startCount == 0)
  }
}

private actor Counter {
  private(set) var value = 0

  @discardableResult
  func bump() -> Int {
    value += 1
    return value
  }
}
