import Foundation

/// Build- and launch-time configuration.
///
/// The Clerk publishable key and the Convex deployment URL come from
/// `Info.plist`, which substitutes them from `Config/Local.xcconfig` at build
/// time, so neither value is in the source tree.
enum SpikeConfig {
  /// The Clerk JWT template Convex trusts. `convex/auth.config.ts` sets
  /// `applicationID: "convex"`, which Convex checks against the token's `aud`
  /// claim, and only the template of that name mints a token with that `aud`.
  static let convexJWTTemplate = "convex"

  static let clerkPublishableKey = plistString("RectoClerkPublishableKey")
  static let convexDeploymentURL = plistString("RectoConvexDeploymentURL")

  /// Non-empty when the app is driven headlessly for evidence capture.
  static let autoEmail = env("SPIKE_EMAIL")
  static let autoCode = env("SPIKE_CODE")

  /// Opt out of the JWT template to show what the stock
  /// `ClerkConvexAuthProvider` does: Convex then sees a token with the wrong
  /// `aud` and every query comes back unauthenticated.
  static let useDefaultTemplate = env("SPIKE_DEFAULT_TEMPLATE") == "1"

  /// Create a document shortly after sign-in (headless mutation evidence).
  static let autoCreate = env("SPIKE_CREATE") == "1"

  /// Discard any keychain session at launch, so the run exercises a full
  /// sign-in rather than session restore.
  static let forceFreshSignIn = env("SPIKE_FRESH") == "1"

  /// Seconds between token diagnostics; 0 disables. Clerk session tokens have a
  /// 60s TTL, so a value below that shows the refresh.
  static let tokenPollSeconds = Int(env("SPIKE_TOKEN_POLL") ?? "") ?? 0

  /// Rename the newest document every N seconds to prove mutations still
  /// authenticate after the first token has expired. 0 disables.
  static let mutateEverySeconds = Int(env("SPIKE_MUTATE_EVERY") ?? "") ?? 0

  static var isConfigured: Bool {
    !clerkPublishableKey.hasPrefix("MISSING_") && !convexDeploymentURL.hasPrefix("MISSING_")
  }

  static var summary: String {
    "clerk=\(redact(clerkPublishableKey)) convex=\(convexDeploymentURL) template=\(useDefaultTemplate ? "<default>" : convexJWTTemplate)"
  }

  private static func env(_ key: String) -> String? {
    guard let value = ProcessInfo.processInfo.environment[key], !value.isEmpty else { return nil }
    return value
  }

  private static func plistString(_ key: String) -> String {
    (Bundle.main.object(forInfoDictionaryKey: key) as? String) ?? "MISSING_\(key)"
  }

  /// Keys and tokens are never printed in full: logs end up in PR bodies.
  static func redact(_ value: String) -> String {
    guard value.count > 12 else { return "…" }
    return value.prefix(12) + "…(\(value.count) chars)"
  }
}
