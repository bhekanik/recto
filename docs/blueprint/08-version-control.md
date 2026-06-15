# 08 — Version Control

> **Scope.** This file specifies Recto's **tagged version history** (locked decision **D9**): named, durable snapshots layered over the same append-only store as the undo tree, with **additive** restore. It is self-contained. Where it touches sibling areas it cross-references them by exact filename: the undo tree that shares this store lives in [`07-undo-tree.md`](./07-undo-tree.md); the canonical model, the `docNodes`/`versions` schema, and patch/snapshot materialization live in [`03-data-model.md`](./03-data-model.md); the debounced last-write-wins Convex sync and the multi-tab / cross-device concurrency model live in [`10-sync-persistence.md`](./10-sync-persistence.md). The implementation order is [`../plan/phase-4-history.md`](../plan/phase-4-history.md).
>
> If anything here contradicts [`README.md`](./README.md), the README wins.

---

## 1. What versions are

A **version** is a **named, durable snapshot** of a document at a point in its history. Versions live in the canon `versions` table, and each one **references a `docNodes.nodeId`** — it does not copy the content, it points at an existing node in the append-only DAG (the same DAG the undo tree navigates, see [`07-undo-tree.md`](./07-undo-tree.md)).

```ts
// versions — tagged snapshots; references INTO docNodes.
// Canonical contract from README.md §7 — do not rename fields.
versions: {
  documentId: Id<"documents">,
  nodeId: string,                 // the docNodes node this version points at (docNodes.nodeId, same documentId)
  label: string,                  // "draft v1", "before rewrite", or an auto-generated timestamp label
  kind: "auto" | "manual",        // periodic/significant-change vs user-named tag
  createdAt: number,
}
// index: by_document (documentId)
```

There are exactly **two kinds**:

| `kind` | Created by | `label` | Trigger |
|--------|-----------|---------|---------|
| `"auto"` | The app, automatically | Generated (e.g. a timestamp, or "Auto · 14:32") | Periodic interval and/or on a significant change (§4) |
| `"manual"` | The user, explicitly | User-typed name (e.g. *"final draft"*) | User invokes "Tag version" (§6) |

A version is **immutable in spirit**: its `nodeId` reference never changes (the node it points at is itself immutable — see [`07-undo-tree.md`](./07-undo-tree.md) §3). The only mutable thing about a `manual` version is its `label` (rename) and the user's right to **delete the tag** (§6) — which deletes only the `versions` row, never the underlying `docNodes` node.

> **Why reference, not copy.** Because `docNodes` already holds every state immutably, a version is just a *pinned pointer with a name*. This keeps versions cheap (one small row each), keeps the canonical content single-sourced, and lets the undo-tree visualizer badge tagged nodes directly ([`07-undo-tree.md`](./07-undo-tree.md) §9). It also means a tagged node is **pinned against retention pruning** ([`07-undo-tree.md`](./07-undo-tree.md) §8).

To show a version's content we **materialize** its `nodeId` — walk to the nearest ancestor `snapshot` and replay `patch`es forward, the algorithm owned by [`03-data-model.md`](./03-data-model.md) and used identically by the undo tree ([`07-undo-tree.md`](./07-undo-tree.md) §5.1).

---

## 2. Additive restore — the key semantic

> **Restoring a version does NOT rewind or destroy history. It creates a NEW node/branch whose content equals the version's state, and moves `documents.currentNodeId` there.**

This is the single most important rule in this file. Restore is **additive**, like `git checkout` of a past commit onto a new working state — it moves you *to* an old state by **forking forward**, never by deleting what came after.

```
Before restore — you are at n7; you want to go back to the state tagged "draft v1" (= node n3):

   root ─ n1 ─ n2 ─ ★n3 "draft v1" ─ n4 ─ n5 ─ n6 ─ n7   ◀ currentNodeId

Restore "draft v1":  materialize(n3) → append a NEW node n8 with that content; move the pointer.

   root ─ n1 ─ n2 ─ ★n3 "draft v1" ─ n4 ─ n5 ─ n6 ─ n7
                      │
                      └─ … (the original n3 branch is untouched)
   …and a new node is appended onto the current tip:

   root ─ n1 ─ n2 ─ ★n3 ─ n4 ─ n5 ─ n6 ─ n7 ─ n8 (content === n3's)   ◀ currentNodeId now n8

   ✔ n4–n7 still exist and are still reachable via the undo tree.
   ✔ The "draft v1" tag still points at n3.
   ✔ You can undo from n8 right back through n7…n4 — nothing was lost.
```

Mechanically:

```ts
/** Restore a version: additive. Appends a new node equal to the version's state, then moves the pointer. */
async function restoreVersion(documentId: Id<"documents">, versionNodeId: string): Promise<void> {
  const markdown = await materialize(documentId, versionNodeId);   // 03-data-model.md replay
  const newNode = await appendNode(documentId, {
    parentNodeId: getCurrentNodeId(documentId),                    // FORK FORWARD off the current tip
    markdown,                                                      // stored as patch vs parent (+ snapshot per cadence)
    selection: null,
    origin: thisDeviceId,
  });
  updateCurrentNodeId(documentId, newNode.nodeId);                 // debounced LWW — see 10-sync-persistence.md
  reprojectIntoAllLenses(markdown);                                // MDAST bus — see 07-undo-tree.md §5.2
}
```

Note `parentNodeId` is the **current tip**, not the version's node. The new node descends from wherever you were, so the restore is recorded *in* history rather than overwriting it. This is fully consistent with the undo tree's append-only/immutable invariant ([`07-undo-tree.md`](./07-undo-tree.md) §3): restore is just another node append, distinguished only by *how its content is sourced* (from an old version) rather than from a keystroke group.

---

## 3. Relationship to the undo tree

Versions and the undo tree **share the append-only `docNodes` store** but have **distinct semantics**. They are two *layers* over one store, not one object:

| | **Undo tree** ([`07-undo-tree.md`](./07-undo-tree.md)) | **Versions** (this file) |
|---|---|---|
| Store | `docNodes` (shared) | `versions` rows referencing `docNodes.nodeId` (shared) |
| Operation | **NAVIGATE** the DAG (move the pointer to an existing node) | **FORK FORWARD** (restore = append a new node) |
| Granularity | Fine — keystroke-coalesced (~500 ms groups) | Coarse — named milestones / periodic snapshots |
| Lifetime | Recent kept; deep abandoned branches prunable | Durable; pin their `docNodes` node against pruning |
| Naming | Auto-derived ("typing", "paste") | `label` ("auto" timestamp or user-typed) |
| Mental model | Vim undotree | `git tag` + additive checkout |

> **Do not unify them into one object.** Undo is *navigation*; version restore is a *forward fork*. Collapsing them would either make every undo step a durable named version (noise, unbounded growth, no pruning) or make versions navigable like undo (rewinding history, defeating durability). Keeping them distinct is what every shipping tool does.

This is not a Recto idiosyncrasy — it is the consensus design across the field:

- **Figma, Notion, Google Docs, Obsidian** all keep fine-grained, ephemeral, often-linear undo **separate** from a durable, named/dated version history, and in all of them **restoring a version is additive** (it creates a new current state; it does not erase intervening edits).
- **Yjs** keeps its `UndoManager` — **two linear stacks (undo/redo), not a tree** — entirely separate from its document **snapshots**; the two are different APIs for different jobs. Ref: [`https://docs.yjs.dev/api/undo-manager`](https://docs.yjs.dev/api/undo-manager).
- **Automerge** models history as a **git-like change DAG** of immutable changes — durable history is a first-class, append-only structure, distinct from any transient undo affordance. Ref: [`https://automerge.org/docs/reference/glossary/`](https://automerge.org/docs/reference/glossary/).
- **Ink & Switch's "Patchwork"** builds **branches plus named milestones over one underlying history** — exactly Recto's shape: one append-only store, with fine-grained edits and coarse named markers as separate concepts. Ref: [`https://www.inkandswitch.com/patchwork/`](https://www.inkandswitch.com/patchwork/).

Recto follows the same separation: one append-only `docNodes` store, with the undo tree and the version layer as two distinct semantics over it.

---

## 4. Auto-snapshot policy and retention

`auto` versions exist so the user never has to remember to tag, and so there is always a recent durable anchor to recover from. They are created by **two complementary triggers**:

1. **Interval trigger** — on a periodic cadence during active editing (debounced; on the idle/persistence path, never on the typing hot path — see [`10-sync-persistence.md`](./10-sync-persistence.md)). If nothing changed since the last auto version, no new version is created (no duplicate tags for an idle document).
2. **Significant-change trigger** — when a structurally significant change lands: a large paste, a bulk delete, a mode switch that produced a substantial edit, or a word-count delta past a threshold. This reuses the "significant change" classification the undo tree already computes for grouping ([`07-undo-tree.md`](./07-undo-tree.md) §4), so the two layers agree on what "significant" means.

Each trigger creates an `auto` version pointing at the **current** `docNodes.nodeId` — it pins that node, but creates no new node (versions reference, they don't append; only *restore* appends, §2).

**Retention** keeps the version list useful without unbounded growth:

```
auto versions:   keep all recent; thin older auto versions over time
                 (e.g. hourly → daily → weekly buckets), so the list stays scannable.
manual versions: KEEP FOREVER. The user named them on purpose; never auto-prune a manual tag.
```

When an `auto` version is thinned, only its `versions` row is removed. Its underlying `docNodes` node is then unpinned and becomes a normal undo-tree node — eligible for the undo tree's own retention rules ([`07-undo-tree.md`](./07-undo-tree.md) §8) but not deleted *because of* the version thinning.

---

## 5. Diff / compare

Two versions can be compared by **materializing both Markdown states and showing a text diff**:

```
compare(versionA, versionB):
  1. mdA = materialize(documentId, versionA.nodeId)   // 03-data-model.md replay
  2. mdB = materialize(documentId, versionB.nodeId)
  3. render a line/word-level text diff of mdA vs mdB
```

The diff operates on the **canonical Markdown strings** — the single source of truth at rest ([`README.md`](./README.md) D1) — not on rendered HTML or on a lens-specific representation. This guarantees the diff reflects exactly what is stored and what would be restored. Compare is **read-only**: it materializes states for display and never moves the pointer or appends a node. (Acting on a comparison — e.g. "restore the left one" — goes through the additive `restoreVersion` path, §2.)

---

## 6. The version-history UI

The version history is the durable, named counterpart to the undo-tree visualizer ([`07-undo-tree.md`](./07-undo-tree.md) §9), built in [`../plan/phase-4-history.md`](../plan/phase-4-history.md):

```
 ┌─ Version history ─────────────────────────────────┐
 │  [ + Tag current version ]                         │
 │                                                    │
 │  ★ final draft        manual   2026-06-15 14:40    │  ◀ selected
 │    before rewrite     manual   2026-06-15 11:02    │
 │    Auto · 10:30       auto     2026-06-15 10:30    │
 │    Auto · 09:30       auto     2026-06-15 09:30    │
 │                                                    │
 │  [ Restore ]  [ Compare with… ]  [ Rename ]  [ Delete tag ] │
 └────────────────────────────────────────────────────┘
```

Operations:

- **List** — versions for the current document via the `by_document` index, newest first, each showing `label`, `createdAt` (timestamp), and `kind` (a visible `auto`/`manual` badge).
- **Create tag** — "Tag current version": prompts for a `label`, writes a `manual` `versions` row pointing at the current `docNodes.nodeId`. Pins that node against pruning.
- **Restore** — runs the **additive** restore of §2 (append a new node, move the pointer, re-project into all lenses). The UI states clearly that restore does not erase later edits.
- **Compare** — pick a second version; show the text diff of §5.
- **Rename** — edit a `manual` version's `label` (the only in-place mutation a version allows).
- **Delete tag** — remove a `versions` row. Deletes **only the tag**, never the underlying node; the node remains in the undo tree (subject to that layer's retention). `manual` tags are never auto-deleted (§4); the user may delete them explicitly here.

All writes go through Convex mutations on the debounced/idle path described in [`10-sync-persistence.md`](./10-sync-persistence.md); the UI never writes a row or moves the pointer directly off the typing hot path.

---

## 7. Versions as the cross-device + multi-tab safety net

Versions are the explicit recovery mechanism for the one accepted risk in Recto's sync model. Per [`README.md`](./README.md) D10–D11 and [`10-sync-persistence.md`](./10-sync-persistence.md), persistence is a **debounced last-write-wins snapshot** — the local editor owns live state, and there is no CRDT. The accepted edge case (README risk register: *"Same doc edited on two devices within debounce window"*) is that a last-write-wins overwrite could, in a narrow window, lose an edit made on another device/tab.

> **Versions are the safety net.** Because `docNodes` is append-only and version-pinned nodes are durable, **the prior state is always recoverable from version history.** If a debounced LWW write ever overwrites an edit, the overwritten state — if it was at or after a tagged or auto-versioned node — is still materializable and can be restored additively (§2). No durable, versioned state is ever truly lost to a last-write-wins race.

This is why the README places versions and the undo tree together as the "history" safety layer, and why auto-versioning (§4) runs on a steady cadence: a generous supply of recent `auto` versions narrows the window in which any cross-device or multi-tab race could cost unrecoverable text. The interaction with debounce timing, the stale-version guard, and multi-tab coordination are specified in [`10-sync-persistence.md`](./10-sync-persistence.md); this file guarantees the *recovery* path those mechanisms fall back to.

---

## 8. Summary

| Concern | Decision |
|---------|----------|
| What a version is | Named, durable row in `versions` referencing a `docNodes.nodeId` (D9) |
| Kinds | `auto` (periodic / significant-change) and `manual` (user-named tag) |
| Restore semantics | **Additive** — append a new node = version's content, move `documents.currentNodeId`; never rewind/destroy (the key rule, §2) |
| vs undo tree | Shared `docNodes` store, distinct semantics: undo **navigates**, restore **forks forward**; never unified |
| Field consensus | Figma/Notion/Docs/Obsidian/Yjs all keep fine-grained undo separate from durable versions; restore is always additive |
| Auto policy | Interval + significant-change triggers; pin current node; thin old `auto`, keep `manual` forever |
| Compare | Materialize both Markdown states; text diff; read-only |
| UI | List (label/timestamp/kind), tag, restore, compare, rename, delete-tag |
| Safety net | Recovers prior state if debounced LWW sync ever loses an edit |

**References.** Yjs UndoManager (two linear stacks, separate from snapshots): [`https://docs.yjs.dev/api/undo-manager`](https://docs.yjs.dev/api/undo-manager) · Automerge (git-like change DAG): [`https://automerge.org/docs/reference/glossary/`](https://automerge.org/docs/reference/glossary/) · Ink & Switch Patchwork (branches + named milestones over one history): [`https://www.inkandswitch.com/patchwork/`](https://www.inkandswitch.com/patchwork/).

**Siblings:** [`03-data-model.md`](./03-data-model.md) · [`07-undo-tree.md`](./07-undo-tree.md) · [`10-sync-persistence.md`](./10-sync-persistence.md) · plan: [`../plan/phase-4-history.md`](../plan/phase-4-history.md).
