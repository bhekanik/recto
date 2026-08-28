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
}

public enum AuthStatus: Sendable, Equatable {
  /// Clerk has not finished restoring a keychain session yet.
  case loading
  case signedOut
  case signedIn(userId: String)

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
  private let logger = Logger(subsystem: "com.bhekani.recto", category: "auth")
  private let store: RectoStore
  private let features: AuthFeatures
  private var sync: (any SyncControlling)?
  private var sessions: (any EditSessionCoordinating)?
  private var statusContinuations: [UUID: AsyncStream<AuthStatus>.Continuation] = [:]
  private var eventListener: Task<Void, Never>?

  /// Hand this to `ConvexClientWithAuth(deploymentUrl:authProvider:)`.
  public let convexAuthProvider: ConvexTemplateAuthProvider

  public private(set) var status: AuthStatus = .loading {
    didSet {
      guard status != oldValue else { return }
      for continuation in statusContinuations.values { continuation.yield(status) }
    }
  }

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

    // Cold start: the database on disk may belong to somebody else. `status`
    // begins as `.loading`, so there is no "previous user" to compare against
    // and nothing else would ever notice.
    let restored = Self.activeUserId(of: Clerk.shared.session)
    guard await claimMirror(for: restored) else { return }
    updateStatus(from: Clerk.shared.session)

    eventListener?.cancel()
    eventListener = Task { [weak self] in
      for await event in Clerk.shared.auth.events {
        if Task.isCancelled { break }
        guard let self else { break }
        switch event {
        case .sessionChanged(_, let newSession):
          await self.handleSessionChanged(newSession)
        case .signedOut:
          await self.handleSessionChanged(nil)
        case .accountDeleted:
          await self.handleAccountDeleted()
        default:
          continue
        }
      }
    }
  }

  /// Make sure the mirror belongs to `userId` before anything is published or
  /// started. Returns false when the transition must not proceed.
  private func claimMirror(for userId: String?) async -> Bool {
    do {
      let owner = try await store.mirrorOwner()
      switch (owner, userId) {
      case (let owner?, let userId?) where owner != userId:
        // Somebody else's documents are on this disk. They are not this user's
        // to read, and they are not ours to silently destroy either — but a
        // signed-in session cannot proceed over them.
        logger.error("mirror belongs to another account; purging before publishing the session")
        await sync?.stop()
        try await store.purgeEverything()
        try await store.setMirrorOwner(userId)
      case (nil, let userId?):
        try await store.setMirrorOwner(userId)
      case (let owner?, nil):
        // Signed out with data still on disk: leave it, it belongs to `owner`
        // and they may come back.
        _ = owner
      default:
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

  /// Test seam for the cold-start ownership check, which is otherwise only
  /// reachable through `start()` and therefore through Clerk.
  func claimMirrorForTesting(userId: String?) async throws -> Bool {
    await claimMirror(for: userId)
  }

  /// Test seam for a session Clerk revoked externally.
  func handleSessionRevokedForTesting(previousUserId: String) async {
    status = .signedIn(userId: previousUserId)
    await handleSessionChanged(nil)
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
    await sessions?.freezeAndFlushAll()
    await sync?.stop()

    if !discardingUnsynced {
      let pending = (try? await store.unsyncedWorkCount()) ?? 0
      guard pending == 0 else {
        // Refused: put the app back the way it was.
        await sessions?.resumeAll()
        await sync?.start()
        throw RectoAuthError.unsyncedWork(count: pending)
      }
    }

    do {
      if Self.isClerkConfigured { try await convexAuthProvider.logout() }
    } catch {
      logger.error("clerk sign-out failed: \(error.localizedDescription, privacy: .public)")
      // The text still has to go: a network error must not leave a signed-out
      // user's drafts readable on a shared Mac.
      try await store.purgeEverything()
      try? await store.setMirrorOwner(nil)
      status = .signedOut
      throw error
    }
    try await store.purgeEverything()
    try? await store.setMirrorOwner(nil)
    status = .signedOut
  }

  // MARK: - Private

  private func handleSessionChanged(_ session: Session?) async {
    let previousUserId = status.userId
    let nextUserId = Self.activeUserId(of: session)
    guard previousUserId != nextUserId else { return }

    // Clerk revoked the session out from under us (another device signed out,
    // an admin ended it, the token was refused). We cannot ask for consent, and
    // deleting offline work without it is not ours to do.
    if nextUserId == nil, previousUserId != nil {
      await sessions?.freezeAndFlushAll()
      await sync?.stop()
      let pending = (try? await store.unsyncedWorkCount()) ?? 0
      if pending > 0 {
        // Retained, not deleted, and not readable: the data stays owned by the
        // previous account, so `claimMirror` refuses to open it under anyone
        // else and a later sign-in by the same user recovers it.
        logger.error(
          "session revoked with \(pending) unsynced change(s); retaining them for the previous account"
        )
        status = .signedOut
        emitRetainedWork(count: pending)
        return
      }
      try? await store.purgeEverything()
      try? await store.setMirrorOwner(nil)
      status = .signedOut
      return
    }

    // A different user on the same device must never see the previous one's
    // documents. Stop sync, purge, and only THEN publish the new identity: a
    // consumer that reads the store between those steps would show the old
    // user's text under the new session.
    if previousUserId != nil, nextUserId != previousUserId {
      await sessions?.freezeAndFlushAll()
      await sync?.stop()
      do {
        try await store.purgeEverything()
      } catch {
        // Blocking the transition is the safe failure: leaving the rows in place
        // under a new identity is not.
        logger.error(
          "purge failed during account switch; refusing to publish the new session: \(error.localizedDescription, privacy: .public)"
        )
        status = .signedOut
        return
      }
    }

    guard await claimMirror(for: nextUserId) else { return }
    status = nextUserId.map { AuthStatus.signedIn(userId: $0) } ?? .signedOut
    if nextUserId != nil {
      await sessions?.resumeAll()
      await sync?.start()
    }
  }

  /// Unsynced work that outlived a revoked session. The UI surfaces it on the
  /// next sign-in by the same account.
  public private(set) var retainedUnsyncedWork = 0

  private func emitRetainedWork(count: Int) {
    retainedUnsyncedWork = count
  }

  private func handleAccountDeleted() async {
    await sync?.stop()
    do {
      try await store.purgeEverything()
    } catch {
      logger.error(
        "purge after account deletion failed: \(error.localizedDescription, privacy: .public)")
    }
    status = .signedOut
  }

  private func updateStatus(from session: Session?) {
    status = Self.activeUserId(of: session).map { AuthStatus.signedIn(userId: $0) } ?? .signedOut
  }

  private static func activeUserId(of session: Session?) -> String? {
    guard let session, session.status == .active else { return nil }
    return session.user?.id
  }
}
