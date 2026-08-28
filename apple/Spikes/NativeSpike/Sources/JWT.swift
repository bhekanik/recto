import CryptoKit
import Foundation

/// The claims the spike cares about. Verifying `aud == "convex"` is the whole
/// point of plan 023 §1.6: Convex only accepts tokens minted by the Clerk JWT
/// template named `convex`, and the default session token is not one of them.
struct JWTClaims: CustomStringConvertible {
  let audience: String?
  let subject: String?
  let issuer: String?
  let issuedAt: Date?
  let expiresAt: Date?
  /// Short hash of the whole token, so two tokens can be compared in logs
  /// without either one being written down.
  let fingerprint: String

  var lifetimeSeconds: Int? {
    guard let issuedAt, let expiresAt else { return nil }
    return Int(expiresAt.timeIntervalSince(issuedAt))
  }

  var description: String {
    let expiry = expiresAt.map { String(format: "%+.0fs", $0.timeIntervalSinceNow) } ?? "?"
    return "aud=\(audience ?? "<none>") sub=\(subject ?? "?") iss=\(issuer ?? "?") ttl=\(lifetimeSeconds.map(String.init) ?? "?")s expires_in=\(expiry) jwt=\(fingerprint)"
  }

  init?(token: String) {
    let parts = token.split(separator: ".")
    guard parts.count == 3, let payload = Self.decodeBase64URL(String(parts[1])),
      let json = try? JSONSerialization.jsonObject(with: payload) as? [String: Any]
    else { return nil }

    audience = json["aud"] as? String
    subject = json["sub"] as? String
    issuer = json["iss"] as? String
    issuedAt = (json["iat"] as? Double).map(Date.init(timeIntervalSince1970:))
    expiresAt = (json["exp"] as? Double).map(Date.init(timeIntervalSince1970:))
    fingerprint = String(
      SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined().prefix(8))
  }

  private static func decodeBase64URL(_ value: String) -> Data? {
    var base64 = value.replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
    return Data(base64Encoded: base64)
  }
}
