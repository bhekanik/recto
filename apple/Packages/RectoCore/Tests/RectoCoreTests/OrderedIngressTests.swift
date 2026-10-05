import Foundation
import RectoHistory
import RectoStore
import RectoSync
import Testing
@testable import RectoCore

@Suite("ordered ingress history")
struct OrderedIngressTests {
  @Test("delayed structural callbacks cannot cross navigation or an away-and-back epoch", arguments: [false, true])
  func delayedNavigation(returnsToOriginalHead: Bool) async throws {
    let store = try RectoStore.inMemory()
    let library = DocumentLibrary(store: store, sync: nil, origin: "test")
    let document = try await library.createDocument(title: "Navigation")
    let session = DocumentSession(documentLocalId: document.localId, store: store, sync: nil, origin: "test", schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "B", selection: nil, structural: true)
    let otherHead = try #require(await session.currentState).head
    try await session.navigate(to: document.localHeadNodeId)
    let old = try store.saveEditorIngressSynchronously(documentLocalId: document.localId, markdown: "old structural A", selection: nil, wordCount: 3, clientMutationId: ulid(), draftPayload: "{}")
    try await session.navigate(to: otherHead)
    if returnsToOriginalHead { try await session.navigate(to: document.localHeadNodeId) }
    let targetHead = returnsToOriginalHead ? document.localHeadNodeId : otherHead
    let fresh = returnsToOriginalHead ? "fresh root typing" : "B with fresh typing"
    let revision = try store.saveEditorIngressSynchronously(documentLocalId: document.localId, markdown: fresh, selection: nil, wordCount: 4, clientMutationId: ulid(), draftPayload: "{}")
    let nodes = try await store.nodes(documentLocalId: document.localId).count
    try await session.applyPersistedLocalChange(markdown: "old structural A", selection: nil, structural: true, generation: old, preserveAcceptedOrder: true)
    #expect(try await store.document(localId: document.localId)?.displayMarkdown == fresh)
    #expect(try await store.document(localId: document.localId)?.localHeadNodeId == targetHead)
    #expect(try await store.nodes(documentLocalId: document.localId).count == nodes)
    try await session.applyPersistedLocalChange(markdown: fresh, selection: nil, structural: true, generation: revision, preserveAcceptedOrder: true)
    #expect(await session.currentState?.markdown == fresh)
    let committed = try #require(try await store.document(localId: document.localId))
    #expect(committed.localHeadNodeId != targetHead)
    #expect(try await store.node(documentLocalId: document.localId, nodeId: committed.localHeadNodeId)?.parentNodeId == targetHead)
    let count = try await store.nodes(documentLocalId: document.localId).count
    try await session.applyPersistedLocalChange(markdown: "old structural A", selection: nil, structural: true, generation: old, preserveAcceptedOrder: true)
    #expect(try await store.nodes(documentLocalId: document.localId).count == count)
    #expect(try await store.document(localId: document.localId)?.displayMarkdown == fresh)
  }

  @Test("external Store head moves invalidate delayed callbacks even after an ABA", arguments: [false, true])
  func externalNavigation(returnsToOriginalHead: Bool) async throws {
    let store = try RectoStore.inMemory()
    let library = DocumentLibrary(store: store, sync: nil, origin: "test")
    let document = try await library.createDocument(title: "External navigation")
    let session = DocumentSession(documentLocalId: document.localId, store: store, sync: nil, origin: "test", schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "B", selection: nil, structural: true)
    let otherHead = try #require(await session.currentState).head
    try await session.navigate(to: document.localHeadNodeId)
    let old = try store.saveEditorIngressSynchronously(documentLocalId: document.localId, markdown: "old A", selection: nil, wordCount: 2, clientMutationId: ulid(), draftPayload: "{}")
    _ = try await store.moveHead(documentLocalId: document.localId, to: otherHead, markdown: "B", wordCount: 1, expectedHeadNodeId: document.localHeadNodeId, job: nil)
    if returnsToOriginalHead {
      _ = try await store.moveHead(documentLocalId: document.localId, to: document.localHeadNodeId, markdown: "", wordCount: 0, expectedHeadNodeId: otherHead, job: nil)
    }
    let target = returnsToOriginalHead ? document.localHeadNodeId : otherHead
    let fresh = try store.saveEditorIngressSynchronously(documentLocalId: document.localId, markdown: "fresh on target", selection: nil, wordCount: 3, clientMutationId: ulid(), draftPayload: "fresh")
    let count = try await store.nodes(documentLocalId: document.localId).count
    try await session.applyPersistedLocalChange(markdown: "old A", selection: nil, structural: true, generation: old, preserveAcceptedOrder: true)
    #expect(try await store.document(localId: document.localId)?.displayMarkdown == "fresh on target")
    #expect(try await store.document(localId: document.localId)?.localHeadNodeId == target)
    #expect(try await store.nodes(documentLocalId: document.localId).count == count)
    try await session.applyPersistedLocalChange(markdown: "fresh on target", selection: nil, structural: true, generation: fresh, preserveAcceptedOrder: true)
    let head = try #require(try await store.document(localId: document.localId)).localHeadNodeId
    #expect(try await store.node(documentLocalId: document.localId, nodeId: head)?.parentNodeId == target)
    #expect(await session.currentState?.markdown == "fresh on target")
  }

  @Test("acknowledged A-B-A ingress keeps both intermediate structural boundaries")
  func acknowledgedABA() async throws {
    let store = try RectoStore.inMemory()
    let library = DocumentLibrary(store: store, sync: nil, origin: "test")
    let document = try await library.createDocument(title: "ABA")
    let session = DocumentSession(documentLocalId: document.localId, store: store, sync: nil, origin: "test", schedulesTimers: false)
    try await session.open()
    let texts = ["A", "B", "A"]
    let receipts = texts.map { _ in UUID() }
    let generations = try zip(texts, receipts).map { text, receipt in
      try store.saveEditorIngressSynchronously(documentLocalId: document.localId, markdown: text, selection: nil, wordCount: 1, clientMutationId: ulid(), draftPayload: text, orderedReceipt: receipt)
    }
    try await store.acknowledgeEditorIngress(documentLocalId: document.localId, markdown: "A", title: document.title)
    for index in texts.indices {
      try await session.applyPersistedLocalChange(markdown: texts[index], selection: nil, structural: true, generation: generations[index], preserveAcceptedOrder: true)
      try store.completeOrderedEditorReceipt(documentLocalId: document.localId, receipt: receipts[index])
      #expect(try await store.document(localId: document.localId)?.displayMarkdown == "A")
      if index < texts.count - 1 {
        #expect(try await store.document(localId: document.localId)?.editorIngressRevision != nil)
      }
    }
    try await session.flush()
    #expect(try await store.document(localId: document.localId)?.editorIngressRevision == nil)
    #expect(try await session.undo())
    #expect(await session.currentState?.markdown == "B")
    #expect(try await session.undo())
    #expect(await session.currentState?.markdown == "A")
    #expect(try await session.redo())
    #expect(await session.currentState?.markdown == "B")
    #expect(try await session.redo())
    #expect(await session.currentState?.markdown == "A")
  }

  @Test("acknowledging a clean revert cannot clear the buffer ahead of accepted history")
  func acknowledgedCleanRevert() async throws {
    let store = try RectoStore.inMemory()
    let library = DocumentLibrary(store: store, sync: nil, origin: "test")
    let document = try await library.createDocument(title: "Revert")
    let session = DocumentSession(documentLocalId: document.localId, store: store, sync: nil, origin: "test", schedulesTimers: false)
    try await session.open()
    let firstReceipt = UUID(), lastReceipt = UUID()
    let first = try store.saveEditorIngressSynchronously(documentLocalId: document.localId, markdown: "structural A", selection: nil, wordCount: 2, clientMutationId: ulid(), draftPayload: "{}", orderedReceipt: firstReceipt)
    let last = try store.saveEditorIngressSynchronously(documentLocalId: document.localId, markdown: "", selection: nil, wordCount: 0, clientMutationId: ulid(), draftPayload: "{}", orderedReceipt: lastReceipt)
    try await store.acknowledgeEditorIngress(documentLocalId: document.localId, markdown: "", title: document.title)
    #expect(try await store.document(localId: document.localId)?.editorIngressRevision != nil)
    try await session.applyPersistedLocalChange(markdown: "structural A", selection: nil, structural: true, generation: first, preserveAcceptedOrder: true)
    try store.completeOrderedEditorReceipt(documentLocalId: document.localId, receipt: firstReceipt)
    #expect(try await store.document(localId: document.localId)?.displayMarkdown == "", "latest clean buffer survives an intermediate history commit")
    #expect(try await store.document(localId: document.localId)?.editorIngressRevision != nil)
    try await session.applyPersistedLocalChange(markdown: "", selection: nil, generation: last, preserveAcceptedOrder: true)
    try store.completeOrderedEditorReceipt(documentLocalId: document.localId, receipt: lastReceipt)
    try await session.flush()
    #expect(await session.currentState?.markdown == "")
    #expect(try await session.undo())
    #expect(await session.currentState?.markdown == "structural A")
    #expect(try await session.redo())
    #expect(await session.currentState?.markdown == "")
  }
}
