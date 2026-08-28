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
