import CryptoKit
import Foundation

/// The claims Recto cares about in a Clerk-minted JWT.
///
/// Checking `audience == "convex"` is the whole point of plan 023 §1.6: Convex
/// (`convex/auth.config.ts`, `applicationID: "convex"`) only accepts a token
/// from the Clerk JWT template named `convex`. The default session token has no
/// such audience and Convex rejects it — silently, as a one-second reconnect
/// loop rather than an error (W5's N0a spike), so it is worth asserting.
public struct JWTClaims: Sendable, CustomStringConvertible {
  public let audience: String?
  public let subject: String?
  public let issuer: String?
  public let issuedAt: Date?
  public let expiresAt: Date?
  /// Short hash of the token, so two tokens can be compared in a log without
  /// either one being written down.
  public let fingerprint: String

  public var lifetimeSeconds: Int? {
    guard let issuedAt, let expiresAt else { return nil }
    return Int(expiresAt.timeIntervalSince(issuedAt))
  }

  public func isExpired(now: Date = Date(), leeway: TimeInterval = 0) -> Bool {
    guard let expiresAt else { return false }
    return expiresAt.addingTimeInterval(-leeway) <= now
  }

  public var description: String {
    let expiry = expiresAt.map { "\(Int($0.timeIntervalSinceNow))s" } ?? "?"
    return
      "aud=\(audience ?? "<none>") sub=\(subject ?? "?") iss=\(issuer ?? "?") "
      + "ttl=\(lifetimeSeconds.map(String.init) ?? "?")s expires_in=\(expiry) jwt=\(fingerprint)"
  }

  public init?(token: String) {
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
      SHA256.hash(data: Data(token.utf8))
        .map { byte in
          let hex = String(byte, radix: 16)
          return byte < 16 ? "0" + hex : hex
        }
        .joined()
        .prefix(8))
  }

  private static func decodeBase64URL(_ value: String) -> Data? {
    var base64 =
      value
      .replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
    return Data(base64Encoded: base64)
  }
}
