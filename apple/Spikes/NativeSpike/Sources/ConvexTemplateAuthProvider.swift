import ClerkKit
@preconcurrency import ConvexMobile
import Foundation

/// Bridges Clerk to Convex, minting the token from a named Clerk JWT template.
///
/// This is `clerk-convex-swift` 0.1.0's `ClerkConvexAuthProvider` with the one
/// change Recto needs: `session.getToken()` there takes no options, so it
/// returns the **default** session token, whose `aud` is the Clerk instance —
/// not `convex`. `convex/auth.config.ts` sets `applicationID: "convex"`, so
/// Convex rejects that token and every query resolves as unauthenticated. Here
/// the token always comes from `GetTokenOptions(template: "convex")`.
///
/// The second change is the refresh path. Clerk's `.tokenRefreshed` event
/// carries a bare JWT with no indication of which template minted it (see
/// `SessionTokenFetcher.fetchToken`, which fires it for whichever token last
/// changed), so forwarding the event payload straight to Convex — what the
/// stock provider does — can push a default-template token onto a templated
/// session. The event is treated as a signal only: it triggers a fresh
/// templated fetch, and only that token is pushed.
@MainActor
final class ConvexTemplateAuthProvider: AuthProvider {
  typealias T = String

  /// `nil` reproduces the stock provider's behaviour, for the negative test.
  private let template: String?
  private var onIdToken: (@Sendable (String?) -> Void)?
  private var refreshListener: Task<Void, Never>?
  private var sessionListener: Task<Void, Never>?
  private var lastPushedFingerprint: String?
  private var syncedSessionID: String?
  private weak var client: ConvexClientWithAuth<String>?

  init(template: String?) {
    self.template = template
  }

  /// Mirrors `ClerkConvexAuthProvider.bind`: Convex has no idea that Clerk
  /// restored a session from the keychain, so the session stream has to drive
  /// `loginFromCache()` / `logout()` on the client.
  func bind(client: ConvexClientWithAuth<String>) {
    self.client = client
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

  func login(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> String {
    try await authenticate(onIdToken: onIdToken, reason: "login")
  }

  func loginFromCache(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> String {
    try await authenticate(onIdToken: onIdToken, reason: "loginFromCache")
  }

  /// Must not throw when there is nothing to sign out of.
  /// `ConvexClientWithAuth.logout()` runs `authProvider.logout()` first and
  /// abandons the rest of the teardown — clearing the auth bridge, dropping the
  /// FFI auth callback, publishing `.unauthenticated` — the moment it throws,
  /// so a session that has already ended would leave Convex holding a dead
  /// token.
  func logout() async throws {
    refreshListener?.cancel()
    refreshListener = nil
    onIdToken = nil
    lastPushedFingerprint = nil
    guard Clerk.shared.session != nil else { return }
    try await Clerk.shared.auth.signOut()
  }

  nonisolated func extractIdToken(from authResult: String) -> String { authResult }

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
    guard Clerk.shared.isLoaded else { throw SpikeAuthError.clerkNotLoaded }
    guard let session = Clerk.shared.session, session.status == .active else {
      throw SpikeAuthError.noActiveSession
    }
    guard let token = try await session.getToken(.init(template: template)) else {
      throw SpikeAuthError.noToken
    }
    let claims = JWTClaims(token: token)?.description ?? "undecodable"
    SpikeLog.line(
      "auth", "token via \(reason) template=\(template ?? "<default>") \(claims)")
    return token
  }

  /// Clerk emits `.tokenRefreshed` for any template whose token changed, so the
  /// payload is deliberately ignored and a templated token is fetched instead.
  /// The fetch is cache-first, so it only hits the network when the templated
  /// token really did expire, which also stops the event/fetch loop.
  private func startRefreshListener() {
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
      SpikeLog.line("auth", "refresh failed: \(error.localizedDescription)")
      onIdToken(nil)
    }
  }

  /// `.sessionChanged` also fires for in-place session updates, so only real
  /// transitions are forwarded to Convex.
  private func syncSession(_ session: Session?) async {
    guard let client else { return }
    let activeID = (session?.status == .active) ? session?.id : nil
    guard activeID != syncedSessionID else { return }

    syncedSessionID = activeID
    if activeID != nil {
      SpikeLog.line("auth", "clerk session became active; logging Convex in from cache")
      _ = await client.loginFromCache()
    } else {
      SpikeLog.line("auth", "clerk session ended; logging Convex out")
      await client.logout()
    }
  }
}

enum SpikeAuthError: LocalizedError {
  case clerkNotLoaded
  case noActiveSession
  case noToken

  var errorDescription: String? {
    switch self {
    case .clerkNotLoaded: "Clerk has not finished loading."
    case .noActiveSession: "No active Clerk session."
    case .noToken: "Clerk returned no JWT for the requested template."
    }
  }
}
