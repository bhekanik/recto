import RectoStore
import Testing

@testable import RectoCore

private actor FreezeGateIngress: EditorIngressCoordinating {
  private let blockedFreeze: Int
  private var freezeCount = 0
  private(set) var resumeCount = 0
  private var freezeWaiters: [CheckedContinuation<Void, Never>] = []
  private var releaseFreeze: CheckedContinuation<Void, Never>?

  init(blockedFreeze: Int) {
    self.blockedFreeze = blockedFreeze
  }

  func drain() {}

  func freezeAndDrain() async {
    freezeCount += 1
    guard freezeCount == blockedFreeze else { return }
    let waiters = freezeWaiters
    freezeWaiters.removeAll()
    for waiter in waiters { waiter.resume() }
    await withCheckedContinuation { releaseFreeze = $0 }
  }

  func resume() { resumeCount += 1 }
  func invalidate() {}

  func waitUntilFreezeStarts() async {
    guard freezeCount < blockedFreeze else { return }
    await withCheckedContinuation { freezeWaiters.append($0) }
  }

  func release() {
    releaseFreeze?.resume()
    releaseFreeze = nil
  }
}

private actor ResumeGateIngress: EditorIngressCoordinating {
  private var resumeCount = 0
  private var resumeWaiters: [CheckedContinuation<Void, Never>] = []
  private var releaseResume: CheckedContinuation<Void, Never>?

  func drain() {}
  func freezeAndDrain() {}

  func resume() async {
    resumeCount += 1
    guard resumeCount == 1 else { return }
    let waiters = resumeWaiters
    resumeWaiters.removeAll()
    for waiter in waiters { waiter.resume() }
    await withCheckedContinuation { releaseResume = $0 }
  }

  func invalidate() {}

  func waitUntilResumeStarts() async {
    guard releaseResume == nil else { return }
    await withCheckedContinuation { resumeWaiters.append($0) }
  }

  func release() {
    releaseResume?.resume()
    releaseResume = nil
  }
}

private actor SecondPassGate {
  private var passCount = 0
  private var waiters: [CheckedContinuation<Void, Never>] = []
  private var releasePass: CheckedContinuation<Void, Never>?

  func enter() async {
    passCount += 1
    guard passCount == 2 else { return }
    let currentWaiters = waiters
    waiters.removeAll()
    for waiter in currentWaiters { waiter.resume() }
    await withCheckedContinuation { releasePass = $0 }
  }

  func waitUntilSecondPassStarts() async {
    guard passCount < 2 else { return }
    await withCheckedContinuation { waiters.append($0) }
  }

  func release() {
    releasePass?.resume()
    releasePass = nil
  }
}

@Suite("overlapping local-mutation freezes")
struct MutationFenceOverlapTests {
  @Test("a stale resume before queued freeze ownership only opens a counted gap")
  func staleResumeBeforeQueuedFreezeEstablishesOwnership() async throws {
    let store = try RectoStore.inMemory()
    let passGate = SecondPassGate()
    let registry = DocumentSessionRegistry(
      store: store,
      sync: nil,
      origin: "mac",
      beforeFreezePass: { await passGate.enter() },
      beforeSessionResume: { _ in })
    let library = DocumentLibrary(store: store, sync: nil, origin: "mac")
    let ingress = FreezeGateIngress(blockedFreeze: 1)
    _ = try await registry.registerIngress(for: "gate", ingress)

    let olderFreeze = Task { await registry.freezeAndFlushAll() }
    await ingress.waitUntilFreezeStarts()
    let newerFreeze = Task { await registry.freezeAndFlushAll() }
    while await registry.freezePassWaiterCountForTesting == 0 { await Task.yield() }
    await ingress.release()
    await passGate.waitUntilSecondPassStarts()

    let olderToken = await olderFreeze.value
    #expect(await registry.resumeAll(after: olderToken))
    let gapDocument = try await library.createDocument(title: "Counted gap mutation")
    #expect(try await store.pendingJobs(documentLocalId: gapDocument.localId).isEmpty == false)

    await passGate.release()
    let newerToken = await newerFreeze.value
    await #expect(throws: StoreError.localMutationsFrozen) {
      _ = try await library.createDocument(title: "must stay fenced")
    }
    #expect(await registry.resumeAll(after: newerToken))
  }

  @Test("an older resume cannot release a newer freeze")
  func staleResumeAfterNewerFreeze() async throws {
    let store = try RectoStore.inMemory()
    let registry = DocumentSessionRegistry(store: store, sync: nil, origin: "mac")
    let library = DocumentLibrary(store: store, sync: nil, origin: "mac")
    let ingress = FreezeGateIngress(blockedFreeze: 2)
    _ = try await registry.registerIngress(for: "gate", ingress)

    let olderFreeze = await registry.freezeAndFlushAll()
    let newerFreeze = Task { await registry.freezeAndFlushAll() }
    await ingress.waitUntilFreezeStarts()

    #expect(await registry.resumeAll(after: olderFreeze) == false)
    #expect(await registry.isFrozenForTesting)
    #expect(await ingress.resumeCount == 0)
    await #expect(throws: StoreError.localMutationsFrozen) {
      _ = try await library.createDocument(title: "must stay fenced")
    }

    await ingress.release()
    _ = await newerFreeze.value
  }

  @Test("a newer freeze waits for an older pass before it can resume real sessions")
  func staleFreezeCompletionCannotRefreezeResumedSession() async throws {
    let store = try RectoStore.inMemory()
    let registry = DocumentSessionRegistry(store: store, sync: nil, origin: "mac")
    let library = DocumentLibrary(store: store, sync: nil, origin: "mac")
    let document = try await library.createDocument(title: "Race")
    let session = try await registry.session(for: document.localId)
    let ingress = FreezeGateIngress(blockedFreeze: 1)
    let ingressId = try await registry.registerIngress(for: "gate", ingress)

    let olderFreeze = Task { await registry.freezeAndFlushAll() }
    await ingress.waitUntilFreezeStarts()
    await registry.unregisterIngress(ingressId)
    let newerFreeze = Task { await registry.freezeAndFlushAll() }
    while await registry.freezePassWaiterCountForTesting == 0 { await Task.yield() }

    await ingress.release()
    let olderToken = await olderFreeze.value
    let newerToken = await newerFreeze.value
    #expect(await registry.resumeAll(after: newerToken))
    #expect(await registry.resumeAll(after: olderToken) == false)

    try await session.applyLocalChange(markdown: "still editable", selection: nil)
    #expect(try await store.document(localId: document.localId)?.draftMarkdown == "still editable")
    await registry.release(document.localId)
  }

  @Test("a freeze waits for removed reentrant ingress work")
  func removedReentrantIngressStillFinishesBeforeFreezeReturns() async throws {
    let store = try RectoStore.inMemory()
    let registry = DocumentSessionRegistry(store: store, sync: nil, origin: "mac")
    let firstIngress = FreezeGateIngress(blockedFreeze: 1)
    let firstId = try await registry.registerIngress(for: "first", firstIngress)

    let freeze = Task { await registry.freezeAndFlushAll() }
    await firstIngress.waitUntilFreezeStarts()
    let replacement = FreezeGateIngress(blockedFreeze: 1)
    let registration = Task { try await registry.registerIngress(for: "replacement", replacement) }
    await replacement.waitUntilFreezeStarts()
    await registry.unregisterIngress(firstId)
    await firstIngress.release()
    while await registry.freezeWorkCountForTesting != 1 { await Task.yield() }

    await replacement.release()
    let replacementId = try await registration.value
    let token = await freeze.value
    #expect(await registry.resumeAll(after: token))
    #expect(await replacement.resumeCount == 1)
    await registry.unregisterIngress(replacementId)
  }

  @Test("sessions opened during overlapping freezes resume with the newest owner")
  func reentrantSessionOpensResumeWithNewestFreeze() async throws {
    let store = try RectoStore.inMemory()
    let registry = DocumentSessionRegistry(store: store, sync: nil, origin: "mac")
    let library = DocumentLibrary(store: store, sync: nil, origin: "mac")
    var documentIds: [String] = []
    for index in 0..<8 {
      documentIds.append(try await library.createDocument(title: "Document \(index)").localId)
    }
    let ingress = FreezeGateIngress(blockedFreeze: 1)
    _ = try await registry.registerIngress(for: "gate", ingress)

    let olderFreeze = Task { await registry.freezeAndFlushAll() }
    await ingress.waitUntilFreezeStarts()
    let sessions = documentIds.map { documentId in
      Task { try await registry.session(for: documentId) }
    }
    let newerFreeze = Task { await registry.freezeAndFlushAll() }
    while await registry.freezePassWaiterCountForTesting == 0 { await Task.yield() }
    await ingress.release()

    var openedSessions: [DocumentSession] = []
    for session in sessions { openedSessions.append(try await session.value) }
    let olderToken = await olderFreeze.value
    let newerToken = await newerFreeze.value
    #expect(await registry.resumeAll(after: newerToken))
    #expect(await registry.resumeAll(after: olderToken) == false)
    for (index, session) in openedSessions.enumerated() {
      try await session.applyLocalChange(markdown: "edit \(index)", selection: nil)
      #expect(try await store.document(localId: documentIds[index])?.draftMarkdown == "edit \(index)")
      await registry.release(documentIds[index])
    }
  }

  @Test("a session opened during ingress resume is included in convergence")
  func sessionOpenedDuringIngressResumeIsResumed() async throws {
    let store = try RectoStore.inMemory()
    let registry = DocumentSessionRegistry(store: store, sync: nil, origin: "mac")
    let library = DocumentLibrary(store: store, sync: nil, origin: "mac")
    let document = try await library.createDocument(title: "Late session")
    let ingress = ResumeGateIngress()
    _ = try await registry.registerIngress(for: "gate", ingress)
    let token = await registry.freezeAndFlushAll()

    let resume = Task { await registry.resumeAll(after: token) }
    await ingress.waitUntilResumeStarts()
    let session = try await registry.session(for: document.localId)
    await ingress.release()

    #expect(await resume.value)
    try await session.applyLocalChange(markdown: "accepted", selection: nil)
    #expect(try await store.document(localId: document.localId)?.draftMarkdown == "accepted")
    await registry.release(document.localId)
  }
}
