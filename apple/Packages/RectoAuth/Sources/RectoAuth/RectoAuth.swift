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
    let signIn = try await Clerk.shared.auth.signInWithEmailCode(emailAddress: emailAddress)
    return EmailCodeChallenge(signIn: signIn, emailAddress: emailAddress)
  }

  /// Google via the native redirect. clerk-ios defaults the OAuth redirect to
  /// `{bundleIdentifier}://callback`, so `com.bhekani.recto://callback` must be
  /// registered on the Clerk instance and as a URL type in the app.
  public func signInWithGoogle() async throws {
    _ = try await Clerk.shared.auth.signInWithOAuth(provider: .google)
  }

  public func signInWithApple() async throws {
    guard features.appleSignIn else { throw RectoAuthError.featureDisabled("Sign in with Apple") }
    _ = try await Clerk.shared.auth.signInWithApple()
  }

  public func signInWithPasskey() async throws {
    guard features.passkeys else { throw RectoAuthError.featureDisabled("Passkeys") }
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
  /// are the user's ONLY copy — offline commits are not re-derivable from
  /// Convex, whatever the old comment here claimed — and signing out on a train
  /// would delete them silently. The caller must either flush first or pass
  /// `discardingUnsynced: true` as an explicit, user-visible decision.
  public func signOut(discardingUnsynced: Bool = false) async throws {
    if !discardingUnsynced {
      let pending = try await store.unsyncedWorkCount()
      guard pending == 0 else { throw RectoAuthError.unsyncedWork(count: pending) }
    }

    // Stop sync before purging, or a subscription tick can re-insert rows behind
    // the delete.
    await sync?.stop()
    do {
      if Self.isClerkConfigured { try await convexAuthProvider.logout() }
    } catch {
      logger.error("clerk sign-out failed: \(error.localizedDescription, privacy: .public)")
      // The text still has to go: a network error must not leave a signed-out
      // user's drafts readable on a shared Mac.
      try await store.purgeEverything()
      status = .signedOut
      throw error
    }
    try await store.purgeEverything()
    status = .signedOut
  }

  // MARK: - Private

  private func handleSessionChanged(_ session: Session?) async {
    let previousUserId = status.userId
    let nextUserId = Self.activeUserId(of: session)
    guard previousUserId != nextUserId else { return }

    // A different user on the same device must never see the previous one's
    // documents. Stop sync, purge, and only THEN publish the new identity: a
    // consumer that reads the store between those steps would show the old
    // user's text under the new session.
    if previousUserId != nil, nextUserId != previousUserId {
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

    status = nextUserId.map { AuthStatus.signedIn(userId: $0) } ?? .signedOut
    if nextUserId != nil { await sync?.start() }
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
