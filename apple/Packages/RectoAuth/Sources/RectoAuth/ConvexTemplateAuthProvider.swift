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
@MainActor
public final class ConvexTemplateAuthProvider: AuthProvider {
  public typealias T = String

  private let logger = Logger(subsystem: "com.bhekani.recto", category: "auth")
  private let template: String
  private var onIdToken: (@Sendable (String?) -> Void)?
  private var refreshListener: Task<Void, Never>?
  private var sessionListener: Task<Void, Never>?
  private var lastPushedFingerprint: String?
  private var syncedSessionID: String?
  /// A `loginFromCache` / `logout` is already in flight on the Convex client.
  ///
  /// convex-swift issues #21/#26: the FFI auth bridge is not safe against
  /// concurrent logins, and overlapping them crashes with a misaligned access
  /// inside the Rust callback. Our own startup calls `loginFromCache()` on the
  /// transport at the same moment Clerk's `.sessionChanged` fires here, so the
  /// two really do overlap unless they are serialized.
  private var clientAuthInFlight = false
  private var pendingSessionID: String??
  private weak var client: ConvexClientWithAuth<String>?

  public init(template: String = convexJWTTemplate) {
    self.template = template
  }

  deinit {
    refreshListener?.cancel()
    sessionListener?.cancel()
  }

  /// Convex has no idea that Clerk restored a session from the keychain, so the
  /// session stream has to drive `loginFromCache()` / `logout()` on the client.
  public func bind(client: ConvexClientWithAuth<String>) {
    self.client = client
    // `Clerk.shared` calls `fatalError` when the SDK was never configured, and
    // constructing the transport reaches this immediately — so a debug build, a
    // widget or a test that never called `configureClerk` would crash here
    // rather than simply having no session.
    guard RectoAuth.isClerkConfigured else { return }
    sessionListener?.cancel()
    sessionListener = Task { [weak self] in
      await self?.syncSession(Clerk.shared.session)
      for await event in Clerk.shared.auth.events {
        if Task.isCancelled { break }
        if case .sessionChanged(_, let newSession) = event {
          await self?.syncSession(newSession)
        }
      }
    }
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
    refreshListener?.cancel()
    refreshListener = nil
    onIdToken = nil
    lastPushedFingerprint = nil
    syncedSessionID = nil
    guard RectoAuth.isClerkConfigured, Clerk.shared.session != nil else { return }
    try await Clerk.shared.auth.signOut()
  }

  public nonisolated func extractIdToken(from authResult: String) -> String { authResult }

  // MARK: - Private

  private func authenticate(
    onIdToken: @Sendable @escaping (String?) -> Void, reason: String
  ) async throws -> String {
    self.onIdToken = onIdToken
    let token = try await fetchToken(reason: reason)
    lastPushedFingerprint = JWTClaims(token: token)?.fingerprint
    startRefreshListener()
    return token
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

  /// Clerk emits `.tokenRefreshed` for any template whose token changed, so the
  /// payload is deliberately ignored and a templated token is fetched instead.
  /// The fetch is cache-first, so it only hits the network when the templated
  /// token really did expire.
  private func startRefreshListener() {
    guard RectoAuth.isClerkConfigured else { return }
    refreshListener?.cancel()
    refreshListener = Task { [weak self] in
      for await event in Clerk.shared.auth.events {
        if Task.isCancelled { break }
        guard case .tokenRefreshed = event else { continue }
        await self?.pushFreshToken()
      }
    }
  }

  private func pushFreshToken() async {
    guard let onIdToken else { return }
    do {
      let token = try await fetchToken(reason: "refresh")
      let fingerprint = JWTClaims(token: token)?.fingerprint
      guard fingerprint != lastPushedFingerprint else { return }
      lastPushedFingerprint = fingerprint
      onIdToken(token)
    } catch {
      logger.error("token refresh failed: \(error.localizedDescription, privacy: .public)")
      onIdToken(nil)
    }
  }

  /// `.sessionChanged` also fires for in-place session updates, so only real
  /// transitions are forwarded to Convex.
  private func syncSession(_ session: Session?) async {
    guard let client else { return }
    let activeID = (session?.status == .active) ? session?.id : nil
    guard activeID != syncedSessionID else { return }

    // Coalesce rather than overlap: remember the newest target and let the
    // in-flight call pick it up when it finishes.
    guard !clientAuthInFlight else {
      pendingSessionID = .some(activeID)
      return
    }

    clientAuthInFlight = true
    defer { clientAuthInFlight = false }

    var target = activeID
    while true {
      syncedSessionID = target
      if target != nil {
        logger.info("clerk session became active; logging Convex in from cache")
        _ = await client.loginFromCache()
      } else {
        logger.info("clerk session ended; logging Convex out")
        await client.logout()
      }
      guard let queued = pendingSessionID else { return }
      pendingSessionID = nil
      guard queued != syncedSessionID else { return }
      target = queued
    }
  }
}
