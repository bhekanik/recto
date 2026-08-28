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
      try? await store.saveDraft(
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
