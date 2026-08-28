import ClerkKit
@preconcurrency import ConvexMobile
import Foundation
import OSLog

/// The Clerk JWT template Convex trusts (`convex/auth.config.ts`).
public let convexJWTTemplate = "convex"

public enum RectoAuthError: LocalizedError, Equatable {
  case clerkNotLoaded
  case noActiveSession
  case noToken
  case wrongAudience(String?)
  case featureDisabled(String)
  case unsyncedWork(count: Int)

  public var errorDescription: String? {
    switch self {
    case .clerkNotLoaded: "Clerk has not finished loading."
    case .noActiveSession: "No active Clerk session."
    case .noToken: "Clerk returned no JWT for the \"\(convexJWTTemplate)\" template."
    case .wrongAudience(let audience):
      "Clerk minted a token with audience \(audience ?? "<none>"); Convex requires \"convex\"."
    case .featureDisabled(let name): "\(name) is not enabled on this Clerk instance yet."
    case .unsyncedWork(let count):
      "\(count) change\(count == 1 ? "" : "s") have not reached the server yet. "
        + "Signing out would delete them."
    }
  }
}

/// Bridges Clerk to Convex, minting the token from the named Clerk JWT template.
///
/// This is `clerk-convex-swift` 0.1.0's `ClerkConvexAuthProvider` with the two
/// changes Recto needs, both established by the N0a spike (PR #4):
///
///  1. `session.getToken()` there takes no options and returns the **default**
///     session token, whose audience is the Clerk instance, not `convex`. Convex
///     rejects it and every query resolves unauthenticated — as a silent
///     one-second reconnect loop, not an error. Here the token always comes from
///     `GetTokenOptions(template: "convex")`.
///  2. Clerk's `.tokenRefreshed` event carries a bare JWT with no indication of
///     which template minted it (`SessionTokenFetcher` fires it for whichever
///     token last changed), so forwarding the payload can push a default-template
///     token onto a templated session. The event is treated as a signal only: it
///     triggers a fresh, cache-first templated fetch, and only that token is
///     pushed — which also stops the event/fetch loop from running away.
/// The single owner of every `login` / `logout` on the Convex client.
///
/// convex-swift replaces its `authBridge` and the FFI auth callback on each
/// login, and neither replacement is synchronized (get-convex/convex-swift #21,
/// #26). Overlapping calls corrupt the bridge — we saw it as an
/// `EXC_ARM_DA_ALIGN` inside a concurrency job. Foreground resume, auth-error
/// recovery, bind-time session login and explicit sign-out all reach the client
/// through here, so no two can ever be in flight.
///
/// An actor rather than a Boolean on the provider: a flag only serializes the
/// calls that happen to check it, and the calls come from three different
/// isolation domains.
public actor ConvexAuthCoordinator {
  public static let shared = ConvexAuthCoordinator()

  private var inFlight: Task<Void, Never>?

  init() {}

  /// Run `body` after any auth call already in flight has finished.
  public func perform(_ body: @escaping @Sendable () async -> Void) async {
    await perform { () -> Bool in
      await body()
      return true
    }
  }

  /// The same, for a call whose answer the caller needs. Recording a login as
  /// successful without looking at its result is how one transient failure used
  /// to become a permanently unauthenticated client.
  @discardableResult
  public func perform<T: Sendable>(_ body: @escaping @Sendable () async -> T) async -> T {
    let previous = inFlight
    let task = Task { () -> T in
      await previous?.value
      return await body()
    }
    inFlight = Task { _ = await task.value }
    return await task.value
  }
}

@MainActor
public final class ConvexTemplateAuthProvider: AuthProvider {
  public typealias T = String

  private let logger = Logger(subsystem: "com.bhekani.recto", category: "auth")
  private let template: String
  /// The Clerk session Convex is currently logged in for. Written only after a
  /// login has actually succeeded.
  private var syncedSessionID: String?
  private weak var client: ConvexClientWithAuth<String>?

  /// Which Clerk session is active. A seam so the identity state machine can be
  /// tested without a configured Clerk SDK — `Clerk.shared` calls `fatalError`
  /// when it was never configured.
  var activeSessionID: @MainActor @Sendable () -> String? = {
    guard RectoAuth.isClerkConfigured, let session = Clerk.shared.session,
      session.status == .active
    else { return nil }
    return session.id
  }
  /// Overrides for the two effects on the Convex client, for the same reason.
  var cachedLogin: (@MainActor @Sendable () async -> Bool)?
  var convexLogout: (@MainActor @Sendable () async -> Void)?

  public init(template: String = convexJWTTemplate) {
    self.template = template
  }

  /// Hand the provider the client it authenticates, and bring Convex in line
  /// with whatever session Clerk restored from the keychain.
  ///
  /// A ONE-SHOT, not a listener. This used to follow `Clerk.shared.auth.events`
  /// itself, and `RectoAuth` follows the same stream: Clerk broadcasts to both
  /// with no ordering between them, so on an A-to-B switch this side could reach
  /// `loginFromCache()` — replacing the FFI auth bridge and its callback — while
  /// A's subscriptions were still running and still writing into A's mirror.
  /// Every transition after this one is `RectoAuth`'s, which freezes editing,
  /// stops and awaits the sockets, and settles ownership first.
  ///
  /// Safe here because the transport is still being constructed: no socket
  /// exists yet.
  public func bind(client: ConvexClientWithAuth<String>) async {
    self.client = client
    await syncActiveSession()
  }

  public func login(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> String {
    try await authenticate(onIdToken: onIdToken, reason: "login")
  }

  public func loginFromCache(onIdToken: @Sendable @escaping (String?) -> Void) async throws
    -> String
  {
    try await authenticate(onIdToken: onIdToken, reason: "loginFromCache")
  }

  /// Must not throw when there is nothing to sign out of.
  ///
  /// `ConvexClientWithAuth.logout()` runs `authProvider.logout()` first and
  /// abandons the rest of the teardown — clearing the auth bridge, dropping the
  /// FFI auth callback, publishing `.unauthenticated` — the moment it throws. A
  /// session that had already ended would otherwise leave Convex holding a dead
  /// token.
  public func logout() async throws {
    syncedSessionID = nil
    guard RectoAuth.isClerkConfigured, Clerk.shared.session != nil else { return }
    try await Clerk.shared.auth.signOut()
  }

  public nonisolated func extractIdToken(from authResult: String) -> String { authResult }

  // MARK: - Private

  private func authenticate(
    onIdToken: @Sendable @escaping (String?) -> Void, reason: String
  ) async throws -> String {
    // The push path is deliberately NOT wired. `onIdToken` is invoked from a
    // task the SDK owns, so it can replace the auth bridge while a login is in
    // flight and nothing we write can serialize it (#21/#26). The pull path
    // alone keeps a session authenticated — N0a measured 14 minutes across ~20
    // token rotations on it — at the cost of one extra fetch when a token
    // actually expires.
    _ = onIdToken
    return try await fetchToken(reason: reason)
  }

  private func fetchToken(reason: String) async throws -> String {
    guard RectoAuth.isClerkConfigured else { throw RectoAuthError.clerkNotLoaded }
    guard Clerk.shared.isLoaded else { throw RectoAuthError.clerkNotLoaded }
    guard let session = Clerk.shared.session, session.status == .active else {
      throw RectoAuthError.noActiveSession
    }
    guard let token = try await session.getToken(.init(template: template)) else {
      throw RectoAuthError.noToken
    }
    let claims = JWTClaims(token: token)
    guard claims?.audience == template else {
      // Fail loudly here rather than let Convex fail silently: a JWT template
      // that has been renamed or deleted in the dashboard reads as "the app
      // just never loads" otherwise.
      throw RectoAuthError.wrongAudience(claims?.audience)
    }
    logger.debug("token via \(reason, privacy: .public): \(claims?.description ?? "", privacy: .public)")
    return token
  }

  /// Bring the Convex client's identity in line with Clerk's current session.
  ///
  /// Call ONLY from `RectoAuth`, and only with every socket stopped: a login
  /// replaces the auth bridge and the FFI callback, and neither replacement is
  /// synchronized (convex-swift #21/#26).
  ///
  /// Returns whether Convex now holds the identity Clerk has.
  @discardableResult
  public func syncActiveSession() async -> Bool {
    let activeID = activeSessionID()
    guard activeID != syncedSessionID else { return true }

    guard let activeID else {
      logger.info("clerk session ended; logging Convex out")
      await runConvexLogout()
      syncedSessionID = nil
      return true
    }

    logger.info("clerk session became active; logging Convex in from cache")
    guard await runCachedLogin() else {
      // Deliberately record NOTHING. Writing the id first and ignoring the
      // result meant one transient token or network failure left Convex
      // unauthenticated while every later attempt for the same session returned
      // early. A user with no queued work never reaches auth-error recovery, so
      // their documents simply never arrived until the process restarted.
      logger.error("cached Convex login failed; leaving the session unsynced for a retry")
      syncedSessionID = nil
      return false
    }
    syncedSessionID = activeID
    return true
  }

  /// Clerk has an active session that Convex is not logged in for — the state a
  /// failed `syncActiveSession()` leaves behind, and what a reconnect or a
  /// foreground resume checks.
  public var needsCachedLogin: Bool {
    guard let activeID = activeSessionID() else { return false }
    return activeID != syncedSessionID
  }

  private func runCachedLogin() async -> Bool {
    if let cachedLogin { return await cachedLogin() }
    guard let client else { return false }
    return await ConvexAuthCoordinator.shared.perform { () -> Bool in
      if case .success = await client.loginFromCache() { return true }
      return false
    }
  }

  private func runConvexLogout() async {
    if let convexLogout {
      await convexLogout()
      return
    }
    guard let client else { return }
    await ConvexAuthCoordinator.shared.perform { await client.logout() }
  }

  /// Log the Convex client out through the SDK, which is the only path that
  /// clears the FFI auth callback. Signing out through Clerk alone leaves the
  /// client holding a dead bridge.
  public func logoutConvexClient() async {
    syncedSessionID = nil
    await runConvexLogout()
  }
}
