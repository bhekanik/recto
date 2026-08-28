import Foundation
import RectoHistory
import RectoStore
import RectoSync
import RectoSyncTesting
import Testing

@testable import RectoCore

/// `documents.markdownHeadNodeId` is the server's statement about which node its
/// stored body belongs to. Getting this wrong in either direction loses text:
/// ignoring a trustworthy stamp hides another device's draft, and trusting an
/// absent or mismatched one promotes some other branch's text into the head.
///
/// The scenario names mirror the web's (X2/Y1/Y2) so the two suites can be read
/// against each other.
@Suite("server draft provenance")
struct ProvenanceTests {
  private func harness() throws -> (Harness, URL) {
    let directory = Harness.makeDirectory()
    return (try Harness(directory: directory, transport: InMemoryTransport()), directory)
  }

  @Test("X2: a stamped server draft ahead of the head is shown, not discarded")
  func stampedDraftIsAdopted() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-x2")
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")

    // Another device saved text ahead of the head; the server stamped it.
    try await server.writeServerDraft(
      documentId: seeded.documentId, markdown: "text device A had not committed",
      stampedHeadNodeId: seeded.rootNodeId)

    try await mac.sync.mirrorLibrary(await server.summaries())
    let localId = try #require(try await mac.store.documents().first?.localId)

    let session = DocumentSession(
      documentLocalId: localId, store: mac.store, sync: nil, origin: "mac",
      schedulesTimers: false)
    try await session.open()

    // The head materializes to "" — the draft is the text the user must see.
    #expect(await session.currentState?.markdown == "text device A had not committed")
    #expect(try await mac.store.document(localId: localId)?.markdown == "")
  }

  @Test("Y1: an UNSTAMPED server body is never treated as the head's text")
  func unstampedBodyIsUntrusted() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-y1")
    let node = try await server.commitFromOtherClient(
      documentId: seeded.documentId, parentNodeId: seeded.rootNodeId, markdown: "committed text")
    // A legacy client wrote the body with no head CAS, which CLEARS the stamp.
    try await server.writeServerDraft(
      documentId: seeded.documentId, markdown: "unstamped mystery text",
      stampedHeadNodeId: nil)

    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    try await mac.sync.mirrorLibrary(await server.summaries())
    let localId = try #require(try await mac.store.documents().first?.localId)

    let document = try #require(try await mac.store.document(localId: localId))
    // The DAG wins: the head is what `committed text` materializes to.
    #expect(document.localHeadNodeId == node)
    #expect(document.markdown == "committed text")
    #expect(document.draftMarkdown == nil, "untrusted text is not carried as a draft either")

    let session = DocumentSession(
      documentLocalId: localId, store: mac.store, sync: nil, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    #expect(await session.currentState?.markdown == "committed text")
  }

  @Test("Y2: a body stamped for ANOTHER branch is not promoted into this head")
  func mismatchedStampIsIgnored() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-y2")
    let node = try await server.commitFromOtherClient(
      documentId: seeded.documentId, parentNodeId: seeded.rootNodeId, markdown: "current branch")
    // Stamped with the ROOT while the head is `node`: this text belongs to a
    // branch that is no longer current.
    try await server.writeServerDraft(
      documentId: seeded.documentId, markdown: "text from the old branch",
      stampedHeadNodeId: seeded.rootNodeId)

    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    try await mac.sync.mirrorLibrary(await server.summaries())
    let localId = try #require(try await mac.store.documents().first?.localId)

    let document = try #require(try await mac.store.document(localId: localId))
    #expect(document.localHeadNodeId == node)
    #expect(document.markdown == "current branch")
    #expect(document.draftMarkdown == nil)
  }

  @Test("a same-head update on a document we already have fetches the body")
  func sameHeadUpdateFetchesBody() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-samehead")
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")

    try await mac.sync.mirrorLibrary(await server.summaries())
    let localId = try #require(try await mac.store.documents().first?.localId)
    #expect(try await mac.store.document(localId: localId)?.draftMarkdown == nil)

    // Another device saves ahead of the SAME head. `documents.list` carries no
    // body, so only a fetch reveals it — bumping `updatedAt` and moving on is
    // how it stayed invisible forever.
    try await server.writeServerDraft(
      documentId: seeded.documentId, markdown: "typed on the iPad",
      stampedHeadNodeId: seeded.rootNodeId)
    try await mac.sync.mirrorLibrary(await server.summaries())

    #expect(try await mac.store.document(localId: localId)?.draftMarkdown == "typed on the iPad")
  }

  @Test("a local draft is never replaced by the server's copy")
  func localDraftWins() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-localdraft")
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    try await mac.sync.mirrorLibrary(await server.summaries())
    let localId = try #require(try await mac.store.documents().first?.localId)

    try await mac.store.saveDraft(
      documentLocalId: localId, markdown: "what I am typing right now", selection: nil,
      wordCount: 6, job: nil)
    try await server.writeServerDraft(
      documentId: seeded.documentId, markdown: "what the other device typed",
      stampedHeadNodeId: seeded.rootNodeId)

    try await mac.sync.mirrorLibrary(await server.summaries())
    #expect(
      try await mac.store.document(localId: localId)?.draftMarkdown
        == "what I am typing right now")
  }
}
