import ClerkKit
@preconcurrency import ConvexMobile
import Foundation
import Observation

/// Metadata rows returned by `documents:list` (see `convex/documents.ts`).
struct DocumentSummary: Decodable, Identifiable, Equatable {
  let id: String
  let title: String
  let wordCount: Double
  let updatedAt: Double

  enum CodingKeys: String, CodingKey {
    case id = "_id"
    case title, wordCount, updatedAt
  }
}

struct CreatedDocument: Decodable {
  let documentId: String
  let rootNodeId: String
}

/// Everything the spike proves, in one observable object: Clerk sign-in, the
/// Convex auth state, a live `documents:list` subscription, mutations, socket
/// state and token diagnostics.
@MainActor @Observable
final class SpikeModel {
  enum Phase: Equatable {
    case configurationMissing
    case signedOut
    case awaitingCode(email: String)
    case authenticating
    case ready
    case failed(String)
  }

  private(set) var phase: Phase = .signedOut
  private(set) var convexAuthState = "unauthenticated"
  private(set) var socketState = "unknown"
  private(set) var documents: [DocumentSummary] = []
  private(set) var subscriptionUpdates = 0
  private(set) var lastClaims: String = "—"
  private(set) var userLabel: String = "—"

  var email = ""
  var code = ""

  private let provider: ConvexTemplateAuthProvider
  private let client: ConvexClientWithAuth<String>
  private var pendingSignIn: SignIn?
  private var subscriptionTask: Task<Void, Never>?
  private var autoMutationsStarted = false

  init() {
    provider = ConvexTemplateAuthProvider(
      template: SpikeConfig.useDefaultTemplate ? nil : SpikeConfig.convexJWTTemplate)
    client = ConvexClientWithAuth(
      deploymentUrl: SpikeConfig.convexDeploymentURL, authProvider: provider)
    provider.bind(client: client)
  }

  func start() {
    SpikeLog.line("boot", SpikeConfig.summary)
    guard SpikeConfig.isConfigured else {
      phase = .configurationMissing
      SpikeLog.line("boot", "config missing; run scripts/write-local-config.sh and rebuild")
      return
    }

    watchAuthState()
    watchSocketState()
    startTokenPoll()
    startAutoSignIn()
  }

  // MARK: - Clerk sign-in

  func sendEmailCode() async {
    let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !address.isEmpty else { return }
    do {
      SpikeLog.line("clerk", "requesting email code for \(address)")
      pendingSignIn = try await Clerk.shared.auth.signInWithEmailCode(emailAddress: address)
      phase = .awaitingCode(email: address)
    } catch {
      fail("email code request failed", error)
    }
  }

  func verifyCode() async {
    guard let signIn = pendingSignIn else { return }
    let entered = code.trimmingCharacters(in: .whitespacesAndNewlines)
    do {
      phase = .authenticating
      SpikeLog.line("clerk", "verifying code")
      let result = try await signIn.verifyCode(entered)
      SpikeLog.line("clerk", "sign-in status=\(result.status.rawValue)")
      pendingSignIn = nil
      code = ""
    } catch {
      fail("code verification failed", error)
    }
  }

  func signInWithGoogle() async {
    do {
      SpikeLog.line("clerk", "starting Google OAuth")
      _ = try await Clerk.shared.auth.signInWithOAuth(provider: .google)
    } catch {
      fail("Google OAuth failed", error)
    }
  }

  func signOut() async {
    SpikeLog.line("clerk", "signing out")
    subscriptionTask?.cancel()
    subscriptionTask = nil
    documents = []
    await client.logout()
    phase = .signedOut
  }

  // MARK: - Convex

  func createDocument() async {
    let title = "spike \(Date.now.formatted(date: .omitted, time: .standard))"
    do {
      let created: CreatedDocument = try await client.mutation(
        "documents:create", with: ["title": title])
      SpikeLog.line("mutation", "documents:create -> \(created.documentId) \"\(title)\"")
    } catch {
      SpikeLog.line("mutation", "documents:create FAILED \(String(describing: error))")
    }
  }

  func renameNewestDocument() async {
    guard let target = documents.first else {
      SpikeLog.line("mutation", "documents:rename skipped, no documents")
      return
    }
    let title = "renamed \(Date.now.formatted(date: .omitted, time: .standard))"
    do {
      try await client.mutation(
        "documents:rename", with: ["documentId": target.id, "title": title])
      SpikeLog.line("mutation", "documents:rename \(target.id) -> \"\(title)\"")
    } catch {
      SpikeLog.line("mutation", "documents:rename FAILED \(String(describing: error))")
    }
  }

  /// Prints the claims of the current templated token. `aud` is the assertion
  /// that matters (plan 023 §1.6); the fingerprint changing across polls is how
  /// a refresh becomes visible.
  func logTokenClaims() async {
    guard let session = Clerk.shared.session else { return }
    do {
      let template = SpikeConfig.useDefaultTemplate ? nil : SpikeConfig.convexJWTTemplate
      guard let token = try await session.getToken(.init(template: template)) else { return }
      let claims = JWTClaims(token: token)?.description ?? "undecodable"
      lastClaims = claims
      SpikeLog.line("token", claims)
    } catch {
      SpikeLog.line("token", "fetch failed: \(error.localizedDescription)")
    }
  }

  // MARK: - Streams

  private func watchAuthState() {
    Task { [client] in
      for await state in client.authState.values {
        switch state {
        case .loading:
          convexAuthState = "loading"
        case .unauthenticated:
          convexAuthState = "unauthenticated"
          subscriptionTask?.cancel()
          subscriptionTask = nil
          documents = []
          if case .authenticating = phase { phase = .signedOut }
        case .authenticated:
          convexAuthState = "authenticated"
          userLabel = Clerk.shared.user?.primaryEmailAddress?.emailAddress ?? Clerk.shared.user?.id ?? "—"
          phase = .ready
          subscribeToDocuments()
          await logTokenClaims()
          await runAutoMutations()
        }
        SpikeLog.line("convex", "authState=\(convexAuthState)")
      }
    }
  }

  private func watchSocketState() {
    Task { [client] in
      for await state in client.watchWebSocketState().values {
        socketState = String(describing: state)
        SpikeLog.line("socket", socketState)
      }
    }
  }

  private func subscribeToDocuments() {
    guard subscriptionTask == nil else { return }
    subscriptionTask = Task { [client] in
      SpikeLog.line("subscription", "subscribing to documents:list")
      do {
        for try await rows in client.subscribe(to: "documents:list", yielding: [DocumentSummary].self).values {
          documents = rows
          subscriptionUpdates += 1
          let titles = rows.prefix(3).map(\.title).joined(separator: " | ")
          SpikeLog.line(
            "subscription", "update #\(subscriptionUpdates) count=\(rows.count) newest=[\(titles)]")
        }
      } catch {
        SpikeLog.line("subscription", "FAILED \(String(describing: error))")
      }
    }
  }

  // MARK: - Headless driving

  private func startAutoSignIn() {
    guard let address = SpikeConfig.autoEmail, let autoCode = SpikeConfig.autoCode else { return }
    Task {
      // Clerk restores a keychain session asynchronously; only start a fresh
      // sign-in if none turns up.
      for _ in 0..<40 {
        if Clerk.shared.isLoaded { break }
        try? await Task.sleep(for: .milliseconds(250))
      }
      if Clerk.shared.session != nil {
        guard SpikeConfig.forceFreshSignIn else {
          SpikeLog.line("auto", "existing Clerk session restored, skipping sign-in")
          return
        }
        SpikeLog.line("auto", "SPIKE_FRESH=1, discarding the restored session")
        await signOut()
      }
      email = address
      await sendEmailCode()
      code = autoCode
      await verifyCode()
    }
  }

  private func runAutoMutations() async {
    guard !autoMutationsStarted else { return }
    autoMutationsStarted = true
    if SpikeConfig.autoCreate {
      await createDocument()
    }
    guard SpikeConfig.mutateEverySeconds > 0 else { return }
    Task {
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(SpikeConfig.mutateEverySeconds))
        await renameNewestDocument()
      }
    }
  }

  private func startTokenPoll() {
    guard SpikeConfig.tokenPollSeconds > 0 else { return }
    Task {
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(SpikeConfig.tokenPollSeconds))
        await logTokenClaims()
      }
    }
  }

  /// The UI gets the readable message; the log keeps the whole error, because
  /// Clerk's `localizedDescription` drops the API error code.
  private func fail(_ what: String, _ error: Error) {
    SpikeLog.line("error", "\(what): \(String(describing: error))")
    phase = .failed("\(what): \(error.localizedDescription)")
  }
}
