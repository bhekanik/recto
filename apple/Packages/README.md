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

Every one of these is **serialized**: actor isolation does not prevent
reentrancy, so a navigation that suspends while materializing would otherwise be
overtaken by the other window's keystroke and strand its commit. The edit path is
also **write-ahead** — the incoming text is persisted as a draft *before* any
in-memory state moves, grouping is staged in a copy, and the staged controller is
installed only once every store write for it has succeeded. A failed write
rebuilds from the persisted head plus draft rather than leaving a controller
pointing at a node SQLite rejected.

A draft that was persisted but never reached a node boundary is restored by
`open()` (`GroupingController.restorePendingDraft`), so the text the user last
typed is what a relaunched window shows — not the head it was typed on top of.
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
- **One drain, one in-flight job.** Every request joins the single owned drain
  task; `drainNow()` waits for it rather than starting a second. Two loops would
  each read the same head job, and the server remembers a single
  `clientMutationId`, so the slower duplicate comes back as a false divergence.
- **Round-robin across documents.** At most one head job per document per pass,
  repeated while any document makes progress; FIFO within a document. A document
  under continuous editing cannot starve the others.
- **The backoff survives a relaunch.** `start()`, `resume()` and every completed
  drain schedule one wake for the persisted `earliestNextAttempt()`.
- **Job kinds.** `commitEdit` sends node + head together; `appendNode` sends the
  node ALONE through `docNodes.append` — what a commit becomes when its branch
  loses a divergence, so the text is preserved without contesting the pointer.
  `pointerMove` sends its **event** timestamp, not the retry time, and reconciles
  when the server answers `applied: false`. `draftSave` sends
  `expectedHeadNodeId`; a `headMoved` answer is reconciled, never retried.

Nothing reaches the network until `SyncEngine.start()`. `requestDrain()` and
`openDocument(_:)` on a stopped engine record the intent and return — `start()`
then opens the library subscription, the node subscription for every open
document, and the drain loop. `drainNow()` drains synchronously (tests and
`flush()`). `stop()` drops every socket but keeps the open-document set and the
outbox, so `resume()` (foreground, network change, reconnect) brings the same
documents back up.

---

## Conflict states (plan 023 §4.4)

`DocumentRecord.syncState` is one of `synced`, `pending`, `syncing`, `diverged`,
`failed`. `ConflictResolver.resolve` is pure and unit-tested; the engine applies
its answer:

| Resolution | Meaning | What the engine does |
|---|---|---|
| `inSync` | heads agree | marks `synced` |
| `uploadAncestors(missing:rebaseOnto:)` | the server is behind us | leaves the outbox to catch it up |
| `adoptRemote(headNodeId:whenIdle:)` | someone built on our work | adopts when idle, keeping the caret; defers while there is pending local work. The adopt itself is a CAS inside one transaction (`RectoStore.adoptRemoteHead`) on the observed head plus "still no draft and no queued job", because materializing the target suspends and a keystroke can land in that gap |
| `diverged(local:remote:)` | neither head reaches the other | keeps **both** branches, sets `divergedRemoteHeadNodeId`, emits `.diverged` |
| `awaitingNodes(remoteHeadNodeId:)` | their head is not in our DAG yet | pulls the branch with `docNodes.listSince` and re-resolves once — it does **not** wait for the subscription to deliver it, because a Convex subscription that hit a server error never returns |

`resolveDivergenceKeepingRemote()` runs as one store transaction: pointer and
draft jobs for the discarded branch are deleted, its commits are rewritten to
`appendNode` so the text still uploads without moving the pointer, and the
divergence is cleared only once that rewrite has succeeded. Without it the next
drain simply recreates the divergence.

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
| `documents.create` accepting a client `documentUuid` | W7 | An offline-created document records the server id first, then finishes the whole root re-key in one transaction (`RectoStore.finishOfflineCreate`), and a retry resumes a partial adoption instead of acknowledging it. Correct, but a real idempotency key would close the remaining window between the server insert and that transaction. |
| `account.deleteEverything` | W7 | Sign-out purges the local mirror only. |
| Swift `countWords` / `parseOutline` | W8 | `RectoWordCount.plainText` (see above). |

---

## Sign-out and account switches

`signOut()` **refuses** by default while the outbox or a draft row holds text,
throwing `RectoAuthError.unsyncedWork(count:)`. Offline commits are not
re-derivable from Convex — they are the user's only copy — so signing out on a
train would delete them silently. Ask first with `unsyncedWork()`, then either
flush or call `signOut(discardingUnsynced: true)` as an explicit, user-visible
decision. Sync is stopped before the purge either way, or a subscription tick
re-inserts rows behind the delete.

An account switch stops sync, purges, and only **then** publishes the new
`signedIn` status — a consumer reading the store in between would show the
previous user's documents under the new session. A purge failure blocks the
transition rather than leaking the rows.

Wire the two together with `RectoAuth.attach(sync:)`; `SyncEngine` conforms to
`SyncControlling`.

---

## Tests

```
swift test --package-path apple/Packages/RectoHistory   # 37 — web parity
swift test --package-path apple/Packages/RectoStore     # 24
swift test --package-path apple/Packages/RectoAuth      # 12
swift test --package-path apple/Packages/RectoSync      # 32 — incl. server-contract + live flows
swift test --package-path apple/Packages/RectoCore      # 24 — incl. the N4 acceptance list
```

SwiftPM has served a **stale cross-package module** here more than once: editing
`RectoSync` and then running `swift test --package-path apple/Packages/RectoCore`
can execute the previous build of the dependency and produce failures that
contradict the source. If a result makes no sense, `rm -rf
apple/Packages/<name>/.build` before believing it.

The `RectoHistory` expectations are generated by running the actual web code:

```
bun run apple/tools/generate-history-fixtures.ts
```

CI reruns it and fails on a diff, so a change to `lib/` that nobody propagated
breaks the build instead of leaving the Swift suite passing against stale
answers. The generator is deterministic (node ids are rewritten to a stable
sequence).

Live tests against a real Convex deployment are gated by a `.enabled(if:)`
trait, so a plain `swift test` reports them as *skipped* (with the reason) and
stays green:

```
RECTO_CONVEX_URL=https://<deployment>.convex.cloud \
RECTO_CLERK_PUBLISHABLE_KEY=pk_test_… \
swift test --package-path apple/Packages/RectoCore --filter LiveConvex
```

They sign in with Clerk's `+clerk_test` address and the fixed `424242` code, so
no `CLERK_SECRET_KEY` and no mailbox are needed. Documents they create are
titled `native-spike-…` and deleted by the test.
