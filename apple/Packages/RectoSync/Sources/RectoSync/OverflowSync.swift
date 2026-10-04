import Foundation
import RectoStore

/// Independent of the prose outbox: one scratchpad conflict cannot hold writing sync.
public actor OverflowSync {
  private let store: RectoStore
  private let api: any RectoAPI
  private var task: Task<Void, Never>?
  private var epoch = 0
  private var openDocuments: Set<String> = []
  private var subscriptions: [String: Task<Void, Never>] = [:]
  public private(set) var lastError: String?

  public init(store: RectoStore, api: any RectoAPI) {
    self.store = store
    self.api = api
  }

  public func start() {
    guard task == nil else { return }
    epoch += 1
    let owner = epoch
    for localId in openDocuments { subscribe(localId: localId, owner: owner) }
    task = Task { [weak self] in
      while !Task.isCancelled {
        await self?.syncOnce(owner: owner)
        try? await Task.sleep(for: .seconds(3))
      }
    }
  }

  public func stop() async {
    epoch += 1
    let pending = Array(subscriptions.values) + [task].compactMap { $0 }
    task = nil
    subscriptions.removeAll()
    for task in pending { task.cancel() }
    for task in pending { await task.value }
  }

  public func openDocument(localId: String) {
    openDocuments.insert(localId)
    if task != nil { subscribe(localId: localId, owner: epoch) }
  }

  public func closeDocument(localId: String) async {
    openDocuments.remove(localId)
    let subscription = subscriptions.removeValue(forKey: localId)
    subscription?.cancel()
    await subscription?.value
  }

  private struct Remote: Decodable, Sendable {
    let markdown: String
    let revision: Int
  }

  private func subscribe(localId: String, owner: Int) {
    guard subscriptions[localId] == nil else { return }
    subscriptions[localId] = Task { [weak self] in await self?.receiveOpenDocument(localId: localId, owner: owner) }
  }

  private func receiveOpenDocument(localId: String, owner: Int) async {
    while owner == epoch, !Task.isCancelled {
      do {
        if let document = try await store.document(localId: localId), let id = document.convexId {
          let stream: AsyncThrowingStream<Remote, any Error> = await api.subscribe("overflow:get", args: ["documentId": .string(id)])
          for try await remote in stream {
            guard owner == epoch, !Task.isCancelled else { return }
            try await store.receiveOverflow(localId: localId, markdown: remote.markdown, revision: remote.revision)
          }
        }
      } catch {
        guard owner == epoch, !Task.isCancelled else { return }
        try? await store.setOverflowSyncError(localId: localId, message: error.localizedDescription)
      }
      try? await Task.sleep(for: .seconds(3))
    }
  }

  public func syncOnce() async { await syncOnce(owner: epoch) }

  private struct Reply: Decodable, Sendable {
    let saved: Bool
    let revision: Int
    let markdown: String?
  }

  private func syncOnce(owner: Int) async {
    do {
      let documents = try await store.documentsWithUnsyncedOverflow()
      for document in documents {
        guard owner == epoch, !Task.isCancelled else { return }
        guard document.deletedAt == nil, let id = document.convexId else { continue }
        do {
          if let mutation = try await store.prepareOverflowMutation(localId: document.localId) {
            let reply: Reply = try await api.mutation("overflow:save", args: [
              "documentId": .string(id), "markdown": .string(mutation.markdown),
              "expectedRevision": .number(Double(mutation.expectedRevision)),
              "clientMutationId": .string(mutation.id),
            ])
            guard owner == epoch, !Task.isCancelled else { return }
            if reply.saved {
              // Leave the immutable request pending until this read succeeds, so a lost
              // recheck retries identically. Store merges observations and receipt atomically.
              let latest: Remote = try await api.query("overflow:get", args: ["documentId": .string(id)])
              guard owner == epoch, !Task.isCancelled else { return }
              try await store.acknowledgeOverflow(localId: document.localId, mutation: mutation, revision: reply.revision, latestMarkdown: latest.markdown, latestRevision: latest.revision)
            } else if let markdown = reply.markdown {
              try await store.receiveOverflow(localId: document.localId, markdown: markdown, revision: reply.revision, rejectedMutation: mutation.id)
            } else {
              throw RemoteCallError(code: nil, message: "Overflow returned an incomplete conflict. Your notes are saved on this Mac.")
            }
          }
          try await store.setOverflowSyncError(localId: document.localId, message: nil)
          lastError = nil
        } catch {
          // Persisted requests survive offline errors and lost replies for identical retry.
          guard owner == epoch, !Task.isCancelled else { return }
          try? await store.setOverflowSyncError(localId: document.localId, message: error.localizedDescription)
          lastError = error.localizedDescription
        }
      }
    } catch { lastError = error.localizedDescription }
  }
}
