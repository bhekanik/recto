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
    if case .signedIn(let userId) = self { return userId }
    return nil
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
    case sessionChanged(userId: String?)
    case accountDeleted
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
    let events = clerkLifecycleEvents()
    let restored = Self.activeUserId(of: Clerk.shared.session)
    await start(restoredUserId: restored, events: events)
  }

  private func start(
    restoredUserId: String?,
    events: AsyncStream<LifecycleEvent>
  ) async {
    // Cold start: the database on disk may belong to somebody else. `status`
    // begins as `.loading`, so there is no "previous user" to compare against
    // and nothing else would ever notice.
    await restoreSession(userId: restoredUserId)

    eventListener = Task { [weak self] in
      for await event in events {
        if Task.isCancelled { break }
        guard let self else { break }
        switch event {
        case .sessionChanged(let userId):
          await self.performIdentityTransition(to: userId)
        case .accountDeleted:
          await self.handleAccountDeleted()
        }
      }
    }
  }

  private func clerkLifecycleEvents() -> AsyncStream<LifecycleEvent> {
    let clerkEvents = Clerk.shared.auth.events
    let (events, continuation) = AsyncStream<LifecycleEvent>.makeStream()
    clerkEventForwarder = Task {
      for await event in clerkEvents {
        if Task.isCancelled { break }
        switch event {
        case .sessionChanged(_, let newSession):
          continuation.yield(.sessionChanged(userId: Self.activeUserId(of: newSession)))
        case .signedOut:
          continuation.yield(.sessionChanged(userId: nil))
        case .accountDeleted:
          continuation.yield(.accountDeleted)
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
    events: AsyncStream<LifecycleEvent>
  ) async {
    eventListener?.cancel()
    clerkEventForwarder?.cancel()
    await start(restoredUserId: restoredUserId, events: events)
  }

  func waitForEventListenerForTesting() async {
    await eventListener?.value
  }

  private func restoreSession(userId: String?) async {
    guard await claimMirror(for: userId) else { return }
    guard let userId else {
      status = .signedOut
      await sync?.stop()
      return
    }
    await publishSignedIn(userId, blockingOnFailure: true)
  }

  func restoreSessionForTesting(userId: String?) async {
    await restoreSession(userId: userId)
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
    await performIdentityTransition(to: toUserId)
  }

  /// Test seam for a session Clerk revoked externally.
  func handleSessionRevokedForTesting(previousUserId: String) async {
    status = .signedIn(userId: previousUserId)
    await performIdentityTransition(to: nil)
  }

  /// Bring the app up for `userId` once the mirror is known to be theirs.
  ///
  /// Convex's identity changes HERE, after `sync.stop()` has returned and the
  /// mirror has been claimed, and before the sockets come back. A login replaces
  /// convex-swift's auth bridge and its FFI callback (#21/#26); doing it while
  /// the previous account's subscriptions are still running lets one of them
  /// deliver the new account's results into the old account's mirror.
  @discardableResult
  private func publishSignedIn(_ userId: String, blockingOnFailure: Bool) async -> Bool {
    guard await convexAuthProvider.syncActiveSession() else {
      // convex-swift keeps the previous account's `authBridge` and FFI callback
      // when a login fails — it publishes `unauthenticated`, but only `logout()`
      // clears those. Resuming sessions and starting sockets here opens
      // subscriptions that can still authenticate as the PREVIOUS user and copy
      // their documents into a mirror that now belongs to this one.
      logger.error("Convex refused the login for \(userId, privacy: .public); sync stays stopped")
      await convexAuthProvider.dropConvexBridge()
      if blockingOnFailure { status = .convexLoginRequired(userId: userId) }
      return false
    }
    status = .signedIn(userId: userId)
    await sessions?.resumeAll()
    await sync?.start()
    return true
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
      guard convexAuthProvider.needsCachedLogin else { return true }
      // The mirror is already this user's, so a failure is only an outage: the
      // status stays `.signedIn` and offline editing continues into the outbox.
      (userId, blocking) = (id, false)
    case .convexLoginRequired(let id):
      // The transition never completed. Until it does, nothing may run.
      (userId, blocking) = (id, true)
    default:
      return true
    }
    logger.info("retrying the cached Convex login with the sockets stopped")
    await sync?.stop()
    return await publishSignedIn(userId, blockingOnFailure: blocking)
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
    transitionCount += 1
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
        await sessions?.resumeAll()
        await sync?.start()
        throw error
      }
      guard pending == 0 else {
        // Refused: put the app back the way it was.
        await sessions?.resumeAll()
        await sync?.start()
        throw RectoAuthError.unsyncedWork(count: pending)
      }
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
      status = .signedOut
      throw error
    }
    try await store.purgeAndSetMirrorOwner(nil)
    await sessions?.invalidateAll()
    status = .signedOut
  }

  // MARK: - Private

  /// The ONE ordering an identity change takes: freeze editing, stop and await
  /// every socket, settle mirror ownership, change the Convex identity, publish,
  /// and only then bring the sockets back.
  private func performIdentityTransition(to nextUserId: String?) async {
    let previousUserId = status.userId
    guard previousUserId != nextUserId else { return }

    transitionCount += 1
    defer { transitionCount -= 1 }
    // Stop everything that could still write BEFORE any decision is taken.
    await sessions?.freezeAndFlushAll()
    await sync?.stop()

    // Clerk revoked the session out from under us (another device signed out,
    // an admin ended it, the token was refused). We cannot ask for consent, and
    // deleting offline work without it is not ours to do.
    if nextUserId == nil {
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

    guard let nextUserId else { return }
    await switchOwner(to: nextUserId)
  }

  /// A direct A-to-B switch. NOTHING is deleted here: `claimMirror` owns that
  /// decision, and purging first would hand it a clean store and remove its
  /// only chance to object.
  private func switchOwner(to nextUserId: String) async {
    guard await claimMirror(for: nextUserId) else { return }
    // Freezing stopped new writes; it did not empty what the open windows had
    // already loaded. This is the only point at which A's text is gone from
    // both SQLite and memory.
    await sessions?.invalidateAll()
    await publishSignedIn(nextUserId, blockingOnFailure: true)
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
    guard Self.isClerkConfigured, let userId = Self.activeUserId(of: Clerk.shared.session) else {
      logger.error("refusing to discard retained work: no active Clerk session to claim it for")
      return false
    }
    return await completeDiscard(userId: userId)
  }

  /// Abandon the attempted account switch without touching the retained mirror.
  public func cancelBlockedSignIn() async throws {
    guard case .blockedByRetainedWork = status else { return }
    await sync?.stop()
    await convexAuthProvider.logoutConvexClient()
    if Self.isClerkConfigured {
      try await convexAuthProvider.logout()
    }
    status = .signedOut
  }

  private func completeDiscard(userId: String) async -> Bool {
    guard await claimMirror(for: userId, discardingRetainedWork: true) else { return false }
    await sessions?.invalidateAll()
    return await publishSignedIn(userId, blockingOnFailure: true)
  }

  /// Test seam: the same completion without a live Clerk session.
  func discardRetainedWorkAndClaimForTesting(userId: String) async -> Bool {
    await completeDiscard(userId: userId)
  }

  private func handleAccountDeleted() async {
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
    status = .signedOut
  }

  private static func activeUserId(of session: Session?) -> String? {
    guard let session, session.status == .active else { return nil }
    return session.user?.id
  }
}
