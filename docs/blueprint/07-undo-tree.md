# 07 — Undo Tree

> **Scope.** This file specifies Recto's **branching undo tree** (locked decision **D8**): a cloud-persisted, append-only DAG of edit states that replaces linear undo/redo. It is self-contained. Where it touches sibling areas it cross-references them by exact filename: the canonical model and patch/snapshot storage live in [`03-data-model.md`](./03-data-model.md); the live two-editor sync that the tree re-projects into lives in [`05-lossless-bridge.md`](./05-lossless-bridge.md); the debounced Convex sync and concurrency model live in [`10-sync-persistence.md`](./10-sync-persistence.md); the durable tagged-version layer that *shares this same store* lives in [`08-version-control.md`](./08-version-control.md). The implementation order is [`../plan/phase-0-spikes.md`](../plan/phase-0-spikes.md) (spike) then [`../plan/phase-4-history.md`](../plan/phase-4-history.md) (product UI).
>
> If anything here contradicts [`README.md`](./README.md), the README wins.

---

## 1. Why linear undo is insufficient

Every mainstream editor ships **linear** undo: a single stack with one cursor. You press undo to walk backwards, redo to walk forwards. The defining flaw is what happens when you **undo and then type**:

```
edit A → edit B → edit C        (you are at C)
undo, undo                      (you walk back to A)
type edit D                     (you make a new edit)

linear result:  A → D           ← B and C are GONE, permanently
```

The moment you make a new edit after undoing, the redo path (`B`, `C`) is **discarded**. This is not a UI nicety we can paper over — it is the data model of every linear history: there is exactly one "future" per state, so a new edit overwrites it.

For Recto this is unacceptable. The product promise (see [`README.md`](./README.md) §4, *"Never lose a word"*) is that **no past state of a document is ever unreachable**. A writer who drafts a paragraph three ways must be able to recover the first way after committing to the third. Linear undo cannot express "I have two competing futures from this point."

### 1.1 What a branching undo tree is

A **branching undo tree** keeps *every* state reachable. Instead of discarding the redo path when you edit after undoing, it preserves it as a **sibling branch**:

```
            ┌── B ── C            ← the original branch (still reachable)
   A ───────┤
            └── D                 ← the new branch you created by editing after undo

current pointer → D
```

Undoing from `D` returns to `A`. From `A` you may redo *forward* — and because `A` now has **two children**, redo is a **choice**: walk into the `B`–`C` branch, or back into `D`. Navigating the tree, not a stack, is undo/redo.

This is the model used by **Vim's native undo tree** (`:earlier`, `:later`, `g-`, `g+`) and **Emacs `undo-tree`** / the **[undotree](https://github.com/mbbill/undotree)** plugin. Reference: [`https://vimhelp.org/undo.txt.html`](https://vimhelp.org/undo.txt.html). The mental model Recto adopts wholesale: a new edit after undo creates a **new branch instead of destroying the redo path**, and you can reach every past state by walking the DAG.

---

## 2. Why we must build it ourselves

We cannot get a branching tree from the editor engines. **Both** of Recto's engines ship a **linear** history, and the Vim layer just delegates to the linear one. These are facts, not assumptions:

| Engine / package | History it provides | Behaviour after "undo then edit" |
|------------------|---------------------|----------------------------------|
| **prosemirror-history** (under Milkdown — the rich-text engine) | Linear undo/redo. Default `depth: 100`, `newGroupDelay: 500ms`. | New edit after undo **discards** the redo stack. Ref: [`https://github.com/ProseMirror/prosemirror-history`](https://github.com/ProseMirror/prosemirror-history) |
| **@codemirror/commands** `history` (under CodeMirror 6 — raw + Vim) | Linear undo/redo. `minDepth: 100`, `newGroupDelay: 500ms`, `isolateHistory` annotation to force group boundaries. | New edit after undo **discards** the redo stack. Ref: [`https://github.com/codemirror/commands/blob/main/src/history.ts`](https://github.com/codemirror/commands/blob/main/src/history.ts) |
| **@replit/codemirror-vim** | No history of its own. Maps `u` → CM6 `undo` and `Ctrl-r` → CM6 `redo`. | Inherits CM6's linear behaviour. **No undotree, no `:undolist`, no `g-`/`g+`, no `:earlier`/`:later`.** Ref: [`https://github.com/replit/codemirror-vim`](https://github.com/replit/codemirror-vim) |

So `@replit/codemirror-vim` exposes Vim's *keystrokes* for undo but **not** Vim's *undo tree*. The native Vim tree commands `g-`/`g+` and `:earlier`/`:later` ([`https://vimhelp.org/undo.txt.html`](https://vimhelp.org/undo.txt.html)) simply do not exist in the package. To deliver the branching behaviour the product promises, Recto must own the history itself.

There is a second, deeper reason. Recto edits **one canonical document through up to four lenses** ([`README.md`](./README.md) §1–2, D2, D6). If each editor kept its own linear history, we would have **three competing histories** (prosemirror-history in the rich editor, CM history in the raw editor, CM history again in the Vim editor) over a single document, plus a fourth notion of "undo" the user actually wants. They would disagree on grouping, depth, and what "the previous state" even means after a cross-mode edit. The only coherent design is **one history, above the editors, at the canonical-model level**.

---

## 3. The model-level design

> **Principle.** History is owned **above** the editor engines, at the **canonical-model** level. The unit of history is a change to the canonical Markdown / MDAST (see [`03-data-model.md`](./03-data-model.md)), not a ProseMirror step or a CodeMirror transaction.

Each grouped change is an **immutable node** in a DAG. The DAG is the canon `docNodes` table; the active node is the canon `documents.currentNodeId` pointer. These names are fixed by [`README.md`](./README.md) §7 and must be used verbatim everywhere.

### 3.1 The `docNodes` node (canon schema)

```ts
// docNodes — append-only branching undo-tree DAG; nodes are IMMUTABLE.
// Canonical contract from README.md §7 — do not rename fields.
docNodes: {
  documentId: Id<"documents">,
  nodeId: string,                 // client-generated ULID; globally unique
  parentNodeId: string | null,    // null only for the document's root node
  patch: string,                  // compact delta of canonical Markdown vs the parent node's materialized state
  snapshot?: string,              // OCCASIONAL full Markdown snapshot, for fast materialization (see §6, and 03-data-model.md)
  selection: { anchor: number, head: number } | null, // caret/range to restore when this node becomes current
  origin: string,                 // device/client id that created the node
  createdAt: number,
}
// indexes: by_document (documentId), by_document_node (documentId, nodeId)
```

And the pointer:

```ts
// documents.currentNodeId — the active node of the undo tree for this document.
// Last-write-wins across devices (see §7). Always references a docNodes.nodeId of the same documentId.
documents: {
  /* …title, markdown, wordCount, … */
  currentNodeId: string,          // pointer INTO the docNodes DAG
}
```

Key invariants:

- **Immutable + append-only.** A node, once written, is never mutated or deleted as part of normal editing. Editing always *appends* a new node. (Retention pruning, §8, is the only deletion, and it is a background, branch-level operation — never an in-place edit of a node's content.)
- **`nodeId` is a client-generated ULID.** ULIDs are lexicographically sortable by creation time and globally unique, so two devices generating nodes offline will never collide and will sort sensibly. We use `crypto.randomUUID()`/ULID per the stack table in [`README.md`](./README.md) §6 — no extra dependency.
- **The DAG is in fact a tree** for a single document: each node has exactly one `parentNodeId`. (We retain the term "DAG" from the README; in practice it is a rooted tree with potential multiple children per node — branches.)
- **`patch` is relative to the parent's materialized state**, not to an absolute base. This is what makes union-merge across devices conflict-free (§7).

### 3.2 The DAG, concretely

```
                                          (each box = one immutable docNodes row)
   ┌─────────┐
   │  root   │  parentNodeId: null, snapshot: "" (empty doc)
   └────┬────┘
        │ patch
   ┌────▼────┐
   │  n1     │  "wrote opening paragraph"
   └────┬────┘
        │
   ┌────▼────┐
   │  n2     │  "added a heading"            ← branch point
   └──┬───┬──┘
      │   │
 ┌────▼┐ ┌▼─────┐
 │ n3  │ │ n4   │  ← user undid to n2, then edited a different way → new branch
 └──┬──┘ └──────┘
    │
 ┌──▼──┐
 │ n5  │  snapshot stored here (periodic full Markdown, see §6)
 └─────┘
        ▲
        └── documents.currentNodeId === "n5"   (the active state)
```

---

## 4. Grouping heuristic

If every keystroke were its own node, the tree would be enormous, the visualizer unreadable, and storage wasteful. We **coalesce** keystrokes into sensible nodes using a **time-gap + adjacency** rule, deliberately mirroring the engines' `newGroupDelay` default of **500 ms** (see §2 table) so undo granularity feels familiar:

> **A new node is *not* committed for every change. Pending changes coalesce into the current draft node, and a node boundary is committed when *any* of these fire:**
>
> 1. **Time gap** — more than ~**500 ms** elapses since the last change (a typing pause).
> 2. **Adjacency break** — the new change is not contiguous with the previous one (the caret jumped, or the edit is in a different region of the document).
> 3. **Structural / semantic boundary** — a "significant" change: paste, a block-structure change (heading, list, table, fenced code), a mode switch, or an explicit isolate signal (the model-level analogue of CodeMirror's `isolateHistory` annotation).
> 4. **Selection-only moves never create nodes.** Moving the caret without changing text updates the *pending* `selection` but does not commit a node.

```
keystrokes:   h e l l o   ·500ms·   w o r l d   [paste image]   p e r i o d .
              └─────────┘            └─────────┘  └───────────┘  └──────────┘
              node n+1               node n+2     node n+3       node n+4
              (coalesced)            (gap break)  (paste = sig)  (gap/adjacency)
```

The grouping policy lives **once**, at the model level, and is the single source of "what counts as one undo step" for *all* lenses. A burst of typing in the rich editor and the same burst in the Vim editor coalesce by the same rule, so undo granularity is consistent across modes.

---

## 5. Navigation = undo / redo / branch-switch

In a tree, "undo", "redo", and "switch branch" are the same operation: **move `documents.currentNodeId` to a different node and materialize that state.**

| User action | Pointer move |
|-------------|--------------|
| **Undo** (`u`) | move to `parentNodeId` |
| **Redo** (`Ctrl-r`) | move to a child of the current node — if there are several children, the **most recently created** one by default (Vim's behaviour), with branch-switch UI to pick another |
| **Switch branch** | move to *any* node in the tree (sibling, distant ancestor/descendant) — chosen from the visualizer (§9) |
| **Restore a version** | handled by [`08-version-control.md`](./08-version-control.md) — *not* a pointer move into existing history; it **forks forward** by appending a new node. Do not conflate it with branch-switch. |

### 5.1 Materializing a node's state

To make a node current, we must reconstruct its canonical Markdown. Because `patch` is a delta versus the parent, we **replay patches from the nearest ancestor snapshot**:

```
materialize(targetNode):
  1. Walk parentNodeId links upward from targetNode until a node with a `snapshot` is found.
  2. Start from that snapshot's full Markdown.
  3. Replay each `patch` forward, down the ancestry chain, to targetNode.
  4. Result = the canonical Markdown at targetNode.
```

This is the same patch/snapshot replay defined in [`03-data-model.md`](./03-data-model.md); §6 below describes the snapshot cadence that bounds the replay length. The full algorithm and patch format are owned by that file — this file only specifies *when* materialization runs (on every pointer move) and *what must happen after* (re-projection, §5.2).

```ts
/** Move the undo pointer and re-project the result into both live editors. */
async function navigateTo(documentId: Id<"documents">, nodeId: string): Promise<void> {
  const node = await getNode(documentId, nodeId);           // by_document_node index
  const markdown = await materialize(node);                 // replay from nearest snapshot (03-data-model.md)

  // 1) Update the canonical in-memory model (the MDAST bus — see 05-lossless-bridge.md).
  setCanonicalMarkdown(markdown);

  // 2) Move the pointer (debounced, last-write-wins persistence — see 10-sync-persistence.md).
  updateCurrentNodeId(documentId, nodeId);

  // 3) Restore the caret/selection captured on the node.
  if (node.selection) restoreSelectionAcrossLenses(node.selection);
}
```

### 5.2 Re-projecting into BOTH editor engines

A pointer move changes the canonical model, so **every open lens of this document must re-render from it** — this is exactly the canonical-model spine of Recto ([`README.md`](./README.md) §2). The re-projection goes through the **MDAST bus** described in [`05-lossless-bridge.md`](./05-lossless-bridge.md):

- The **rich editor (Milkdown)** receives the new MDAST and updates its ProseMirror document via the doc-diff → steps path (`prosemirror-recreate-steps`, per [`README.md`](./README.md) §6) so the cursor is preserved where possible — and then overridden by the node's restored `selection`.
- The **raw / Vim editor (CodeMirror 6)** receives the new Markdown string and updates its document; the node's `selection` (`{ anchor, head }`, document offsets) restores the caret.
- The **preview** simply re-renders the MDAST.

Per-node `selection` is what makes undo feel correct: undoing to a node returns not only the text but the caret to where it was when that state existed. Selection offsets are stored as canonical-Markdown document offsets and mapped into each lens by the bridge ([`05-lossless-bridge.md`](./05-lossless-bridge.md)).

> If two lenses of the same document are open at once (D6), **both** re-project from the single pointer move. There is one pointer per document, never one per pane.

---

## 6. Bypassing the engine histories

Because we own history at the model level (§2–3), the engines' own histories must be **prevented from competing**. Within the tree's scope:

- **prosemirror-history is disabled / short-circuited** in the Milkdown instance. We do not load the default history keymap; `Mod-z` / `Mod-Shift-z` are routed to the model-level tree, not to ProseMirror's `undo`/`redo`. (We may keep the history *transaction grouping* machinery as a convenience for detecting boundaries, but its undo/redo *commands* are not user-reachable.)
- **@codemirror/commands `history` is removed or neutralized** in the raw/Vim CodeMirror instance — we do not install the `history()` extension's keymap as the user-facing undo, and we treat its stacks as non-authoritative. Edits flow out to the MDAST bus, which is what the model-level grouping (§4) consumes.
- **Vim `u` / `Ctrl-r`** (`@replit/codemirror-vim`) are intercepted and **re-bound to the model-level tree's undo/redo** rather than CM6's linear undo. The keymap precedence is documented in [`13-keyboard-commands.md`](./13-keyboard-commands.md).

The result: there is exactly **one** authoritative history — the tree — and three things route into it (rich keymap, CM keymap, Vim keymap) plus the visualizer UI (§9). No mode can present a divergent undo state.

```
        ┌───────────────────────────────────────────────┐
        │            Model-level undo tree                │
        │      (docNodes DAG + documents.currentNodeId)   │   ← THE ONE history
        └───────────────────────────────────────────────┘
              ▲            ▲            ▲            ▲
   route u/^R │   route    │   route    │   click   │
   & tree nav │   Mod-z    │   Mod-z    │   jump     │
        ┌─────┴────┐ ┌─────┴────┐ ┌─────┴────┐ ┌─────┴──────┐
        │ Vim keys │ │ Milkdown │ │ CM raw   │ │ Visualizer │
        │ (CM-vim) │ │ keymap   │ │ keymap   │ │   UI (§9)  │
        └──────────┘ └──────────┘ └──────────┘ └────────────┘

  ✗ prosemirror-history undo/redo  ✗ @codemirror/commands history undo/redo  (short-circuited)
```

---

## 7. Cloud persistence and why it's tractable (D8)

D8 requires the tree to be **cloud-persisted as an append-only DAG**, synced across devices. The reason this is tractable — and the reason the README calls it one of "the three hard parts" that is nonetheless solvable — is the data shape:

> **`docNodes` are append-only and immutable. Therefore two devices' node sets `UNION-MERGE` with zero conflict.** There is no "edit the same node two ways" case, because nodes are never edited. The only mutable piece is the single `documents.currentNodeId` pointer, which is **last-write-wins**.

### 7.1 Cross-device reconciliation

Consider device **A** and device **B**, both editing document `D`, possibly offline:

```
shared history before divergence:        root → n1 → n2

Device A (offline) appends:              n2 → a3 → a4     (currentNodeId = a4)
Device B (offline) appends:              n2 → b3         (currentNodeId = b3)

On sync, the server's docNodes for D becomes the UNION:

                       ┌── a3 ── a4        (from A)
   root ── n1 ── n2 ───┤
                       └── b3              (from B)

No conflict: a3/a4/b3 have distinct ULIDs and distinct parentNodeId chains.
The tree simply gained a branch — exactly the branching model from §1.
```

- **Nodes:** because every `nodeId` is a globally unique ULID and every node is immutable, the merge is a **set union** of rows under `by_document`. Convex stores each node as a **separate row** ([`README.md`](./README.md) §7 hard constraint: *"store history as separate rows, never an embedded array"*), so two devices inserting different nodes never write the same row — there is nothing to conflict on.
- **Pointer:** `documents.currentNodeId` is a single field; it is reconciled **last-write-wins** by `updatedAt`, consistent with the debounced LWW snapshot model in [`10-sync-persistence.md`](./10-sync-persistence.md). A device that synced "behind" sees its local pointer overwritten by the more recent one, but **loses no history** — every node it created is still in the union, reachable via the visualizer.
- **Worst case** of a lost pointer write is recoverable: the durable version layer ([`08-version-control.md`](./08-version-control.md)) is the explicit safety net, and any abandoned-but-not-pruned node is still navigable.

This is precisely why the README front-loads the undo tree as a Phase 0 spike ([`../plan/phase-0-spikes.md`](../plan/phase-0-spikes.md)): to prove union-merge + LWW-pointer behaves under offline divergence before any UI is built on it. The merge/persistence tests are non-negotiable per [`../plan/README.md`](../plan/README.md) §Conventions.

> **Contrast with CRDTs.** We deliberately do **not** use Yjs / prosemirror-sync / a CRDT for history (D10). We don't need character-level merge of concurrent edits — Recto is single-user, and the append-only immutable shape already gives conflict-free history merge for free. [`08-version-control.md`](./08-version-control.md) §3 expands the broader rationale (Automerge's git-like change DAG, Yjs's separate two-stack UndoManager) and why durable versions stay separate from this fine-grained tree.

---

## 8. Memory and retention

Append-only growth must be bounded, but never at the cost of the product promise. The policy (the README risk-register fallback for "Cloud undo-tree storage growth"):

1. **Keep all recent nodes** — a generous recency window so normal undo is always available in full fidelity.
2. **Keep every tagged node forever** — any `docNodes.nodeId` referenced by a row in the `versions` table ([`08-version-control.md`](./08-version-control.md)) is **pinned** and never pruned, along with its ancestor chain back to a snapshot (so it stays materializable).
3. **Prune deep, abandoned branches** — branches that are old, not on the path to the current node, and contain no tagged node are candidates for pruning. Pruning removes whole sub-branches as a background operation; it never mutates a surviving node.
4. **Delta-encode with periodic snapshots** — `patch` holds a compact delta vs parent; every *N* nodes (or when a delta chain grows long) a node also stores a full `snapshot` so materialization (§5.1) never replays an unbounded chain. Snapshot cadence and the patch/delta format are owned by [`03-data-model.md`](./03-data-model.md); pruning must never orphan a node from its nearest snapshot.

```
retention sketch:

   [pinned by a version] ──╮
   root ─ … ─ n40 ─ n41 ─ ★n42(tagged) ─ n43 ─ … ─ n90 (recent window, kept)
            │
            └─ old abandoned branch  c1 ─ c2 ─ c3   ← no tag, not on current path, old
                                     └──────────────┘ PRUNE candidate
```

Pruning respects the ~1 MiB-per-value Convex ceiling indirectly: history is in separate rows, so the *document* never bloats; pruning bounds the *number of rows*, not a single value's size.

---

## 9. The visualizer UI

The undo tree is only as good as the user's ability to see and reach it. The visualizer is the product surface (built in [`../plan/phase-4-history.md`](../plan/phase-4-history.md)):

```
 ┌─ Undo tree ───────────────────────────────┐
 │                                            │
 │   ● root                                   │
 │   │                                        │
 │   ● n1   "opening paragraph"               │
 │   │                                        │
 │   ◍ n2   "added heading"      ← branch pt  │
 │   ├───────────────┐                        │
 │   ● n3            ● n4  (other branch)     │
 │   │                                        │
 │   ★ n5  ◀ CURRENT   [tagged: "draft v1"]   │
 │                                            │
 │  hover any node → preview that state       │
 │  click any node → jump (navigateTo, §5)    │
 └────────────────────────────────────────────┘

  legend:  ★ current node   [tag] tagged (a version, see 08)   ◍ branch point
```

Behaviours:

- **Tree view of nodes and branches.** A vertical/indented tree (Vim-`undotree`-style) showing parent→child structure and every branch. Each node shows its `createdAt` and a short label derived from its change (the same "significant change" classification from §4 names them: *"paste"*, *"added heading"*, *"typing"*).
- **Hover-to-preview.** Hovering a node materializes its state (§5.1) into a lightweight read-only preview without moving the pointer — so you can scan branches before committing.
- **Click-to-jump.** Clicking a node calls `navigateTo` (§5): it moves `documents.currentNodeId` and re-projects into both editors (§5.2). This is the GUI equivalent of Vim's `g-`/`g+`/`:earlier`/`:later` that `@replit/codemirror-vim` does not provide (§2).
- **Marking.** The **current node** (`documents.currentNodeId`) is highlighted distinctly. **Tagged nodes** — those referenced by a `versions` row ([`08-version-control.md`](./08-version-control.md)) — are badged with their version label, visually distinguishing durable versions from ordinary history.

The visualizer reads the DAG via the `by_document` index and the pointer from `documents.currentNodeId`; it never writes a node directly — all writes go through the debounced model-level mutations described in [`10-sync-persistence.md`](./10-sync-persistence.md).

---

## 10. Relationship to versions (one store, two semantics)

The undo tree and the tagged-version layer **share the same append-only `docNodes` store**, but they have **distinct semantics** and must not be unified into one object:

- **Undo tree (this file):** *navigate* the DAG. Undo/redo/branch-switch move `documents.currentNodeId` to an existing node. Fine-grained, keystroke-coalesced, prunable.
- **Versions ([`08-version-control.md`](./08-version-control.md)):** *fork forward*. Restoring a version **appends a new node** equal to the version's state and moves the pointer there — it never rewinds or destroys history. Versions are coarse, named, durable, and pin their nodes against pruning (§8).

This separation mirrors every shipping tool (Figma, Notion, Google Docs, Obsidian, Yjs) — fine-grained undo is always kept separate from durable named versions, and restore is always additive. See [`08-version-control.md`](./08-version-control.md) §3 for the full argument and citations.

---

## 11. Summary

| Concern | Decision |
|---------|----------|
| History granularity | Branching tree, not linear stack — every past state reachable (D8) |
| Where history lives | Above the editors, at the canonical-model level — **one** history |
| Storage | Canon `docNodes` table: append-only, immutable nodes; `parentNodeId` forms the tree; `patch` + occasional `snapshot` |
| Active state | `documents.currentNodeId` pointer (LWW across devices) |
| Grouping | ~500 ms time-gap + adjacency + structural-boundary coalescing (mirrors engines' `newGroupDelay`) |
| Engine histories | prosemirror-history & @codemirror/commands history short-circuited; Vim `u`/`Ctrl-r` re-bound to the tree |
| Cross-device merge | Union of immutable nodes (zero conflict) + LWW pointer |
| Retention | Keep recent + all tagged; prune deep abandoned branches; delta-encode with periodic snapshots |
| UI | Tree visualizer: hover-preview, click-to-jump, current + tagged markers |

**References.** prosemirror-history: [`https://github.com/ProseMirror/prosemirror-history`](https://github.com/ProseMirror/prosemirror-history) · CodeMirror commands history source: [`https://github.com/codemirror/commands/blob/main/src/history.ts`](https://github.com/codemirror/commands/blob/main/src/history.ts) · replit codemirror-vim: [`https://github.com/replit/codemirror-vim`](https://github.com/replit/codemirror-vim) · Vim undo: [`https://vimhelp.org/undo.txt.html`](https://vimhelp.org/undo.txt.html) · undotree: [`https://github.com/mbbill/undotree`](https://github.com/mbbill/undotree).

**Siblings:** [`03-data-model.md`](./03-data-model.md) · [`05-lossless-bridge.md`](./05-lossless-bridge.md) · [`08-version-control.md`](./08-version-control.md) · [`10-sync-persistence.md`](./10-sync-persistence.md) · [`13-keyboard-commands.md`](./13-keyboard-commands.md) · plan: [`../plan/phase-0-spikes.md`](../plan/phase-0-spikes.md), [`../plan/phase-4-history.md`](../plan/phase-4-history.md).
