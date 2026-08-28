# Recto — Data Model

> Part of the Recto blueprint. Canonical contract lives in [`README.md`](./README.md) §7; this file is the full expansion. If anything here contradicts the README, the README wins.

This document specifies the **Convex data model** for the v1 core: the four v1 tables, their exact field names and validators, their indexes, the query/mutation function surface, the append-only delta-encoded history strategy, the platform limits we design within, the retention/pruning policy, and the access patterns that keep reads cheap. It is self-contained for that core — the four v1 tables and their function modules can be implemented from this file alone. Post-v1 plans later added five more tables to `convex/schema.ts`; those are specified in their owning plan docs, not here (see §1.1).

Sibling references:
- [`02-architecture.md`](./02-architecture.md) — where these tables sit in the canonical-model spine and the client/server split.
- [`07-undo-tree.md`](./07-undo-tree.md) — the semantics of the `docNodes` DAG (branching undo, grouping, navigation).
- [`08-version-control.md`](./08-version-control.md) — the semantics of `versions` (tags, additive restore, diff/compare).
- [`09-documents-workspace-split.md`](./09-documents-workspace-split.md) — what `workspaces.paneTree` / `perPaneViewState` encode.
- [`10-sync-persistence.md`](./10-sync-persistence.md) — *when* and *how* these mutations are called (debounce, hydration, concurrency).

Authoritative external references:
- Convex limits: <https://docs.convex.dev/production/state/limits>
- Convex schemas: <https://docs.convex.dev/database/schemas>

---

## 1. Overview — the four v1 tables and how they relate

Recto's v1 core is four application tables plus the Better-Auth-managed `users` table (D12); post-v1 plans added five more (§1.1). The canonical document at rest is a **Markdown string** (D1); everything else exists to support history, tagging, and "resume where I left off."

| Table | Purpose | Cardinality |
|-------|---------|-------------|
| `users` | Identity, provided/managed by Better Auth. Not defined by us. | the single user |
| `documents` | One row per piece of writing. Holds the canonical `markdown`, `title`, `wordCount`, and the `currentNodeId` pointer into the undo tree. | `users` 1 — * `documents` |
| `docNodes` | Append-only, immutable branching undo-tree DAG. One row per edit state. Delta-encoded with periodic snapshots. | `documents` 1 — * `docNodes` |
| `versions` | Tagged, durable references into `docNodes` (auto + manual). | `documents` 1 — * `versions` |
| `workspaces` | One row per user. The persisted pane tree, open documents, and per-pane view state. | `users` 1 — 1 `workspaces` |

Relationship summary:

```
users ──1:* ── documents ──1:* ── docNodes   (each node points at parentNodeId within the same document)
                   │
                   └──1:* ── versions          (each version.nodeId references a docNodes.nodeId)

users ──1:1 ── workspaces                      (workspaces.openDocumentIds reference documents)
```

Key invariants:

- `documents.currentNodeId` is a **string** matching a `docNodes.nodeId` for that document. It is *not* a Convex `Id<"docNodes">` — node identity is a client-generated ULID so that offline/optimistic node creation never needs a server round-trip to mint an id (see [`07-undo-tree.md`](./07-undo-tree.md)).
- `versions.nodeId` is likewise a `docNodes.nodeId` string, scoped to the same `documentId`.
- `docNodes.parentNodeId` is a `docNodes.nodeId` string or `null` (the root). The DAG is per-document; there are no cross-document edges.
- `workspaces.openDocumentIds` are real `Id<"documents">[]`.

### 1.1 Post-v1 tables (specified in their owning plan docs, not here)

The shipped `convex/schema.ts` carries five additional application tables added
by later plans. This blueprint deliberately does not restate their specs — the
owning plan is the contract:

| Table | Purpose (one line) | Owning plan |
|-------|--------------------|-------------|
| `writingStats` | Per-user, per-day writing activity for goals/streaks. | [`plans/002-writing-goals-and-streaks.md`](../../plans/002-writing-goals-and-streaks.md) |
| `docChunks` | Paragraph-window embeddings for RAG over own drafts (vector index). | [`plans/009-ai-reversible-assist.md`](../../plans/009-ai-reversible-assist.md) (Phase C) |
| `documentShares` | Per-document share grants (commenter/suggester roles). | [`plans/010-review-collaboration.md`](../../plans/010-review-collaboration.md) |
| `reviewBranches` | Index over reviewer suggestion branches in the undo DAG (status drives accept/reject). | [`plans/010-review-collaboration.md`](../../plans/010-review-collaboration.md) |
| `comments` | Anchored review comments (human and AI reviewers). | [`plans/010-review-collaboration.md`](../../plans/010-review-collaboration.md) |
| `settings` | The writer's synced preferences, one opaque JSON object per user. | [`plans/023-native-apple-apps.md`](../../plans/023-native-apple-apps.md) §4.1, ADR-21 |
| `blobs` | Ownership for stored files: `storageId → {ownerUserId, kind}`. `_storage` carries no owner. | ADR-21 |
| `accountDeletions` | An in-flight (or just-finished) account deletion. Its existence blocks every user-facing mutation for that user, and it carries the paged foreign-reference survey's cursors and token buckets. | ADR-21 |
| `blobRefs`, `migrationProgress` | Migration-only scaffolding for the blob-owner backfill. Dropped by `migrations.cleanupBlobRefs`. | ADR-21 |

### 1.2 Changes made for the native apps (ADR-21)

- **`workspaces` is now keyed by `(userId, deviceId)`**, not one row per user (§3.4). A device row carries `deviceId`, `deviceClass` (`mac` | `ipad` | `iphone` | `web`) and an opaque `json` layout; the pre-migration row has none of those and is still served by `workspaces.get/save`. A user has at most one legacy row and one row per device, capped at 32 devices (least-recently-used evicted).
- **`documents.documentUuid`** (optional) is a client-minted idempotency key for creation, indexed `by_user_uuid`. **`documents.rootNodeId`** (optional) stores the root so a replayed `create` can hand back the same one without walking the history.
- **`docNodes.authorUserId`** (optional, indexed `by_author_document`) attributes a suggestion node to the reviewer who wrote it. The node lives in the document OWNER's rows, so nothing keyed to the reviewer reaches it, and the pre-existing `review:<userId>` origin string is not an index. **`docNodes.branchId`** records which review branch it belongs to, so account deletion decides per branch rather than per (document, reviewer) — one accepted branch must not rescue that reviewer's rejected ones.
- **Indexes added for account deletion**: `reviewBranches.by_reviewer`, `comments.by_author`, `docChunks.by_user`, `blobs.by_owner`, `blobs.by_storage`, `accountDeletions.by_user`, `accountDeletions.by_expires`. A user's traces on *other people's* documents are only reachable by author/reviewer, and a vector index cannot be queried as a range.

---

## 2. Full Convex schema (`convex/schema.ts`)

Defined with `defineSchema` / `defineTable` / `v.*` per <https://docs.convex.dev/database/schemas>. `users` is owned by Better Auth and is shown only as a reference for the `Id<"users">` foreign keys — do not redefine it here if the auth integration already declares it.

```ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // users — managed by Better Auth. Referenced by Id<"users">.

  documents: defineTable({
    userId: v.id("users"),
    title: v.string(),
    // Canonical serialized Markdown — the source of truth at rest (D1).
    markdown: v.string(),
    wordCount: v.number(),
    // Pointer into the undo-tree DAG; matches a docNodes.nodeId (NOT an Id<"docNodes">).
    currentNodeId: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    // Powers the document list ordered by recency without a post-query sort.
    .index("by_user_updated", ["userId", "updatedAt"]),

  docNodes: defineTable({
    documentId: v.id("documents"),
    // Client-generated ULID; globally unique; the durable node identity.
    nodeId: v.string(),
    parentNodeId: v.union(v.string(), v.null()),
    // Compact delta of canonical Markdown vs the parent node's materialized state.
    patch: v.string(),
    // Occasional full Markdown snapshot for fast materialization (every N nodes).
    snapshot: v.optional(v.string()),
    // Editor selection captured at the time this state was reached.
    selection: v.union(
      v.object({ anchor: v.number(), head: v.number() }),
      v.null(),
    ),
    // Device/client id that created the node (origin guard + provenance).
    origin: v.string(),
    createdAt: v.number(),
  })
    .index("by_document", ["documentId"])
    // Direct lookup of a specific node within a document (materialization, restore).
    .index("by_document_node", ["documentId", "nodeId"]),

  versions: defineTable({
    documentId: v.id("documents"),
    // The docNodes node this version points at (a docNodes.nodeId string).
    nodeId: v.string(),
    label: v.string(),
    kind: v.union(v.literal("auto"), v.literal("manual")),
    createdAt: v.number(),
  }).index("by_document", ["documentId"]),

  workspaces: defineTable({
    userId: v.id("users"),
    // JSON: recursive split layout (see 09-documents-workspace-split.md).
    paneTree: v.string(),
    openDocumentIds: v.array(v.id("documents")),
    activePaneId: v.string(),
    // JSON: per-pane mode + cursor/scroll state.
    perPaneViewState: v.string(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),
});
```

### 2.1 Field notes

| Field | Why this type / shape |
|-------|-----------------------|
| `documents.markdown` | The whole canonical document as one string. Must stay under the ~1 MiB value ceiling (§5). Long articles are fine; book-length manuscripts are an explicit non-goal (README §5). |
| `documents.currentNodeId` | A `v.string()` ULID, not an `Id`. Lets the client create the next node optimistically and set the pointer in the same mutation without a server-minted id. |
| `docNodes.parentNodeId` | `v.union(v.string(), v.null())` — `null` only for the root node of a document's DAG. |
| `docNodes.patch` | A compact delta (§4). Never the full document except in the root or a periodic snapshot node. |
| `docNodes.snapshot` | `v.optional(v.string())` — present only on snapshot nodes (every N nodes). Absent rows are delta-only. |
| `docNodes.selection` | `{ anchor, head }` are character offsets into the materialized Markdown; `null` when no meaningful selection. |
| `versions.kind` | `v.union(v.literal("auto"), v.literal("manual"))` — matches D9's auto + manual tagging. |
| `workspaces.paneTree` / `perPaneViewState` | Stored as JSON **strings**, not nested Convex objects. The pane tree is recursive and the per-pane state is heterogeneous; serializing to a string keeps the schema flat and dodges deep-validator churn. Parsed/validated on the client (see [`09-documents-workspace-split.md`](./09-documents-workspace-split.md)). |

### 2.2 Index inventory

| Table | Index | Fields | Used by |
|-------|-------|--------|---------|
| `documents` | `by_user` | `["userId"]` | scope all of a user's documents |
| `documents` | `by_user_updated` | `["userId", "updatedAt"]` | document list ordered by recency |
| `docNodes` | `by_document` | `["documentId"]` | load/replay a document's DAG; `listSince`; pruning |
| `docNodes` | `by_document_node` | `["documentId", "nodeId"]` | resolve a single node for materialization/restore |
| `versions` | `by_document` | `["documentId"]` | list tags for a document |
| `workspaces` | `by_user` | `["userId"]` | the single workspace row per user |

---

## 3. Function surface

Every write to persistent state goes through a Convex function; the editor never writes directly (see [`10-sync-persistence.md`](./10-sync-persistence.md)). Signatures below use the argument/return shapes the client relies on. All functions verify the authenticated `userId` (Better Auth) and that the target row belongs to that user before touching it.

### 3.1 `documents.*`

```ts
// query
documents.list(): Array<{
  _id: Id<"documents">;
  title: string;
  wordCount: number;
  updatedAt: number;
}>;
// Uses by_user_updated, descending. Returns list metadata only — NOT the markdown body —
// so the switcher stays cheap and well under the read ceiling.

// query
documents.get(args: { documentId: Id<"documents"> }): {
  _id: Id<"documents">;
  title: string;
  markdown: string;
  wordCount: number;
  currentNodeId: string;
  createdAt: number;
  updatedAt: number;
} | null;

// mutation
documents.create(args: { title?: string }): {
  documentId: Id<"documents">;
  rootNodeId: string;
};
// Inserts the document AND its root docNodes node (parentNodeId: null, snapshot: "")
// in one transaction, then sets currentNodeId = rootNodeId.

// mutation
documents.rename(args: { documentId: Id<"documents">; title: string }): void;

// mutation
documents.updateMarkdown(args: {
  documentId: Id<"documents">;
  markdown: string;
  wordCount: number;
  expectedUpdatedAt: number; // stale-version guard (see 10 §5)
}): { updatedAt: number; stale: boolean };
// The debounced autosave write path. Replaces documents.markdown, recomputes nothing
// server-side (wordCount is passed in), and stamps updatedAt. If the stored updatedAt
// no longer equals expectedUpdatedAt, returns { stale: true } WITHOUT overwriting, so
// the client can re-hydrate an idle pane rather than clobber a newer device's write.

// mutation
documents.remove(args: { documentId: Id<"documents"> }): void;
// Deletes the document and cascades: all docNodes by_document and all versions by_document.
// Batched to respect the per-transaction write ceiling (§5).
```

> `documents.updateMarkdown` is deliberately separate from undo-node creation. Saving the live text and appending a history node are different rhythms (§4, [`10-sync-persistence.md`](./10-sync-persistence.md)): every debounced idle saves the markdown; only meaningful edit groups append a `docNodes` row.

### 3.2 `docNodes.*` (append-only)

```ts
// mutation
docNodes.append(args: {
  documentId: Id<"documents">;
  nodeId: string;            // client ULID
  parentNodeId: string | null;
  patch: string;             // delta vs parent's materialized state
  snapshot?: string;         // present only on periodic snapshot nodes
  selection: { anchor: number; head: number } | null;
  origin: string;            // device/client id
}): { nodeId: string };
// Inserts one immutable node. Idempotent on (documentId, nodeId): if the node already
// exists (re-sent after a retry or cross-device union-merge), it is a no-op. Existing
// nodes are NEVER updated — append-only (D8).

// query
docNodes.listSince(args: {
  documentId: Id<"documents">;
  sinceCreatedAt?: number;   // for incremental hydration; omit for full DAG
}): Array<Doc<"docNodes">>;
// Uses by_document. Returns nodes for client-side DAG reconstruction. With sinceCreatedAt
// it returns only newer nodes so idle devices can union-merge incrementally.

// query
docNodes.getSnapshotAt(args: {
  documentId: Id<"documents">;
  nodeId: string;
}): { markdown: string; nodeId: string };
// Materializes the Markdown state AT a given node by walking parentNodeId back to the
// nearest snapshot node, then replaying patches forward (§4.3). Server-side so a
// "restore this version" or "jump to this undo state" never ships the whole DAG.
```

`docNodes` exposes **no** update or per-node delete mutation by design. Removal happens only through `documents.remove` (cascade) and the retention sweep (§6) — both append-only-safe because they prune whole abandoned subtrees, never edit a node's contents.

### 3.3 `versions.*`

```ts
// mutation
versions.create(args: {
  documentId: Id<"documents">;
  nodeId: string;            // a docNodes.nodeId to tag
  label: string;
  kind: "auto" | "manual";
}): { versionId: Id<"versions"> };

// query
versions.list(args: { documentId: Id<"documents"> }): Array<{
  _id: Id<"versions">;
  nodeId: string;
  label: string;
  kind: "auto" | "manual";
  createdAt: number;
}>;
// Uses by_document, newest first.

// mutation
versions.restore(args: {
  documentId: Id<"documents">;
  versionId: Id<"versions">;
}): { newNodeId: string; markdown: string };
// ADDITIVE restore (D9): materializes the version's node, appends a NEW docNodes node
// whose parent is the current head, writes that markdown to documents.markdown, and
// advances currentNodeId. The old history is untouched — restore moves forward, never
// rewrites. See 08-version-control.md.

// mutation
versions.remove(args: { documentId: Id<"documents">; versionId: Id<"versions"> }): void;
// Untags. Removing a version does NOT remove its docNodes node; it only deletes the tag.
// (A tagged node is also protected from retention pruning — §6.)
```

### 3.4 `workspace.*`

```ts
// query
workspace.get(): {
  paneTree: string;
  openDocumentIds: Id<"documents">[];
  activePaneId: string;
  perPaneViewState: string;
  updatedAt: number;
} | null;
// The single row for the authenticated user (by_user). null before first save.

// mutation
workspace.save(args: {
  paneTree: string;
  openDocumentIds: Id<"documents">[];
  activePaneId: string;
  perPaneViewState: string;
}): { updatedAt: number };
// Upserts the user's one workspace row (insert if absent, patch if present).
// Debounced like document saves — layout changes are not on a hot path.
```

**Superseded by the per-device surface (ADR-21).** The pair above is the LEGACY
shape: it still exists, because a browser tab loaded before the migration keeps
calling it and because each migrating client reads it once to seed its own
device row. Nothing writes it any more. New clients use:

```ts
// query
workspaces.getForDevice(args: { deviceId: string }): {
  deviceId: string;
  deviceClass: "mac" | "ipad" | "iphone" | "web";
  json: string;         // opaque to the server; the client's own layout shape
  updatedAt: number;
} | null;

// mutation — last-write-wins; only that device's own windows write it
workspaces.saveForDevice(args: {
  deviceId: string;     // non-empty, ≤64 chars
  deviceClass: "mac" | "ipad" | "iphone" | "web";
  json: string;         // ≤256 KiB (UTF-8)
}): { updatedAt: number };

// query — the menu behind "Resume from <device> layout"; metadata only, so
// opening it does not ship every device's tree. Fetch the chosen one with
// getForDevice. Newest first.
workspaces.listForUser(): {
  deviceId: string;
  deviceClass: "mac" | "ipad" | "iphone" | "web";
  updatedAt: number;
}[];
```

A Mac's four-way split is not a layout an iPhone can render, so one shared row
meant every device overwrote the others on each focus change. Moving to another
device's layout is now something the writer asks for.

### 3.5 `settings.*`

```ts
// query
settings.get(): { json: string; updatedAt: number } | null;

// mutation
settings.save(args: {
  json: string;                    // a JSON OBJECT, ≤64 KiB (UTF-8)
  expectedUpdatedAt?: number;      // omit for plain LWW
}): { saved: true; conflict: false; updatedAt: number }
 | { saved: false; conflict: true; json: string | null; updatedAt: number | null };
```

The server stores one opaque object per user and never looks inside it, so
adding a setting needs no migration and a client that does not know a key
leaves it alone. It cannot merge two devices' writes either, hence LWW over the
whole object with an optional compare-and-set for callers that would rather be
told they lost than overwrite blindly. `updatedAt` is strictly increasing, so
two saves inside one millisecond cannot share a stamp and let a stale CAS pass.

Not every setting lives here — see
[`10-sync-persistence.md`](./10-sync-persistence.md) §8 for the split.

### 3.6 `account.deleteEverything` / `export.docx`

**Every user-facing mutation refuses while an `accountDeletions` row exists for
the caller** (`convex/accountGuard.ts`, applied inside `documents.requireUserId`
and `review.requireDocumentAccess`). Queries are unaffected. This is what makes
a deletion atomic across the many transactions it takes: a JWT outlives the
Clerk user, so without it a stale tab or an offline outbox writes rows behind
the purge. See ADR-21.

```ts
// action (authenticated) — App Store guideline 5.1.1(v)
account.deleteEverything(): {
  userId: string;
  rowsDeleted: number;
  blobsDeleted: number;
  clerkUserDeleted: boolean;
  appleRevocation:
    | { status: "not-applicable" }
    | { status: "skipped"; reason: string }
    | { status: "unknown"; reason: string };
};

// action (authenticated) — one .docx renderer for web and native
export.docx(args: { documentId: Id<"documents">; origin?: string }): {
  storageId: string;
  url: string;          // deleted after EXPORT_TTL_MS (15 min) by the scheduler
  filename: string;
  bytes: number;
  expiresAt: number;
};
```

`deleteEverything` probes Clerk first (a wrong-instance secret 404s everything,
and nothing may be deleted on that), writes the tombstone, purges owned blobs
then rows in bounded batches, deletes the Clerk user LAST, and sweeps once more.
Every step before the Clerk call is idempotent, so a failure leaves an account
that can still sign in and retry; a server-owned `resumeDeletion` job finishes
it if the caller disconnects.

`export.docx` renders the SERVER's canonical markdown through
`lib/export/docx-render.ts`, the same module the browser runs, and registers the
generated file's ownership before handing out its URL; clients with unsynced
edits must flush first.

Image uploads do **not** use `files.generateUploadUrl` any more. They POST to
`{NEXT_PUBLIC_CONVEX_SITE_URL}/upload-image` (`convex/http.ts`) with a
Convex-templated Clerk JWT; the action stores the bytes and records ownership
before answering, and deletes what it stored if the claim is refused. The signed-URL
mutation remains only for browser tabs deployed before that change.

Six one-shot migration steps exist for rows that predate ADR-21 —
`backfillNodeAuthors`, `backfillNodeBranches`, `scanDocumentRefs`,
`scanNodeRefs`, `backfillBlobOwners`, `cleanupBlobRefs`. Each is idempotent,
bounded, and keeps its own progress in `migrationProgress`; run each until it
reports `done`.

---

## 4. History storage strategy — append-only, immutable, delta-encoded

The undo tree (D8) and version history (D9) share one store: `docNodes`. Its design is dictated by three forces — losslessness, Convex's value/transaction ceilings (§5), and conflict-free cross-device merge.

### 4.1 Append-only and immutable

Every `docNodes` row, once written, is **never mutated and never edited in place**. Navigating undo/redo, branching, and tagging all happen by *adding* rows and by *moving the `documents.currentNodeId` pointer* — never by rewriting a node. This is what makes cross-device merge trivial: nodes are keyed by a globally unique client ULID (`nodeId`), so two devices that each created nodes offline simply union their node sets on reconnect with no conflict (see [`07-undo-tree.md`](./07-undo-tree.md)). The only pointer that is last-write-wins is `documents.currentNodeId`.

### 4.2 Delta encoding with periodic snapshots

Storing a full Markdown copy per edit state would blow past the value ceiling and waste write bandwidth. Instead each node stores:

- `patch` — a **compact delta of the canonical Markdown** of this state versus its parent's materialized state. For a normal keystroke-group edit this is tiny (a few characters of insert/delete).
- `snapshot` (optional) — a **full Markdown snapshot**, written on the **root node** and then on **every Nth node** along a branch (a tunable cadence, e.g. every 50 nodes). Snapshots bound replay cost and cap how far back a materialization ever has to walk.

```ts
// Conceptual shape of what append() persists per node.
type NodeWrite =
  | { kind: "root";     patch: ""; snapshot: string }          // full doc, no parent
  | { kind: "delta";    patch: string }                         // delta vs parent
  | { kind: "snapshot"; patch: string; snapshot: string };      // delta + periodic full copy
```

The delta is computed over the **canonical Markdown string**, not over MDAST or ProseMirror JSON — keeping the same source of truth Recto uses everywhere (D1). Any battle-tested text-diff/patch encoding is acceptable; the contract is only that `applyPatch(parentMarkdown, patch)` reproduces this node's Markdown exactly.

### 4.3 Materialization (replaying a state)

To reconstruct the Markdown at any `nodeId`:

```
1. Walk parentNodeId pointers backward from the target node until a node with a
   `snapshot` is found (the root always has one, so this terminates).
2. Take that snapshot as the base Markdown.
3. Replay each `patch` forward, in order, down to the target node.
4. The result is the exact canonical Markdown for that node.
```

`docNodes.getSnapshotAt` does this server-side so callers never download the DAG just to view one historical state. Because snapshots cap the walk at N nodes, materialization cost is bounded regardless of total history depth.

---

## 5. Convex limits and how we live within them

From <https://docs.convex.dev/production/state/limits>:

| Limit | Value (approx.) | Recto's mitigation |
|-------|-----------------|--------------------|
| Max size of a single document/value | **~1 MiB** | `documents.markdown` is one article's Markdown — comfortably small; book-length manuscripts are out of scope (README §5). History is **never** an embedded array on the document; each state is its own `docNodes` row. |
| Max data scanned/written per transaction | **~16 MiB** | We never read or rewrite the whole DAG in one mutation. `append` writes one row. `listSince` reads incrementally. `remove` cascades in **batches** sized to stay well under the ceiling. |
| Function execution time | **~1 second** | Hot-path mutations (`updateMarkdown`, `docNodes.append`, `workspace.save`) touch one or two rows. Materialization is bounded by the snapshot cadence (§4.3). Heavy sweeps (retention §6) run as scheduled/batched jobs, not inside an interactive write. |
| Max array length / object nesting in a value | bounded | `workspaces.paneTree` and `perPaneViewState` are JSON **strings**, not nested validated objects, so deep recursion never hits the nesting limit. |

Design rules that fall out of these limits:

1. **History lives in separate rows, never an embedded array.** One `docNodes` row per state. This is non-negotiable — an embedded version array would grow the single `documents` value past 1 MiB and rewrite the whole array on every edit (16 MiB transaction pressure).
2. **Delta-encode.** Per-node `patch` keeps each row tiny; periodic `snapshot`s keep replay bounded.
3. **Batch destructive cascades.** `documents.remove` deletes `docNodes` and `versions` in chunks across the per-transaction budget.
4. **No full scans on the hot path.** Every read uses an index (§2.2).

---

## 6. Retention and pruning (`docNodes`)

History is append-only, but it is not infinite. The growth risk is called out in the plan's risk register; the policy mirrors its fallback ("cap depth; keep recent + all tagged; prune deep abandoned branches"). Pruning runs as a **scheduled, batched** sweep — never inside an interactive mutation.

Retention rules, in priority order — a node is **kept** if **any** apply:

1. **Tagged.** The node is referenced by any `versions.nodeId` for the document. Tagged history is permanent (D9). `versions.remove` only untags; it never deletes the node.
2. **On the live spine.** The node is `documents.currentNodeId` or an ancestor of it (the path from root to head must always materialize).
3. **Recent.** The node is within the recent retention window (by `createdAt`, e.g. the last N nodes / last M days), so recent undo/redo is always intact.
4. **Ancestor of a kept node.** Required so every kept node still materializes (its snapshot chain is intact).

A node is **eligible for pruning** only when it is a **deep, abandoned branch** — reachable from neither the live spine nor any tag, and older than the recent window. Pruning removes whole abandoned subtrees, preserving the append-only invariant for everything that remains (we never rewrite a surviving node; we only drop dead ones). If pruning would orphan a snapshot that a surviving node depends on, that snapshot's subtree is retained.

---

## 7. Access patterns and query efficiency

- **Always query by index.** Every read path above maps to an index in §2.2. There are no full-table scans on any user-facing path.
- **Document list is metadata-only.** `documents.list` returns title/wordCount/updatedAt via `by_user_updated`, ordered by recency without a post-fetch sort, and **omits `markdown`** so the switcher payload stays tiny.
- **Body loaded on demand.** `documents.get` returns the full `markdown` only for the document(s) actually open in a pane.
- **History loaded lazily and incrementally.** `docNodes.listSince` powers initial DAG hydration and incremental cross-device merge (pass `sinceCreatedAt` to fetch only new nodes). The undo visualizer reads from the already-hydrated client DAG, not by re-querying per node.
- **Single-state views go server-side.** `docNodes.getSnapshotAt` materializes one historical state without shipping the DAG — used by version preview/restore and undo-jump.
- **Workspace is one row.** `workspace.get` hits `by_user` for the single row; saves are debounced upserts.

Together these keep every interactive operation within the ~1 s execution and ~16 MiB transaction budgets (§5), and keep typing entirely off the network path (see [`10-sync-persistence.md`](./10-sync-persistence.md)).
