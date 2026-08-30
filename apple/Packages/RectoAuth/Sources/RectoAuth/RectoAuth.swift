import ClerkKit
import Foundation
import OSLog
import RectoStore

/// Which sign-in methods this build offers.
///
/// D-N12 wants Google, email, Sign in with Apple and passkeys. Google and email
/// work against the dev Clerk instance today; SIWA needs the Native Applications
/// entry (App ID prefix + bundle id) and a services id/key, and passkeys need
/// associated domains plus the matching entitlement — neither is configured yet
/// (N0a §4). They ship behind these flags rather than as dead buttons that fail
/// at the point of tapping.
public struct AuthFeatures: Sendable, Equatable {
  public var appleSignIn: Bool
  public var passkeys: Bool

  public init(appleSignIn: Bool = false, passkeys: Bool = false) {
    self.appleSignIn = appleSignIn
    self.passkeys = passkeys
  }

  /// What the dev Clerk instance actually supports today.
  public static let current = AuthFeatures()
  public static let all = AuthFeatures(appleSignIn: true, passkeys: true)
}

/// What `RectoAuth` needs from the sync layer around an identity change.
///
/// Declared here and conformed to by `SyncEngine`, because the dependency runs
/// the other way: sync knows about auth, not auth about sync.
public protocol SyncControlling: Sendable {
  /// Drop every socket. Must return only once nothing else will write.
  func stop() async
  func start() async
}

/// The open editor sessions, from auth's point of view.
///
/// Sign-out has to stop new text arriving before it can honestly say how much is
/// unsynced: a check followed by a purge is otherwise separated by two awaits an
/// open document can write in.
public protocol EditSessionCoordinating: Sendable {
  /// Stop accepting edits and flush what is pending. Returns once no session
  /// will write again.
  func freezeAndFlushAll() async
  /// Let editing continue — a refused sign-out must not leave the app frozen.
  func resumeAll() async
  /// Throw away every session's in-memory copy of the mirror.
  ///
  /// Freezing stops new writes; it does not empty what a window has already
  /// loaded. A session opened before an account switch still holds the previous
  /// account's title, text, controller and node map after the purge, and the
  /// next render would show them to whoever just signed in. Called after the
  /// purge and before the new identity is published.
  func invalidateAll() async
}

public enum AuthStatus: Sendable, Equatable {
  /// Clerk has not finished restoring a keychain session yet.
  case loading
  case signedOut
  case signedIn(userId: String)
  /// A different account's mirror is on this disk and it still holds work that
  /// exists nowhere else. The UI must offer "recover as \(owner)" or an explicit
  /// discard; signing in over it would delete that work.
  case blockedByRetainedWork(owner: String, count: Int)
  /// Clerk has this user, the mirror is theirs, and Convex refused the login.
  /// Sync is stopped and editing stays frozen: nothing may read or write the
  /// mirror until `recoverConvexLoginIfNeeded()` succeeds. The UI shows "cannot
  /// reach Recto" and a retry, not the library.
  case convexLoginRequired(userId: String)

  public var userId: String? {
    switch self {
    case .signedIn(let userId), .convexLoginRequired(let userId): userId
    case .loading, .signedOut, .blockedByRetainedWork: nil
    }
  }
}

/// A started email-code sign-in, waiting on the six-digit code.
@MainActor
public struct EmailCodeChallenge {
  private var signIn: SignIn
  public let emailAddress: String

  init(signIn: SignIn, emailAddress: String) {
    self.signIn = signIn
    self.emailAddress = emailAddress
  }

  @discardableResult
  public mutating func verify(code: String) async throws -> SignIn {
    let verified = try await signIn.verifyCode(code)
    signIn = verified
    return verified
  }
}

/// Clerk session lifecycle for the native apps (plan 023 §1.6, D-N12).
@MainActor
public final class RectoAuth {
  enum LifecycleEvent: Sendable {
    case sessionChanged(userId: String?, sessionID: String?)
    case accountDeleted
  }

  private struct ObservedLifecycleEvent: Sendable {
    let event: LifecycleEvent
  }

  private struct ClerkIdentity: Sendable, Equatable {
    let userID: String
    let sessionID: String
  }

  private let logger = Logger(subsystem: "com.bhekani.recto", category: "auth")
  private let store: RectoStore
  private let features: AuthFeatures
  private var sync: (any SyncControlling)?
  private var sessions: (any EditSessionCoordinating)?
  private var statusContinuations: [UUID: AsyncStream<AuthStatus>.Continuation] = [:]
  private var eventListener: Task<Void, Never>?
  private var clerkEventForwarder: Task<Void, Never>?
  private var transitionCount = 0
  private var lifecycleEpoch = 0
  private var expectedIdentity: ClerkIdentity?

  private struct IdentityLease: Equatable {
    let lifecycleEpoch: Int
    let identity: ClerkIdentity
  }

  private struct PublicationContainment {
    let lease: IdentityLease
    let task: Task<Void, Never>
  }

  private var activePublicationLease: IdentityLease?
  private var publicationContainment: PublicationContainment?

  private func beginTransition() {
    transitionCount += 1
    lifecycleEpoch += 1
  }

  /// Hand this to `ConvexClientWithAuth(deploymentUrl:authProvider:)`.
  public let convexAuthProvider: ConvexTemplateAuthProvider

  public private(set) var status: AuthStatus = .loading {
    didSet {
      guard status != oldValue else { return }
      for continuation in statusContinuations.values { continuation.yield(status) }
    }
  }

  /// Set before an identity change can suspend, and cleared only after its final socket action.
  public var isTransitioning: Bool { transitionCount > 0 }

  public init(store: RectoStore, features: AuthFeatures = .current) {
    self.store = store
    self.features = features
    self.convexAuthProvider = ConvexTemplateAuthProvider()
  }

  /// Wire the sync engine in after it has been built (it needs the provider this
  /// object owns, so the two cannot be constructed in one step).
  public func attach(sync: any SyncControlling) {
    self.sync = sync
  }

  /// Wire the session registry in so sign-out can freeze editing first.
  public func attach(sessions: any EditSessionCoordinating) {
    self.sessions = sessions
  }

  deinit {
    eventListener?.cancel()
    clerkEventForwarder?.cancel()
  }

  /// Whether `configureClerk` has run in this process.
  ///
  /// `Clerk.shared` calls `fatalError` when it has not been configured, so every
  /// path that might run before the app's `init` — or in a test, a widget, or a
  /// share extension that never configures it — has to check first rather than
  /// crash.
  public private(set) static var isClerkConfigured = false

  /// Configure the Clerk SDK. Call once, from the app's `init`.
  public static func configureClerk(publishableKey: String) {
    Clerk.configure(publishableKey: publishableKey)
    isClerkConfigured = true
  }

  /// Publish the restored session, then follow Clerk's auth events.
  ///
  /// `Clerk.configure` does not block; `isLoaded` flips once the keychain
  /// session has been restored, and until then the UI must show "checking"
  /// rather than the signed-out screen.
  public func start() async {
    guard Self.isClerkConfigured else {
      status = .signedOut
      return
    }
    while !Clerk.shared.isLoaded {
      try? await Task.sleep(for: .milliseconds(50))
    }

    eventListener?.cancel()
    clerkEventForwarder?.cancel()
    let clerkEvents = Clerk.shared.auth.events
    let restored = Self.activeIdentity(of: Clerk.shared.session)
    expectedIdentity = restored
    let events = clerkLifecycleEvents(from: clerkEvents)
    await start(restoredIdentity: restored, events: events)
  }

  private func start(
    restoredIdentity: ClerkIdentity?,
    events: AsyncStream<ObservedLifecycleEvent>
  ) async {
    // Cold start: the database on disk may belong to somebody else. `status`
    // begins as `.loading`, so there is no "previous user" to compare against
    // and nothing else would ever notice.
    await restoreSession(identity: restoredIdentity)

    eventListener = Task { [weak self] in
      for await observed in events {
        if Task.isCancelled { break }
        guard let self else { break }
        switch observed.event {
        case .sessionChanged(let userID, let sessionID):
          await self.performObservedIdentityTransition(
            to: Self.identity(userID: userID, sessionID: sessionID))
        case .accountDeleted:
          await self.handleObservedAccountDeleted()
        }
      }
    }
  }

  private func clerkLifecycleEvents(from clerkEvents: AsyncStream<AuthEvent>)
    -> AsyncStream<ObservedLifecycleEvent>
  {
    let (events, continuation) = AsyncStream<ObservedLifecycleEvent>.makeStream()
    clerkEventForwarder = Task {
      for await event in clerkEvents {
        if Task.isCancelled { break }
        switch event {
        case .sessionChanged(_, let newSession):
          let identity = Self.activeIdentity(of: newSession)
          forwardObserved(
            .sessionChanged(userId: identity?.userID, sessionID: identity?.sessionID),
            to: continuation)
        case .signedOut:
          forwardObserved(.sessionChanged(userId: nil, sessionID: nil), to: continuation)
        case .accountDeleted:
          forwardObserved(.accountDeleted, to: continuation)
        default:
          continue
        }
      }
      continuation.finish()
    }
    return events
  }

  func startForTesting(
    restoredUserId: String?,
    restoredSessionID: String? = nil,
    events: AsyncStream<LifecycleEvent>
  ) async {
    eventListener?.cancel()
    clerkEventForwarder?.cancel()
    let identity = Self.identity(userID: restoredUserId, sessionID: restoredSessionID)
    expectedIdentity = identity
    let observedEvents = observedLifecycleEvents(from: events)
    await start(restoredIdentity: identity, events: observedEvents)
  }

  private func observedLifecycleEvents(from source: AsyncStream<LifecycleEvent>)
    -> AsyncStream<ObservedLifecycleEvent>
  {
    let (events, continuation) = AsyncStream<ObservedLifecycleEvent>.makeStream()
    clerkEventForwarder = Task {
      for await event in source {
        if Task.isCancelled { break }
        forwardObserved(event, to: continuation)
      }
      continuation.finish()
    }
    return events
  }

  private func forwardObserved(
    _ event: LifecycleEvent,
    to continuation: AsyncStream<ObservedLifecycleEvent>.Continuation
  ) {
    let nextIdentity: ClerkIdentity?
    switch event {
    case .sessionChanged(let userID, let sessionID):
      nextIdentity = Self.identity(userID: userID, sessionID: sessionID)
      guard expectedIdentity != nextIdentity else { return }
    case .accountDeleted:
      nextIdentity = nil
    }

    lifecycleEpoch += 1
    expectedIdentity = nextIdentity
    status = .loading
    continuation.yield(ObservedLifecycleEvent(event: event))

    guard let lease = activePublicationLease,
      publicationContainment?.lease != lease
    else { return }
    let task = Task { @MainActor [weak self] in
      guard let self else { return }
      await self.containSupersededPublication()
    }
    publicationContainment = PublicationContainment(lease: lease, task: task)
  }

  func waitForEventListenerForTesting() async {
    await eventListener?.value
  }

  private func restoreSession(identity: ClerkIdentity?) async {
    guard await claimMirror(for: identity?.userID) else { return }
    guard let identity else {
      status = .signedOut
      await sync?.stop()
      return
    }
    guard let lease = identityLease(for: identity) else { return }
    await publishSignedIn(identity, blockingOnFailure: true, lease: lease)
  }

  func restoreSessionForTesting(userId: String?) async {
    let identity = Self.identity(
      userID: userId, sessionID: convexAuthProvider.activeSessionID())
    expectedIdentity = identity
    await restoreSession(identity: identity)
  }

  /// The ONE path an owner transition takes.
  ///
  /// Every caller — cold start, account switch, revocation, explicit discard —
  /// comes through here, because anything that purges before checking ownership
  /// hands `claimMirror` a clean store and removes its only chance to object.
  ///
  /// Fails **closed**: if the store cannot be read the transition is refused
  /// rather than authorised. A read error is not evidence that there is nothing
  /// to lose.
  private func claimMirror(for userId: String?, discardingRetainedWork: Bool = false) async
    -> Bool
  {
    do {
      let owner = try await store.mirrorOwner()
      guard owner != userId else { return true }

      switch (owner, userId) {
      case (let owner?, let userId?):
        // Somebody else's documents are on this disk. A signed-in session
        // cannot proceed over them — but if the previous owner has work that
        // reached nowhere else (a revoked session retains exactly that), purging
        // to make room would destroy it without anyone consenting.
        let retained = try await store.unsyncedWorkCount()
        guard retained == 0 || discardingRetainedWork else {
          logger.error(
            "mirror belongs to \(owner, privacy: .public) and holds \(retained) unsynced change(s); refusing to sign in as another account"
          )
          retainedUnsyncedWork = retained
          status = .blockedByRetainedWork(owner: owner, count: retained)
          return false
        }
        try await store.purgeAndSetMirrorOwner(userId)
        retainedUnsyncedWork = 0

      case (nil, let userId?):
        // An unowned mirror. Anything already on disk predates ownership
        // tracking, so it is not safely attributable to this user.
        let stray = try await store.unsyncedWorkCount()
        guard stray == 0 || discardingRetainedWork else {
          logger.error("unowned mirror holds \(stray) unsynced change(s); refusing to claim it")
          retainedUnsyncedWork = stray
          status = .blockedByRetainedWork(owner: "an earlier session", count: stray)
          return false
        }
        // PURGE, not just relabel. Rows with no ownership marker are still
        // somebody's documents: a migrated mirror whose work had all synced
        // passed the `stray == 0` check and was handed to the next person to
        // sign in, who could read it until sync eventually removed it. The
        // explicit-discard path was worse — it skipped the block and then kept
        // the very work the user had just agreed to destroy.
        try await store.purgeAndSetMirrorOwner(userId)
        retainedUnsyncedWork = 0

      case (let owner?, nil):
        // Signed out with data still on disk: leave it, it belongs to `owner`
        // and they may come back.
        _ = owner

      case (nil, nil):
        break
      }
      return true
    } catch {
      // Failing to establish ownership must block the transition, not open the
      // previous account's documents under a new session.
      logger.error(
        "could not establish mirror ownership: \(error.localizedDescription, privacy: .public)")
      status = .signedOut
      return false
    }
  }

  /// Test seam for the ownership check, otherwise only reachable through Clerk.
  func claimMirrorForTesting(userId: String?, discardingRetainedWork: Bool = false) async throws
    -> Bool
  {
    await claimMirror(for: userId, discardingRetainedWork: discardingRetainedWork)
  }

  /// Test seam for a direct active-to-active session change.
  func handleSessionSwitchForTesting(from previousUserId: String, toUserId: String) async {
    status = .signedIn(userId: previousUserId)
    expectedIdentity = ClerkIdentity(userID: previousUserId, sessionID: "previous-test-session")
    guard let nextSessionID = convexAuthProvider.activeSessionID() else { return }
    await performIdentityTransition(
      to: ClerkIdentity(userID: toUserId, sessionID: nextSessionID))
  }

  /// Test seam for a session Clerk revoked externally.
  func handleSessionRevokedForTesting(previousUserId: String) async {
    status = .signedIn(userId: previousUserId)
    expectedIdentity = ClerkIdentity(userID: previousUserId, sessionID: "previous-test-session")
    await performIdentityTransition(to: nil)
  }

  func handleSessionChangeForTesting(to userId: String?) async {
    await performIdentityTransition(
      to: Self.identity(
        userID: userId, sessionID: convexAuthProvider.activeSessionID()))
  }

  func handleAccountDeletedForTesting() async {
    await handleAccountDeleted()
  }

  /// Bring the app up for `userId` once the mirror is known to be theirs.
  ///
  /// Convex's identity changes HERE, after `sync.stop()` has returned and the
  /// mirror has been claimed, and before the sockets come back. A login replaces
  /// convex-swift's auth bridge and its FFI callback (#21/#26); doing it while
  /// the previous account's subscriptions are still running lets one of them
  /// deliver the new account's results into the old account's mirror.
  @discardableResult
  private func publishSignedIn(
    _ identity: ClerkIdentity,
    blockingOnFailure: Bool,
    lease: IdentityLease
  ) async -> Bool {
    guard isCurrent(lease) else { return false }
    activePublicationLease = lease
    defer {
      if activePublicationLease == lease { activePublicationLease = nil }
    }
    let loginSucceeded = await convexAuthProvider.syncActiveSession()
    guard await containIfSuperseded(lease) else { return false }
    guard loginSucceeded else {
      // convex-swift keeps the previous account's `authBridge` and FFI callback
      // when a login fails — it publishes `unauthenticated`, but only `logout()`
      // clears those. Resuming sessions and starting sockets here opens
      // subscriptions that can still authenticate as the PREVIOUS user and copy
      // their documents into a mirror that now belongs to this one.
      logger.error(
        "Convex refused the login for \(identity.userID, privacy: .public); sync stays stopped")
      await convexAuthProvider.dropConvexBridge()
      guard await containIfSuperseded(lease) else { return false }
      if blockingOnFailure { status = .convexLoginRequired(userId: identity.userID) }
      return false
    }
    await sessions?.resumeAll()
    guard await containIfSuperseded(lease) else { return false }
    status = .signedIn(userId: identity.userID)
    await sync?.start()
    guard await containIfSuperseded(lease) else { return false }
    return true
  }

  private func containIfSuperseded(_ lease: IdentityLease) async -> Bool {
    guard !isCurrent(lease) else { return true }
    if let containment = publicationContainment, containment.lease == lease {
      await containment.task.value
      if publicationContainment?.lease == lease { publicationContainment = nil }
    }
    // The suspended operation may apply its side effect after eager containment.
    // This inline pass completes before the serialized consumer can start C.
    await containSupersededPublication()
    return false
  }

  private func containSupersededPublication() async {
    await sessions?.freezeAndFlushAll()
    await sync?.stop()
  }

  private func identityLease(for identity: ClerkIdentity) -> IdentityLease? {
    guard expectedIdentity == identity,
      convexAuthProvider.activeSessionID() == identity.sessionID
    else { return nil }
    return IdentityLease(lifecycleEpoch: lifecycleEpoch, identity: identity)
  }

  private func isCurrent(_ lease: IdentityLease) -> Bool {
    lifecycleEpoch == lease.lifecycleEpoch
      && expectedIdentity == lease.identity
      && convexAuthProvider.activeSessionID() == lease.identity.sessionID
  }

  /// Retry a cached Convex login that failed, with the sockets down.
  ///
  /// Call on reconnect and on foreground. A user with nothing in the outbox
  /// never reaches the drain's auth-error recovery, so without this one failed
  /// login left the library empty until the process restarted.
  @discardableResult
  public func recoverConvexLoginIfNeeded() async -> Bool {
    let userId: String
    let blocking: Bool
    switch status {
    case .signedIn(let id):
      guard convexAuthProvider.needsCachedLogin else {
        return convexAuthProvider.activeSessionID() != nil
      }
      // The mirror is already this user's, so a failure is only an outage: the
      // status stays `.signedIn` and offline editing continues into the outbox.
      (userId, blocking) = (id, false)
    case .convexLoginRequired(let id):
      // The transition never completed. Until it does, nothing may run.
      (userId, blocking) = (id, true)
    default:
      return false
    }
    guard let sessionID = convexAuthProvider.activeSessionID() else { return false }
    let identity = ClerkIdentity(userID: userId, sessionID: sessionID)
    guard let lease = identityLease(for: identity) else { return false }
    logger.info("retrying the cached Convex login with the sockets stopped")
    await sync?.stop()
    guard isCurrent(lease) else { return false }
    return await publishSignedIn(identity, blockingOnFailure: blocking, lease: lease)
  }

  /// Status changes, for the UI and for `RectoSync` (which must re-subscribe on
  /// every transition: a Convex subscription that hit a server error is a
  /// terminated Combine publisher and never comes back on its own).
  public var statusUpdates: AsyncStream<AuthStatus> {
    AsyncStream { continuation in
      let id = UUID()
      statusContinuations[id] = continuation
      continuation.yield(status)
      continuation.onTermination = { [weak self] _ in
        Task { @MainActor [weak self] in self?.statusContinuations[id] = nil }
      }
    }
  }

  // MARK: - Sign in

  public func signInWithEmailCode(emailAddress: String) async throws -> EmailCodeChallenge {
    guard Self.isClerkConfigured else { throw RectoAuthError.clerkNotLoaded }
    let signIn = try await Clerk.shared.auth.signInWithEmailCode(emailAddress: emailAddress)
    return EmailCodeChallenge(signIn: signIn, emailAddress: emailAddress)
  }

  /// Google via the native redirect. clerk-ios defaults the OAuth redirect to
  /// `{bundleIdentifier}://callback`, so `com.bhekani.recto://callback` must be
  /// registered on the Clerk instance and as a URL type in the app.
  public func signInWithGoogle() async throws {
    guard Self.isClerkConfigured else { throw RectoAuthError.clerkNotLoaded }
    _ = try await Clerk.shared.auth.signInWithOAuth(provider: .google)
  }

  public func signInWithApple() async throws {
    guard features.appleSignIn else { throw RectoAuthError.featureDisabled("Sign in with Apple") }
    guard Self.isClerkConfigured else { throw RectoAuthError.clerkNotLoaded }
    _ = try await Clerk.shared.auth.signInWithApple()
  }

  public func signInWithPasskey() async throws {
    guard features.passkeys else { throw RectoAuthError.featureDisabled("Passkeys") }
    guard Self.isClerkConfigured else { throw RectoAuthError.clerkNotLoaded }
    _ = try await Clerk.shared.auth.signInWithPasskey()
  }

  // MARK: - Sign out

  /// Work that exists only on this device.
  public struct UnsyncedWork: Sendable, Equatable {
    public var count: Int
    public var isEmpty: Bool { count == 0 }
  }

  /// What sign-out would destroy. Ask before offering the button.
  public func unsyncedWork() async throws -> UnsyncedWork {
    UnsyncedWork(count: try await store.unsyncedWorkCount())
  }

  /// End the Clerk session and purge the local mirror.
  ///
  /// Refuses by default when the outbox or a draft row still holds text: those
  /// are the user's ONLY copy — offline commits are not re-derivable from Convex
  /// — and signing out on a train would delete them silently.
  ///
  /// The order matters. Editing is frozen and flushed FIRST, then sync stops,
  /// and only then is the final count taken, immediately before the purge in the
  /// same breath. Checking before those awaits let an open document persist a
  /// new draft into the gap and lose it without consent.
  public func signOut(discardingUnsynced: Bool = false) async throws {
    beginTransition()
    let refusalEpoch = lifecycleEpoch
    let refusalIdentity = expectedIdentity
    defer { transitionCount -= 1 }
    await sessions?.freezeAndFlushAll()
    await sync?.stop()

    if !discardingUnsynced {
      // Fail closed: a store that cannot be counted has not been shown to be
      // empty, and `try?` turning that into zero authorises the purge.
      let pending: Int
      do {
        pending = try await store.unsyncedWorkCount()
      } catch {
        await resumeAfterRefusedSignOut(epoch: refusalEpoch, identity: refusalIdentity)
        throw error
      }
      guard pending == 0 else {
        await resumeAfterRefusedSignOut(epoch: refusalEpoch, identity: refusalIdentity)
        throw RectoAuthError.unsyncedWork(count: pending)
      }
    }

    if isExpected(epoch: refusalEpoch, identity: refusalIdentity) {
      lifecycleEpoch += 1
      expectedIdentity = nil
    }

    do {
      // The Convex client first, through the SDK's own `logout()`: it is the
      // only path that drops the FFI auth callback. Ending the Clerk session
      // alone leaves the client holding a dead bridge.
      await convexAuthProvider.logoutConvexClient()
      if Self.isClerkConfigured { try await convexAuthProvider.logout() }
    } catch {
      logger.error("clerk sign-out failed: \(error.localizedDescription, privacy: .public)")
      // The text still has to go: a network error must not leave a signed-out
      // user's drafts readable on a shared Mac. One transaction, so ownership
      // never moves without the rows going with it.
      try await store.purgeAndSetMirrorOwner(nil)
      await sessions?.invalidateAll()
      status = expectedIdentity == nil ? .signedOut : .loading
      throw error
    }
    try await store.purgeAndSetMirrorOwner(nil)
    await sessions?.invalidateAll()
    status = expectedIdentity == nil ? .signedOut : .loading
  }

  private func resumeAfterRefusedSignOut(epoch: Int, identity: ClerkIdentity?) async {
    guard isCurrent(epoch: epoch, identity: identity) else { return }
    await sessions?.resumeAll()
    guard isCurrent(epoch: epoch, identity: identity) else {
      await containSupersededPublication()
      return
    }
    await sync?.start()
    guard isCurrent(epoch: epoch, identity: identity) else {
      await containSupersededPublication()
      return
    }
  }

  private func isCurrent(epoch: Int, identity: ClerkIdentity?) -> Bool {
    guard isExpected(epoch: epoch, identity: identity) else { return false }
    guard let identity else { return true }
    return convexAuthProvider.activeSessionID() == identity.sessionID
  }

  private func isExpected(epoch: Int, identity: ClerkIdentity?) -> Bool {
    lifecycleEpoch == epoch && expectedIdentity == identity
  }

  // MARK: - Private

  /// The ONE ordering an identity change takes: freeze editing, stop and await
  /// every socket, settle mirror ownership, change the Convex identity, publish,
  /// and only then bring the sockets back.
  private func performIdentityTransition(to nextIdentity: ClerkIdentity?) async {
    guard expectedIdentity != nextIdentity else { return }

    lifecycleEpoch += 1
    expectedIdentity = nextIdentity
    status = .loading
    await performObservedIdentityTransition(to: nextIdentity)
  }

  private func performObservedIdentityTransition(to nextIdentity: ClerkIdentity?) async {
    guard expectedIdentity == nextIdentity else { return }

    beginTransition()
    defer { transitionCount -= 1 }
    // Stop everything that could still write BEFORE any decision is taken.
    await sessions?.freezeAndFlushAll()
    await sync?.stop()

    // Clerk revoked the session out from under us (another device signed out,
    // an admin ended it, the token was refused). We cannot ask for consent, and
    // deleting offline work without it is not ours to do.
    if nextIdentity == nil {
      let pending: Int
      do {
        pending = try await store.unsyncedWorkCount()
      } catch {
        // Unknown is not zero.
        logger.error(
          "could not count unsynced work after revocation; retaining the mirror: \(error.localizedDescription, privacy: .public)"
        )
        status = .signedOut
        return
      }
      // Clerk has already dropped the session; the client is holding a dead
      // bridge until the SDK's own `logout()` clears the FFI callback.
      await convexAuthProvider.logoutConvexClient()
      if pending > 0 {
        // Retained, not deleted, and not readable: the data stays owned by the
        // previous account, so `claimMirror` refuses to open it under anyone
        // else and a later sign-in by the same user recovers it.
        logger.error(
          "session revoked with \(pending) unsynced change(s); retaining them for the previous account"
        )
        retainedUnsyncedWork = pending
        status = .signedOut
        return
      }
      try? await store.purgeAndSetMirrorOwner(nil)
      await sessions?.invalidateAll()
      status = .signedOut
      return
    }

    guard let nextIdentity else { return }
    await switchOwner(to: nextIdentity)
  }

  /// A direct A-to-B switch. NOTHING is deleted here: `claimMirror` owns that
  /// decision, and purging first would hand it a clean store and remove its
  /// only chance to object.
  private func switchOwner(to nextIdentity: ClerkIdentity) async {
    guard await claimMirror(for: nextIdentity.userID) else { return }
    // Freezing stopped new writes; it did not empty what the open windows had
    // already loaded. This is the only point at which A's text is gone from
    // both SQLite and memory.
    await sessions?.invalidateAll()
    guard let lease = identityLease(for: nextIdentity) else { return }
    await publishSignedIn(nextIdentity, blockingOnFailure: true, lease: lease)
  }

  /// Unsynced work that outlived a revoked session. The UI surfaces it on the
  /// next sign-in by the same account.
  public private(set) var retainedUnsyncedWork = 0

  private func emitRetainedWork(count: Int) {
    retainedUnsyncedWork = count
  }

  /// The user confirmed deletion of the previous account's retained work.
  ///
  /// Takes no user id on purpose: the identity comes from the active Clerk
  /// session, so a caller cannot claim the mirror for somebody who is not
  /// actually signed in. Completes the whole transition — purge, ownership,
  /// published status, sessions resumed, sync started — so the UI is not left
  /// blocked over a store that has already been emptied.
  @discardableResult
  public func discardRetainedWorkAndClaim() async -> Bool {
    guard Self.isClerkConfigured, let identity = Self.activeIdentity(of: Clerk.shared.session) else {
      logger.error("refusing to discard retained work: no active Clerk session to claim it for")
      return false
    }
    return await completeDiscard(identity: identity)
  }

  /// Abandon the attempted account switch without touching the retained mirror.
  public func cancelBlockedSignIn() async throws {
    guard case .blockedByRetainedWork = status else { return }
    beginTransition()
    expectedIdentity = nil
    defer { transitionCount -= 1 }
    await sync?.stop()
    await convexAuthProvider.logoutConvexClient()
    if Self.isClerkConfigured {
      try await convexAuthProvider.logout()
    }
    status = .signedOut
  }

  private func completeDiscard(identity: ClerkIdentity) async -> Bool {
    expectedIdentity = identity
    guard await claimMirror(for: identity.userID, discardingRetainedWork: true) else { return false }
    await sessions?.invalidateAll()
    guard let lease = identityLease(for: identity) else { return false }
    return await publishSignedIn(identity, blockingOnFailure: true, lease: lease)
  }

  /// Test seam: the same completion without a live Clerk session.
  func discardRetainedWorkAndClaimForTesting(userId: String) async -> Bool {
    guard let identity = Self.identity(
      userID: userId, sessionID: convexAuthProvider.activeSessionID())
    else { return false }
    return await completeDiscard(identity: identity)
  }

  private func handleAccountDeleted() async {
    lifecycleEpoch += 1
    expectedIdentity = nil
    status = .loading
    await handleObservedAccountDeleted()
  }

  private func handleObservedAccountDeleted() async {
    beginTransition()
    defer { transitionCount -= 1 }
    await sessions?.freezeAndFlushAll()
    await sync?.stop()
    await convexAuthProvider.logoutConvexClient()
    do {
      // The account is gone; there is nowhere left to sync to, so retaining is
      // pointless and the rows must not outlive it.
      try await store.purgeAndSetMirrorOwner(nil)
    } catch {
      logger.error(
        "purge after account deletion failed: \(error.localizedDescription, privacy: .public)")
    }
    await sessions?.invalidateAll()
    // A later session event may already be observed but cannot run its heavy
    // transition until this ordered deletion returns. Preserve that successor.
    status = expectedIdentity == nil ? .signedOut : .loading
  }

  private static func activeIdentity(of session: Session?) -> ClerkIdentity? {
    guard let session, session.status == .active else { return nil }
    return identity(userID: session.user?.id, sessionID: session.id)
  }

  private static func identity(userID: String?, sessionID: String?) -> ClerkIdentity? {
    guard let userID, let sessionID else { return nil }
    return ClerkIdentity(userID: userID, sessionID: sessionID)
  }
}
