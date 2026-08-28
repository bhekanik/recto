# Recto Swift packages

Local SwiftPM packages for the native macOS and iOS apps (plan 023). Each is a
root package with its own `Package.swift`, so `swift test --package-path
apple/Packages/<name>` works on any of them. Floors are macOS 26 / iOS 26,
arm64, Swift 6 language mode (D-N9).

| Package | Depends on | What it is |
|---|---|---|
| `RectoHistory` | — | Swift ports of `lib/history/{patch,materialize,ulid,grouping,diff}.ts` and `lib/stats/streak.ts`, with parity fixtures generated from the web code |
| `RectoStore` | GRDB, `RectoHistory` | The SQLite mirror and the outbox |
| `RectoAuth` | clerk-ios, convex-swift, `RectoStore` | Clerk session lifecycle and the `convex`-template `AuthProvider` |
| `RectoSync` | convex-swift, `RectoStore`, `RectoAuth`, `RectoHistory` | The Convex transport, the conflict rules, and the outbox drain |
| `RectoCore` | all of the above | `DocumentSession` — what the app talks to |
| `RectoEditor` | (W9) | TextKit 2 editor engine |

`RectoSync` also vends `RectoSyncTesting`, an in-memory reimplementation of the
Convex functions with fault injection. Depend on it from test targets only.

---

## `DocumentSession` — the API for the Mac app (W12)

One actor per open document. Get it from `DocumentSessionRegistry`, never by
constructing it: two sessions on one document would each hold a grouping
controller seeded at the same head and fork the tree on every keystroke. The
registry is what makes "the same document in two windows" (orchestration §0)
safe.

```swift
let store = try RectoStore(url: RectoStore.defaultURL())
let origin = try await SyncEngine.resolveOrigin(store: store)     // per-device id
let auth = RectoAuth(store: store)                                 // @MainActor
RectoAuth.configureClerk(publishableKey: key)                      // once, in App.init
await auth.start()

let transport = await ConvexTransport(
  deploymentURL: convexURL, authProvider: auth.convexAuthProvider)
let sync = SyncEngine(store: store, transport: transport, origin: origin)
await sync.start()

let registry = DocumentSessionRegistry(
  store: store, sync: sync, origin: origin, countWords: RectoCoreJS.countWords)
```

### Per window

```swift
let session = try await registry.session(for: documentLocalId)   // opens it
for await state in await session.states { render(state) }        // markdown, head, syncState, divergence
…
await registry.release(documentLocalId)                          // flushes when the last window goes
```

### Editing

| Call | What it does |
|---|---|
| `applyLocalChange(markdown:selection:structural:)` | Feed canonical Markdown after every change. Grouping decides whether a node closes. Pass `structural: true` for a paste, a block change or a mode switch. |
| `tickIdle()` | The 500 ms idle boundary. Called for you unless `schedulesTimers: false`. |
| `undo()` / `redo()` | Pointer moves. `redo` takes the most recently created child (vim's rule, and the web's). Return `false` at the ends. |
| `navigate(to:)` | Jump anywhere in the DAG. Flushes the pending draft first so you branch from a real node. |
| `selection(at:)` | The caret stored on a node, to restore after a navigation. |
| `flush()` | Commit the pending draft and push the queue. Call on background, window close, scene disconnect and mode switch. |
| `resolveDivergenceKeepingLocal()` / `…KeepingRemote()` | The two non-manual outcomes of the compare sheet. Neither deletes anything. |

`DocumentState` carries `markdown`, `head`, `wordCount`, `syncState`,
`divergence`, `canUndo`, `canRedo`. Render from it; do not read the store
directly.

**Word counting is injected.** `RectoWordCount.plainText` is a stand-in that
over-counts Markdown syntax. Pass W8's `countWords` (the Swift port of
`lib/markdown`) when it lands — the number is persisted and sent to the server.

---

## The outbox contract

Every mutation goes through `outbox`, ordered by `id` **per document**, and the
drain sends **one job at a time and retries the head of the queue until the
server answers**.

That is not caution, it is required by the server. `documents.commitEdit`
remembers exactly one `clientMutationId` per document (`documents.lastCommit`),
so only the most recent commit is replay-safe. A queue that pipelined commits
and later replayed an older one — whose node landed but whose head has since
advanced — would be told `diverged` instead of getting its original answer.

- **Idempotency key**: a ULID, minted once when the job is enqueued and reused
  on every retry. Never regenerate it.
- **Failure**: `attempts` increments, `lastError` is recorded, `nextAttemptAt`
  is `now + 2^(attempts-1)` seconds (capped at 5 minutes, ±20% jitter). Jobs
  behind a failing one do not overtake it.
- **Auth**: an error mentioning authentication triggers `loginFromCache()`
  before the backoff. Clerk's `convex` token lives 60 seconds, so a long drain
  outliving one is normal.
- **A commit's node is never lost.** `commitEdit` inserts the node row whatever
  the head check says, so a divergence costs you the pointer, never the text.

The drain runs only after `SyncEngine.start()`. `requestDrain()` on a stopped
engine records that work is waiting and returns; `drainNow()` drains
synchronously (tests and `flush()`).

---

## Conflict states (plan 023 §4.4)

`DocumentRecord.syncState` is one of `synced`, `pending`, `syncing`, `diverged`,
`failed`. `ConflictResolver.resolve` is pure and unit-tested; the engine applies
its answer:

| Resolution | Meaning | What the engine does |
|---|---|---|
| `inSync` | heads agree | marks `synced` |
| `uploadAncestors(missing:rebaseOnto:)` | the server is behind us | leaves the outbox to catch it up |
| `adoptRemote(headNodeId:whenIdle:)` | someone built on our work | adopts when idle, keeping the caret; defers while there is pending local work |
| `diverged(local:remote:)` | neither head reaches the other | keeps **both** branches, sets `divergedRemoteHeadNodeId`, emits `.diverged` |
| `awaitingNodes(remoteHeadNodeId:)` | their head is not in our DAG yet | pulls `docNodes.listSince` and decides again |

On `diverged`, `DocumentState.divergence` gives you `localHeadNodeId`,
`remoteHeadNodeId` and the nearest common ancestor as `baseNodeId` — the three
inputs a three-way compare needs. **The compare sheet itself is not built here**
(W12/W13). Nothing resolves automatically: picking a winner silently is the
failure this design exists to avoid.

---

## What is still owed by the backend

| Needed | Owner | Until then |
|---|---|---|
| `settings` table + `settings.get/save` | W7 | `RectoStore.settings` is local-only; rows carry `dirty` for the sync that will exist |
| `workspaces` keyed by `(userId, deviceId)` | W7 | `window_state` is local-only |
| `documents.create` accepting a client `documentUuid` | W7 | An offline-created document adopts the server's root node id on first sync (`SyncEngine.adoptServerRoot`). Correct, but a `documentUuid` would make it unnecessary. |
| `updateMarkdown` head CAS | W1/W7 | Draft saves use the existing `expectedUpdatedAt` CAS; a stale answer is dropped, which loses nothing because the next commit carries the text. |
| `account.deleteEverything` | W7 | Sign-out purges the local mirror only. |
| Swift `countWords` / `parseOutline` | W8 | `RectoWordCount.plainText` (see above). |

---

## Tests

```
swift test --package-path apple/Packages/RectoHistory   # 35 — web parity
swift test --package-path apple/Packages/RectoStore     # 15
swift test --package-path apple/Packages/RectoAuth      #  8
swift test --package-path apple/Packages/RectoSync      # 17
swift test --package-path apple/Packages/RectoCore      # 15 — incl. the N4 acceptance list
```

The `RectoHistory` expectations are generated by running the actual web code:

```
bun run apple/tools/generate-history-fixtures.ts
```

CI reruns it and fails on a diff, so a change to `lib/` that nobody propagated
breaks the build instead of leaving the Swift suite passing against stale
answers. The generator is deterministic (node ids are rewritten to a stable
sequence).

Live tests against a real Convex deployment are opt-in and skip themselves with
a message otherwise:

```
RECTO_CONVEX_URL=https://<deployment>.convex.cloud \
RECTO_CLERK_PUBLISHABLE_KEY=pk_test_… \
swift test --package-path apple/Packages/RectoCore --filter LiveConvex
```

They sign in with Clerk's `+clerk_test` address and the fixed `424242` code, so
no `CLERK_SECRET_KEY` and no mailbox are needed. Documents they create are
titled `native-spike-…` and deleted by the test.
