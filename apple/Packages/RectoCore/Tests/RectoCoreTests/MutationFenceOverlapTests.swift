import RectoStore
import Testing

@testable import RectoCore

private actor OverlapIngress: EditorIngressCoordinating {
  private var freezeCount = 0
  private(set) var resumeCount = 0
  private var secondFreezeWaiters: [CheckedContinuation<Void, Never>] = []
  private var releaseSecondFreeze: CheckedContinuation<Void, Never>?

  func drain() {}

  func freezeAndDrain() async {
    freezeCount += 1
    guard freezeCount == 2 else { return }
    let waiters = secondFreezeWaiters
    secondFreezeWaiters.removeAll()
    for waiter in waiters { waiter.resume() }
    await withCheckedContinuation { releaseSecondFreeze = $0 }
  }

  func resume() { resumeCount += 1 }
  func invalidate() {}

  func waitUntilSecondFreezeStarts() async {
    guard freezeCount < 2 else { return }
    await withCheckedContinuation { secondFreezeWaiters.append($0) }
  }

  func release() {
    releaseSecondFreeze?.resume()
    releaseSecondFreeze = nil
  }
}

@Suite("overlapping local-mutation freezes")
struct MutationFenceOverlapTests {
  @Test("an older resume cannot release a newer freeze")
  func staleResumeAfterNewerFreeze() async throws {
    let store = try RectoStore.inMemory()
    let registry = DocumentSessionRegistry(store: store, sync: nil, origin: "mac")
    let library = DocumentLibrary(store: store, sync: nil, origin: "mac")
    let ingress = OverlapIngress()
    _ = try await registry.registerIngress(for: "gate", ingress)

    let olderFreeze = await registry.freezeAndFlushAll()
    let newerFreeze = Task { await registry.freezeAndFlushAll() }
    await ingress.waitUntilSecondFreezeStarts()

    #expect(await registry.resumeAll(after: olderFreeze) == false)
    #expect(await registry.isFrozenForTesting)
    #expect(await ingress.resumeCount == 0)
    await #expect(throws: StoreError.localMutationsFrozen) {
      _ = try await library.createDocument(title: "must stay fenced")
    }

    await ingress.release()
    _ = await newerFreeze.value
  }
}
