# Phase 4 — History

> **Self-contained build-plan phase.** This file is the execution spec for Recto's **branching undo tree** and its **tagged version control**. It restates everything an implementer needs and cross-references the canon by relative path. Canon wins on contradiction: read [`../blueprint/README.md`](../blueprint/README.md) for the locked decisions (D1–D15), the canonical Convex schema, and the glossary. The two areas this phase productizes are specified in full in [`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md) (undo tree) and [`../blueprint/08-version-control.md`](../blueprint/08-version-control.md) (versions); the storage strategy and Convex function surface are in [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md); the sync/concurrency model is in [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md); the re-projection bus is in [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md).
>
> **Canonical names used verbatim throughout** (do not rename): the `docNodes` table; the `versions` table; the `documents.currentNodeId` pointer; node fields `nodeId`, `parentNodeId`, `patch`, `snapshot`, `selection`, `origin`, `createdAt`; version fields `nodeId`, `label`, `kind` (`"auto"` | `"manual"`).

---

## Goal

Turn the Phase 0 undo-DAG spike into the shipped **History** surface:

1. **Branching undo tree** — productize the append-only, immutable `docNodes` DAG. Every grouped edit appends one immutable node (`patch` delta + per-node `selection` + `origin`); `documents.currentNodeId` is the single pointer. Undo / redo / branch-switch are pointer moves that re-project the materialized state into **both** live editor engines. The engines' own histories are bypassed within the tree's scope so there is exactly one source of history. Includes an undo-tree **visualizer** (tree view, current + tagged markers, hover-to-preview, click-to-jump).
2. **Tagged version control** — the `versions` table referencing `docNodes` `nodeId`s: `auto` snapshots (interval + significant-change) and `manual` named tags; **additive** restore (restore appends a new node/branch and moves the pointer, never destroys); compare/diff of two materialized states; a version-history UI (list, tag, restore, compare, rename, delete-tag).
3. **Cross-device / debounce-clobber safety net** — append-only nodes **union-merge** with zero conflict; the pointer is **last-write-wins (LWW)**; versions are the explicit recovery path when an LWW write races (tie to [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md)).

This phase delivers the History UX on top of mechanisms already proven in Phase 0. It does **not** re-prove union-merge from scratch — it productizes the proven approach.

---

## Why now / prerequisites

Per [`./README.md`](./README.md), phases are sequential and dependency-ordered. History comes last before polish because it sits *on top of* a syncing editor, all four lossless modes, and the multi-doc/split workspace.

**Done before starting (hard prerequisites):**

- **Phase 0 — Spikes** ([`./phase-0-spikes.md`](./phase-0-spikes.md)): the cloud undo-tree DAG was spiked and the approach was **decided** — append-only immutable `docNodes`, `patch` delta + periodic `snapshot`, ULID `nodeId`, union-merge of node sets, LWW `documents.currentNodeId`. The materialization replay (walk to nearest `snapshot`, replay `patch`es forward) and the offline-divergence merge were validated as a throwaway. Phase 4 hardens that into product code. The live two-mode bridge ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md)) was also spiked and is relied on for re-projection.
- **Phase 1 — Foundation** ([`./phase-1-foundation.md`](./phase-1-foundation.md)): Next.js + Convex + Better Auth shell; the `documents` table; one rich-text surface that syncs and never loses words; debounced `documents.updateMarkdown` on the idle path (never the typing hot path); `crypto.randomUUID()`/ULID id generation; live word count (D15).
- **Phase 2 — Modes & losslessness** ([`./phase-2-modes-and-losslessness.md`](./phase-2-modes-and-losslessness.md)): all four lenses (rich/Milkdown, raw Markdown/CodeMirror 6, Vim/`@replit/codemirror-vim`, preview); lossless mode switching over the **MDAST bus**; the full GFM + footnotes + frontmatter dialect with round-trip tests. The "significant change" / structural-boundary classification used for undo grouping (§4 of [`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md)) is available here.
- **Phase 3 — Multi-doc, split & workspace** ([`./phase-3-multi-doc-split-workspace.md`](./phase-3-multi-doc-split-workspace.md)): document switcher; nested split panes; **same document open in two live editable modes at once** (D6); workspace persistence and cross-device resume. This matters because there is **one pointer per document, never one per pane** — a pointer move must re-project into *every* open lens of that document (§5.2 of [`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md)).

**Decided in Phase 0 (carry forward, do not re-litigate):** delta-encoded `patch` with periodic full `snapshot`; ULID node identity for offline/optimistic creation without a server round-trip; union-merge for nodes; LWW for the single pointer; no Yjs / `prosemirror-sync` / CRDT (D10).

---

## In scope

- **Model-level undo tree** (one history above the editors), consuming the MDAST bus, owning grouping, materialization, navigation, and re-projection.
- **Grouping heuristic**: ~500 ms time-gap + adjacency-break + structural/semantic boundary; selection-only moves never commit a node.
- **Engine-history bypass** within the tree's scope: short-circuit `prosemirror-history` (Milkdown) and `@codemirror/commands` `history` (raw/Vim); re-bind Vim `u` / `Ctrl-r` and `Mod-z` / `Mod-Shift-z` to the model-level tree.
- **Navigation** = undo / redo / branch-switch as pointer moves; materialize via nearest-snapshot replay; re-project into both editor engines + preview; restore caret from per-node `selection`.
- **Cloud persistence + cross-device**: append-only `docNodes.append` (idempotent on `(documentId, nodeId)`); union-merge via `docNodes.listSince`; LWW pointer via the debounced `currentNodeId` write; retention (keep recent + all tagged + live spine; prune deep abandoned branches) as a scheduled batched sweep.
- **Undo-tree visualizer UI**: indented tree of nodes/branches; current-node marker; tagged-node badges; hover-to-preview (read-only materialize, no pointer move); click-to-jump (`navigateTo`).
- **Versions**: `versions` table wired up; `auto` snapshots (interval + significant-change) and `manual` named tags; **additive** restore; compare/diff (text diff of two materialized Markdown states); version-history UI (list / tag / restore / compare / rename / delete-tag).
- **Safety-net wiring**: versions as the recovery path for the accepted debounced-LWW race; steady `auto` cadence to narrow the loss window; stale-version guard interplay.
- **Tests**: persistence/merge tests for the DAG (union-merge under offline divergence; LWW pointer); additive-restore non-destructiveness; materialization correctness; auto-snapshot dedupe.

## Out of scope

- **Export / clipboard** (copy html+plain, copy-as-markdown, export `.md`/`.html`) — Phase 5 ([`./phase-5-polish-and-export.md`](./phase-5-polish-and-export.md), [`../blueprint/11-clipboard-export.md`](../blueprint/11-clipboard-export.md)). *Diff/compare here renders in-app only; it does not export a diff artifact.*
- **Final design polish** — the bespoke typography/motion pass for the History panels is Phase 5 ([`../blueprint/12-design-system.md`](../blueprint/12-design-system.md)). Phase 4 ships functional, on-palette panels using existing primitives, not the finished visual design.
- **The lossless bridge and dialect themselves** — owned by Phases 0/2; consumed, not built, here.
- **Multi-doc / split / workspace mechanics** — owned by Phase 3; History assumes them.
- **Book-length manuscripts beyond Convex's ~1 MiB document ceiling** — non-goal ([`../blueprint/README.md`](../blueprint/README.md) §5).
- **CRDT / character-level concurrent merge** — explicitly rejected (D10); union-merge + LWW is the model.

---

## Work breakdown (grouped)

### A. Convex data-model & function surface (server)

The schema fields already exist from earlier phases ([`../blueprint/03-data-model.md`](../blueprint/03-data-model.md) §2). Phase 4 implements / completes the function modules that read and write `docNodes` and `versions`.

- **A1 — `docNodes.append` (mutation).** Insert one immutable node `{ documentId, nodeId, parentNodeId, patch, snapshot?, selection, origin }`. **Idempotent on `(documentId, nodeId)`** via `by_document_node`: if the node already exists (retry, or a cross-device union re-send), it is a **no-op** — existing nodes are NEVER updated (append-only, D8). Never write `currentNodeId` here; the pointer is a separate write (A4).
- **A2 — `docNodes.listSince` (query).** Read nodes for a document via `by_document`; with `sinceCreatedAt`, return only newer nodes for incremental cross-device union-merge. Powers initial DAG hydration and incremental merge; the visualizer reads from the hydrated client DAG, not by re-querying per node.
- **A3 — `docNodes.getSnapshotAt` (query).** Server-side materialization: walk `parentNodeId` back to the nearest `snapshot`, replay `patch`es forward (§4.3 of [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md)), return `{ markdown, nodeId }`. Used by version preview/restore and undo-jump so a single historical state never ships the whole DAG.
- **A4 — pointer write.** Move `documents.currentNodeId` on the debounced/idle path (LWW, stamped by `updatedAt`). Co-locate with the existing `documents.updateMarkdown` write rhythm where the materialized markdown is also persisted (see [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md)); keep the *append-a-node* rhythm distinct from the *save-the-text* rhythm (§4 of [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md)).
- **A5 — `versions.create` / `versions.list` / `versions.restore` / `versions.remove`.** Per [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md) §3.3. `restore` is **additive** (see C-group). `remove` untags only — never deletes the underlying `docNodes` node. `list` uses `by_document`, newest first, exposing `label`, `createdAt`, `kind`.
- **A6 — retention sweep (scheduled, batched).** Implement the prune policy as a Convex scheduled/cron job, **never** inside an interactive mutation. A node is **kept** if any of: tagged (referenced by a `versions.nodeId`), on the live spine (`currentNodeId` or an ancestor), recent (within the recency window), or an ancestor of a kept node (so its snapshot chain stays intact). Eligible for pruning only when a **deep, abandoned** branch: reachable from neither the spine nor any tag, and older than the window. Prune whole subtrees; never orphan a snapshot a survivor depends on; never rewrite a surviving node. Batch deletes under the per-transaction budget. (See §8 of [`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md), §6 of [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md).)

### B. Model-level undo tree (client)

- **B1 — patch/snapshot codec.** Implement `applyPatch(parentMarkdown, patch) === thisMarkdown` exactly, and the inverse encode (delta of this state's canonical Markdown vs the parent's materialized state). Use a battle-tested text-diff/patch library (see Libraries). Periodic full `snapshot` on the root node and every Nth node along a branch (tunable cadence, e.g. every ~50 nodes) to bound replay.
- **B2 — client-side DAG + materialize.** Hydrate the DAG via `docNodes.listSince`; reconstruct the per-document tree (each node one `parentNodeId`). `materialize(targetNode)`: walk up to the nearest `snapshot`, replay forward (mirror of A3 for client-side hover-preview without a round-trip).
- **B3 — grouping engine.** Consume change events from the MDAST bus. Coalesce into the current draft node; commit a node boundary when **any** fire: (1) >~500 ms since last change; (2) adjacency break (caret jump / different region); (3) structural/semantic boundary — paste, block-structure change (heading/list/table/fenced code), mode switch, or an explicit isolate signal (the model-level analogue of CodeMirror's `isolateHistory`). **Selection-only moves update the pending `selection` but never commit a node.** One policy, one place, for all lenses — typing bursts in rich and in Vim coalesce identically.
- **B4 — node label derivation.** From the grouping classification, derive a short human label per node (`"typing"`, `"paste"`, `"added heading"`, …) for the visualizer. Reuse the same "significant change" classification the version layer's significant-change trigger uses (C2), so both layers agree on "significant."
- **B5 — `navigateTo(documentId, nodeId)`.** The one navigation entry point: materialize → `setCanonicalMarkdown` (MDAST bus) → debounced LWW pointer write (A4) → restore `selection` across lenses. Used by undo, redo, branch-switch, and the visualizer's click-to-jump.
- **B6 — undo / redo / branch-switch semantics.** Undo = move to `parentNodeId`. Redo = move to a child; if several children, the **most recently created** by default (Vim behaviour), with branch-switch UI to choose another. Branch-switch = move to any node. All three are `navigateTo` calls. **Restore is NOT here** — it forks forward (C3), not a pointer move into existing history; do not conflate them.

### C. Versions layer (client)

- **C1 — manual tag.** "Tag current version" → prompt for `label` → `versions.create({ kind: "manual", nodeId: currentNodeId, label })`. Pins that node against pruning. Rename edits `label` in place (the only in-place version mutation). Delete-tag removes the row only.
- **C2 — auto-snapshot policy.** Two complementary triggers on the **idle/persistence path** (never the typing hot path): (1) **interval** — periodic cadence during active editing; **skip if nothing changed since the last auto version** (no duplicate tags for an idle doc); (2) **significant-change** — large paste, bulk delete, mode switch producing a substantial edit, or a word-count delta past threshold. Each creates an `auto` version pointing at the **current** `nodeId` (pins it; appends **no** new node). Thin old `auto` versions over time (e.g. hourly → daily → weekly buckets); keep all `manual` forever.
- **C3 — additive restore.** `restoreVersion`: `materialize(version.nodeId)` → **append a NEW node whose `parentNodeId` is the current tip** (fork forward) with that materialized markdown as `patch` (+ `snapshot` per cadence), `selection: null`, `origin: thisDeviceId` → advance `currentNodeId` to the new node → re-project into all lenses. The old `n4…n7` chain and the original tagged node stay reachable; undo from the new node walks back through them. UI must state restore does not erase later edits.
- **C4 — compare / diff.** `compare(versionA, versionB)`: materialize both Markdown states (A3/B2), render a **line/word-level text diff of the canonical Markdown strings** (D1) — not rendered HTML, not a lens representation. Read-only: never moves the pointer, never appends. "Restore the left one" routes through C3.

### D. UI surfaces

- **D1 — undo-tree visualizer.** Vertical/indented tree (Vim-`undotree`-style) of nodes and branches showing parent→child structure and every branch. Each node shows `createdAt` and its derived label (B4). **Current node** (`documents.currentNodeId`) highlighted distinctly; **tagged nodes** (referenced by a `versions` row) badged with their `label`. **Hover-to-preview** materializes a node into a lightweight read-only preview *without* moving the pointer. **Click-to-jump** calls `navigateTo` (B5). Reads the DAG from the hydrated client state + the pointer; **never writes a node directly** — all writes go through the debounced model-level mutations.
- **D2 — version-history panel.** List (newest first via `by_document`) showing `label`, `createdAt`, and an `auto`/`manual` badge. Actions: **Tag current version** (C1), **Restore** (C3, with explicit "does not erase later edits" copy), **Compare with…** (C4), **Rename** (manual only), **Delete tag** (C1; `manual` never auto-deleted). All writes on the debounced/idle path.
- **D3 — keymap wiring & engine bypass (UI/integration).** Route `u` / `Ctrl-r` (Vim), `Mod-z` / `Mod-Shift-z` (rich + raw) to the model-level tree (B6). Short-circuit the engine histories (E-group). Keymap precedence per [`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md).

### E. Engine-history bypass (integration)

- **E1 — Milkdown / prosemirror-history.** Do not load the default history keymap; route `Mod-z` / `Mod-Shift-z` to the model-level tree, not ProseMirror `undo`/`redo`. (Transaction *grouping* machinery may be kept as a convenience for detecting boundaries; its undo/redo *commands* must be unreachable by the user.)
- **E2 — CodeMirror 6 / `@codemirror/commands` `history`.** Do not install `history()`'s keymap as the user-facing undo; treat its stacks as non-authoritative. Edits flow out to the MDAST bus, which feeds the model-level grouping (B3).
- **E3 — Vim `u` / `Ctrl-r`.** Intercept and re-bind to the model-level tree's undo/redo rather than CM6's linear undo. `@replit/codemirror-vim` provides no undotree, no `g-`/`g+`, no `:earlier`/`:later` — the visualizer's click-to-jump is the GUI equivalent.

Result: exactly **one** authoritative history (the tree); four things route into it (rich keymap, CM keymap, Vim keymap, visualizer UI). No mode can present a divergent undo state.

### F. Cross-device / sync wiring

- **F1 — union-merge.** On (re)connect or idle, `docNodes.listSince(sinceCreatedAt)` and union new nodes into the local DAG. Distinct ULIDs + immutable rows ⇒ set union, zero conflict; the tree simply gains branches.
- **F2 — LWW pointer reconcile.** `documents.currentNodeId` reconciled LWW by `updatedAt`. A device that synced behind sees its pointer overwritten but **loses no history** — every node it created is in the union and reachable via the visualizer.
- **F3 — safety-net path.** Tie auto-versioning cadence (C2) to the accepted debounced-LWW race window ([`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md)): a steady supply of recent `auto` versions narrows the window in which any cross-device/multi-tab race could cost unrecoverable text; if an LWW write overwrites an edit at/after a versioned node, that state is still materializable and additively restorable (C3). Respect the stale-version guard (`documents.updateMarkdown`'s `expectedUpdatedAt` → `{ stale }`): re-hydrate an idle pane rather than clobber a newer device's write.

### G. Tests

- **G1 — merge/persistence (non-negotiable, [`./README.md`](./README.md) §Conventions).** Two simulated devices diverge offline off a shared ancestor, each appending nodes; on sync the server `docNodes` is the **union** with both branches present and no conflict; the pointer resolves LWW; no history is lost.
- **G2 — materialization.** `materialize(nodeId)` reproduces exact canonical Markdown from nearest-snapshot replay for arbitrary depths, including across a `snapshot` boundary.
- **G3 — additive restore.** After restore, the prior tip chain and the tagged node remain reachable; the new node's content equals the version's materialized state; undo from the new node walks back through the intervening nodes.
- **G4 — grouping.** Typing bursts coalesce; a >500 ms gap, an adjacency break, and a paste each commit a boundary; selection-only moves commit nothing.
- **G5 — auto-snapshot dedupe.** No new `auto` version when nothing changed since the last one.

---

## Technical approach & key decisions

1. **One history, above the editors.** History is owned at the **canonical-model level**, not in any engine. The unit of history is a change to the canonical Markdown/MDAST, not a ProseMirror step or a CodeMirror transaction. This is the only coherent design when one document is edited through up to four lenses (D2/D6) — otherwise three competing engine histories disagree on grouping, depth, and "the previous state." (§2–3 of [`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md).)
2. **Append-only immutable nodes = trivial merge.** Because every node is immutable and keyed by a globally unique client ULID, two devices' node sets **union-merge** with zero conflict — there is no "edit the same node two ways" case. The only mutable piece is the single `documents.currentNodeId` pointer, reconciled **LWW**. This is *why* the undo tree is one of the README's "hard parts" that is nonetheless tractable, and why it was front-loaded in Phase 0. (§7 of [`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md).)
3. **`patch` is relative to the parent's materialized state** (not an absolute base). This is precisely what makes union-merge conflict-free and keeps each row tiny. Periodic full `snapshot`s bound materialization replay. (§4 of [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md).)
4. **Navigation re-projects into BOTH engines via the MDAST bus.** A pointer move changes the canonical model, so every open lens re-renders from it — the canonical-model spine. Rich/Milkdown updates its ProseMirror doc via the doc-diff → steps path (`prosemirror-recreate-steps`) so the cursor is preserved where possible, then overridden by the node's restored `selection`; raw/Vim CodeMirror updates its string and restores the caret from `selection` (`{ anchor, head }` are canonical-Markdown document offsets, mapped per lens by the bridge); preview re-renders. **One pointer per document** — if two lenses are open, both re-project from the one move. (§5 of [`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md), [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md).)
5. **Grouping mirrors the engines' `newGroupDelay` (~500 ms)** so undo granularity feels familiar, but the policy lives once at the model level and is identical across all lenses. (§4 of [`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md).)
6. **Engine histories are short-circuited within the tree's scope** (E-group). We may retain grouping machinery for boundary detection, but the engines' undo/redo *commands* are not user-reachable; all undo affordances route to the tree.
7. **Versions and the undo tree share `docNodes` but have distinct semantics — do not unify.** Undo = **navigate** (move the pointer to an existing node). Version restore = **fork forward** (append a new node equal to the version's state, move the pointer). Versions are a *pinned pointer with a name*, never a content copy — cheap, single-sourced, and they pin their node against pruning. This separation is the field consensus (Figma/Notion/Docs/Obsidian/Yjs; Automerge's change DAG; Ink & Switch Patchwork). (§10 of [`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md), §2–3 of [`../blueprint/08-version-control.md`](../blueprint/08-version-control.md).)
8. **Restore is additive — the single most important rule of the version layer.** Restore never rewinds or destroys: it materializes the version's node, appends a new node whose `parentNodeId` is the **current tip** (not the version's node), and moves the pointer there. Intervening edits stay reachable and undoable. Like `git checkout` of a past commit onto a new working state. (§2 of [`../blueprint/08-version-control.md`](../blueprint/08-version-control.md).)
9. **Auto-versioning runs on the idle/persistence path only** (never the typing hot path), on interval + significant-change triggers, deduped against the last auto version. `manual` tags are kept forever; `auto` are thinned over time. (§4 of [`../blueprint/08-version-control.md`](../blueprint/08-version-control.md).)
10. **Compare diffs canonical Markdown strings** (the source of truth at rest), not rendered HTML — so the diff reflects exactly what is stored and what restore would produce. Read-only. (§5 of [`../blueprint/08-version-control.md`](../blueprint/08-version-control.md).)
11. **Versions are the cross-device + multi-tab safety net** for the one accepted risk in the LWW sync model. No durable, versioned state is ever truly lost to an LWW race because `docNodes` is append-only and version-pinned nodes are durable. (§7 of [`../blueprint/08-version-control.md`](../blueprint/08-version-control.md).)
12. **Performance contract** (carried from [`./README.md`](./README.md)): the editor owns live state and is never bound to a reactive `useQuery`. Hot-path mutations touch one or two rows (`docNodes.append`, the pointer write). Materialization is bounded by the snapshot cadence. Retention runs as a scheduled batched sweep, never in an interactive write. Within Convex's ~1 MiB value / ~16 MiB transaction / ~1 s execution ceilings (§5 of [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md)).

---

## Libraries introduced

Phase 4 introduces no new framework. The one genuinely new dependency is a text patch/diff codec; everything else is already present from Phases 0–3.

| Library | Purpose | Notes |
|---------|---------|-------|
| A text-diff/patch codec (e.g. `diff-match-patch`, or `fast-diff` / `diff` for line-word diffs) | `docNodes.patch` delta encode/apply (B1) **and** the compare/diff render (C4) | Any battle-tested encoding is acceptable; the only contract is `applyPatch(parentMarkdown, patch)` reproduces the node's Markdown exactly (§4.2 of [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md)). Prefer one library serving both delta storage and on-screen diff. Per project conventions, prefer a battle-tested lib over a custom diff. |
| `crypto.randomUUID()` / ULID (built-in / already in use) | `nodeId` generation | No new dependency (stack table, [`../blueprint/README.md`](../blueprint/README.md) §6). ULIDs sort lexicographically by time and are globally unique for offline/optimistic creation. |
| `prosemirror-recreate-steps` (already from Phase 0/2) | Re-project new MDAST into Milkdown without nuking the cursor on navigation (D4 of approach) | Reused, not introduced. |
| Existing UI primitives (Tailwind v4, shadcn, `cmdk`) | Visualizer + version panel scaffolding | Functional only; bespoke design is Phase 5. |

No Yjs / `prosemirror-sync` / CRDT (D10) — union-merge + LWW is the model.

---

## Data-model changes (Convex)

The schema fields are already declared in [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md) §2; Phase 4 **adds no new fields or tables**. It implements the function modules and the scheduled sweep against the existing shape. Canonical schema (verbatim names, do not rename):

```ts
docNodes: defineTable({
  documentId: v.id("documents"),
  nodeId: v.string(),                       // client-generated ULID; globally unique; durable identity
  parentNodeId: v.union(v.string(), v.null()), // null only for the document's root
  patch: v.string(),                        // delta of canonical Markdown vs parent's materialized state
  snapshot: v.optional(v.string()),         // occasional full Markdown snapshot (root + every Nth node)
  selection: v.union(
    v.object({ anchor: v.number(), head: v.number() }), // canonical-Markdown char offsets
    v.null(),
  ),
  origin: v.string(),                       // device/client id that created the node
  createdAt: v.number(),
})
  .index("by_document", ["documentId"])
  .index("by_document_node", ["documentId", "nodeId"]),

versions: defineTable({
  documentId: v.id("documents"),
  nodeId: v.string(),                       // the docNodes.nodeId this version points at (same documentId)
  label: v.string(),
  kind: v.union(v.literal("auto"), v.literal("manual")),
  createdAt: v.number(),
}).index("by_document", ["documentId"]),

// documents.currentNodeId: v.string()  — pointer INTO the docNodes DAG (a docNodes.nodeId, NOT an Id<"docNodes">).
```

**Function surface to implement/complete** (signatures per [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md) §3):

- `docNodes.append(...)` → `{ nodeId }` — idempotent on `(documentId, nodeId)`; append-only, never updates an existing node; does not write `currentNodeId`.
- `docNodes.listSince({ documentId, sinceCreatedAt? })` → `Array<Doc<"docNodes">>` — DAG hydration + incremental union-merge.
- `docNodes.getSnapshotAt({ documentId, nodeId })` → `{ markdown, nodeId }` — server-side materialization (nearest-snapshot replay).
- `versions.create({ documentId, nodeId, label, kind })` → `{ versionId }`.
- `versions.list({ documentId })` → newest-first metadata.
- `versions.restore({ documentId, versionId })` → `{ newNodeId, markdown }` — **additive**: materialize version's node, append a new node parented at the current head, write that markdown to `documents.markdown`, advance `currentNodeId`; old history untouched.
- `versions.remove({ documentId, versionId })` → untags only; never deletes the `docNodes` node.
- The pointer move co-located with the existing `documents.updateMarkdown` idle write (sets `currentNodeId`, stamps `updatedAt`, LWW; honours `expectedUpdatedAt` stale guard).

**Invariants to enforce in code:**

- `documents.currentNodeId` is a `string` ULID matching a `docNodes.nodeId` for that document — *not* a Convex `Id`.
- `docNodes.parentNodeId` is `null` only on the document's root node; root node carries `snapshot: ""`.
- History lives in **separate rows**, never an embedded array on `documents`.
- `docNodes` exposes **no** update and **no** per-node delete mutation; removal is only `documents.remove` (cascade) or the batched retention sweep (whole abandoned subtrees).
- `versions.remove` deletes only the `versions` row.

---

## Acceptance / exit criteria (testable)

A checked box must be demonstrable by an automated test or a recorded manual check. The global Definition of Done in [`./README.md`](./README.md) also applies.

**Undo tree:**

- [ ] Make a sequence of edits; **undo** walks back to prior states; **redo** walks forward; the restored caret matches each node's `selection`.
- [ ] **Branch creation:** undo to an earlier node, then edit — a **new branch** is created and the **old redo path is preserved** (both branches reachable; nothing discarded). This is the core branching-undo proof.
- [ ] Grouping: a typing burst is one node; a >~500 ms pause, an adjacency break, and a paste each commit a node boundary; a selection-only caret move commits **no** node.
- [ ] Vim `u` / `Ctrl-r` and `Mod-z` / `Mod-Shift-z` route to the model-level tree; the engine histories (`prosemirror-history`, `@codemirror/commands` `history`) are **not** user-reachable as undo (no divergent undo state in any mode).
- [ ] With two lenses of one document open (D6), a single navigation re-projects into **both** engines + preview from the **one** pointer.

**Cross-device:**

- [ ] **Switch devices and the tree merges:** two devices diverge (offline) off a shared ancestor, each appending nodes; on sync the `docNodes` set is the **union** with both branches present, no conflict; the pointer resolves LWW; **no history is lost** (every node from both devices is reachable in the visualizer).

**Versions:**

- [ ] **Navigate to and restore any node/tag NON-DESTRUCTIVELY:** restoring a version (or jumping to any node and continuing) appends a new node/branch and moves the pointer; the intervening edits and the tagged node remain reachable and undoable.
- [ ] **Create a manual tag:** "Tag current version" writes a `manual` `versions` row pointing at `currentNodeId`; it appears in the version list and badges the corresponding node in the visualizer; the node is pinned against pruning.
- [ ] **Auto-snapshots appear:** `auto` versions are created on interval + significant-change while editing; **no** duplicate `auto` version is created when nothing changed since the last one.
- [ ] **Diff two versions:** selecting two versions renders a line/word-level text diff of their materialized **canonical Markdown** states; compare is read-only (pointer unchanged, no node appended).
- [ ] Rename a `manual` tag (label updates in place); delete a tag (only the `versions` row is removed; the `docNodes` node remains).

**Visualizer:**

- [ ] The visualizer shows the node/branch tree with the **current-node** marker and **tagged-node** badges; **hover** previews a node's state without moving the pointer; **click** jumps (`navigateTo`) and re-projects into both editors.

**Safety net & quality gates:**

- [ ] A versioned state remains recoverable after a simulated debounced-LWW overwrite (the safety-net path); the stale-version guard (`expectedUpdatedAt`) re-hydrates an idle pane rather than clobbering a newer write.
- [ ] `bun run typecheck` passes with no errors.
- [ ] `bun run biome check` passes clean.
- [ ] `bun run test` green, including the merge/persistence (G1), materialization (G2), additive-restore (G3), grouping (G4), and auto-dedupe (G5) suites.
- [ ] No data-loss regression: refresh, navigate away, and switch devices without losing content or history (persistence tests green).

---

## Risks & mitigations

| Risk | Mitigation | Fallback |
|------|------------|----------|
| **Cloud undo-tree storage growth** (append-only forever) | Delta-encode `patch`; periodic `snapshot`; scheduled batched retention sweep; history in separate rows so the `documents` value never bloats | Cap depth; keep recent + all tagged + live spine; prune deep abandoned branches ([`./README.md`](./README.md) risk register) |
| **Merge bugs** in cross-device union | Append-only immutable nodes keyed by ULID ⇒ set union, no conflict; idempotent `append`; non-negotiable merge/persistence tests (G1) under simulated offline divergence | LWW pointer is recoverable via version history; abandoned-but-unpruned nodes stay navigable |
| **Materialization replay too long / slow** | Periodic `snapshot` bounds the walk; server-side `getSnapshotAt` so a single state never ships the whole DAG; tune snapshot cadence | Increase snapshot frequency; cache recently materialized states client-side |
| **Re-projection clobbers the cursor** on navigation | `prosemirror-recreate-steps` doc-diff → steps preserves cursor where possible, then the node's `selection` overrides; selection offsets mapped per-lens by the bridge | Restore caret to document start if mapping fails; never silently lose text |
| **Engine history leaks** (a stray `Mod-z` hits an engine's undo) | Explicitly short-circuit both engine histories and re-bind Vim keys; keymap precedence per [`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md); test that no mode shows a divergent undo state | Hard-disable the engine `history()`/keymap entirely (lose the grouping-detection convenience) |
| **Same doc edited on two devices within the debounce window** (accepted LWW race) | Versions safety net (steady `auto` cadence narrows the window); stale-version guard (`expectedUpdatedAt`) re-hydrates rather than clobbers | Accept rare last-write-wins; restore the overwritten state additively from version history (§7 of [`../blueprint/08-version-control.md`](../blueprint/08-version-control.md)) |
| **Convex ~1 MiB value / ~16 MiB txn / ~1 s ceilings** | One row per state; one-or-two-row hot-path mutations; incremental `listSince`; batched cascade/sweep | Raise snapshot cadence; per-section splitting only if book-length ever becomes a need (it is a non-goal) |
| **Pruning orphans a snapshot a survivor needs** | Retention keeps ancestors of kept nodes and never orphans a snapshot chain; prune whole subtrees only | Retain the snapshot's subtree; skip that prune candidate |
| **Unifying undo and versions by accident** (one object) | Keep them as two layers over one store: undo navigates, restore forks forward; restore parents at the current tip, never the version's node | — (design rule, not a runtime fallback) |

---

## References

**Blueprint (canon):**
- [`../blueprint/README.md`](../blueprint/README.md) — locked decisions D1–D15, canonical schema (§7), glossary, the three hard parts (§9).
- [`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md) — branching undo model, grouping (~500 ms), navigation/materialization, engine bypass, union-merge + LWW, retention, visualizer.
- [`../blueprint/08-version-control.md`](../blueprint/08-version-control.md) — tagged versions, additive restore, auto/manual triggers, compare/diff, version-history UI, safety net.
- [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md) — Convex schema, indexes, function surface, delta/snapshot storage, limits, retention/pruning.
- [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) — the MDAST bus and cursor-preserving re-projection navigation depends on.
- [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) — debounced LWW snapshot sync, local-owns-live, stale-version guard, multi-tab/cross-device concurrency, the accepted race.
- [`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) — keymap precedence for undo/redo and Vim `u`/`Ctrl-r` interplay.
- [`../blueprint/11-clipboard-export.md`](../blueprint/11-clipboard-export.md), [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) — out-of-scope here; Phase 5.

**Plan (siblings):**
- [`./README.md`](./README.md) — phase map, Definition of Done, conventions, carried risk register.
- [`./phase-0-spikes.md`](./phase-0-spikes.md) — the undo-DAG (and bridge) spike whose approach this phase productizes.
- [`./phase-1-foundation.md`](./phase-1-foundation.md), [`./phase-2-modes-and-losslessness.md`](./phase-2-modes-and-losslessness.md), [`./phase-3-multi-doc-split-workspace.md`](./phase-3-multi-doc-split-workspace.md) — prerequisites.
- [`./phase-5-polish-and-export.md`](./phase-5-polish-and-export.md) — clipboard/export and design polish that follow.

**External:**
- Vim undo tree (`g-`/`g+`, `:earlier`/`:later`): <https://vimhelp.org/undo.txt.html>
- Emacs `undotree` plugin: <https://github.com/mbbill/undotree>
- prosemirror-history (linear; discards redo on edit-after-undo): <https://github.com/ProseMirror/prosemirror-history>
- CodeMirror commands `history` source: <https://github.com/codemirror/commands/blob/main/src/history.ts>
- `@replit/codemirror-vim` (no undotree; maps `u`/`Ctrl-r` to CM6 linear undo): <https://github.com/replit/codemirror-vim>
- Yjs UndoManager (two linear stacks, separate from snapshots): <https://docs.yjs.dev/api/undo-manager>
- Automerge (git-like change DAG): <https://automerge.org/docs/reference/glossary/>
- Ink & Switch Patchwork (branches + named milestones over one history): <https://www.inkandswitch.com/patchwork/>
- Convex limits: <https://docs.convex.dev/production/state/limits>
- Convex schemas: <https://docs.convex.dev/database/schemas>
