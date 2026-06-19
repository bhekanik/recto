# Phase 3 — Multiple documents, split panes & workspace persistence

> **Execution companion** to the blueprint. This phase file is self-contained: it restates its goal, prerequisites, scope, work breakdown, technical approach, the data-model and dependencies it touches, explicit out-of-scope items, testable exit criteria, and risks — so it can be handed to an implementer alongside the blueprint.
>
> Read [`../blueprint/README.md`](../blueprint/README.md) for canon (the locked decisions **D1–D15**, the canonical Convex schema, the Markdown dialect, the glossary). This phase **builds** the feature set specified in [`../blueprint/09-documents-workspace-split.md`](../blueprint/09-documents-workspace-split.md) and consumes the bridge from [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) and the persistence discipline from [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md). Where this file appears to contradict a blueprint file, the blueprint wins — open an issue and reconcile.
>
> Phase map (see [`./README.md`](./README.md)): Phase 0 spikes → Phase 1 foundation → Phase 2 modes & losslessness → **Phase 3 (this file)** → Phase 4 history → Phase 5 polish & export.

---

## Goal

Turn the single-document, single-surface editor of Phases 1–2 into a **multi-document, split-pane writing studio with cloud-persisted, cross-device-resumable layout**. Concretely, after this phase the user can:

1. **Manage documents** — list, create, rename, delete, and switch between documents through a quick-open switcher (`cmdk`), with titles that default to the document's first heading or `"Untitled"`.
2. **Split the writing surface** into nested vertical and horizontal **panes** (the recursive `paneTree`), each leaf binding `{ paneId, documentId, mode, viewState }`, rendered and resized with `react-resizable-panels`.
3. **Open the same document in two live, editable modes at once** (a rich pane + a raw pane of one document, kept in sync keystroke-by-keystroke through the lossless bridge), per **D6** — or the documented Phase-0 fallback if the spike rejected the live bridge.
4. **Resume anywhere** — the `workspaces` row (one per user) persists `paneTree`, `openDocumentIds`, `activePaneId`, and `perPaneViewState` (per-pane mode + cursor/scroll) on a debounce; opening Recto on a second machine reconstructs the exact layout, open documents, per-pane modes, and cursor positions. This is the literal mechanism behind Product Principle 1 ("open and write… the last document and layout are restored").

The defining new mechanisms are the **recursive pane tree** and the **single shared in-memory canonical model per `documentId`** that lets two panes of one document stay live without two copies drifting.

---

## Why now / prerequisites

This phase sits on top of two completed phases and one decided spike. Do **not** start it until these hold.

### Prerequisites (must be done)

- **Phase 1 — Foundation** done: Next.js (App Router) + Convex + Better Auth + dark shell; the `documents` table exists with `documents.create` / `documents.get` / `documents.updateMarkdown`; one rich-text surface hydrates from `documents.markdown` and syncs back via the debounced mutation; live word count; the **D11 performance contract** is in place (the editor owns live state; it is *never* a controlled component of a reactive `useQuery`). See [`./phase-1-foundation.md`](./phase-1-foundation.md) and [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §1.
- **Phase 2 — Modes & losslessness** done: all four modes exist (rich / raw / vim / preview); a single pane can switch modes losslessly via the canonical-model handoff ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §8.2); the frozen `CANONICAL_STRINGIFY` serializer and the round-trip corpus are green. This phase reuses the mode-switch handoff and the serializer; it does not reinvent them. See [`./phase-2-modes-and-losslessness.md`](./phase-2-modes-and-losslessness.md).
- **Phase 0 — Bridge approach decided.** The throwaway Phase 0 spike has already chosen one of:
  - **(A) Live bridge ships** — the full §3–§8 bridge of [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) is smooth on real content (origin-guarded, throttled, cursor-preserving diffs both directions; `recreateTransform` raw→rich; minimal-range diff rich→raw). The exact `prosemirror-recreate-steps` build is pinned. **This phase productizes that live bridge.**
  - **(B) Fallback chosen** — per [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §12: a single pane uses **switch-on-mode only** (lossless, but syncs only at switch time, not continuously); cross-pane live editing is limited to **different** documents; the **same** document may appear in a second pane only as read-only **Preview** (which has no write-back and so cannot jank). This relaxes only **D6**.

  **The implementer MUST read the recorded Phase-0 decision** (in [`./phase-0-spikes.md`](./phase-0-spikes.md) and [`../blueprint/14-tech-decisions.md`](../blueprint/14-tech-decisions.md)) and build path (A) or (B) accordingly. Everything below the "same-doc two live modes" heading is written for (A) with the (B) substitution called out explicitly. The pane-tree model, document management, and workspace persistence are **identical** in both cases — only the bridge behavior on a same-`documentId` pair differs, and **no schema change** is needed to support either (see [`../blueprint/09-documents-workspace-split.md`](../blueprint/09-documents-workspace-split.md) §3.5).

### Why this order

Multi-doc and splitting depend on a surface that already syncs and never loses words (Phase 1) and on modes that switch losslessly (Phase 2). Same-doc-two-live-modes depends on the bridge mechanism being *proven or fallen-back* (Phase 0), because it is the riskiest user-facing claim. Building the pane tree before the bridge was decided would risk designing UI around a mechanism that does not ship. History (Phase 4) and polish/export (Phase 5) come after, since they layer onto a stable multi-pane workspace.

---

## In scope

- **Document management UI** — `documents.list` (reactive, over `by_user_updated`); `documents.create` / `documents.rename` / `documents.remove` mutations and their UI; the `cmdk`-based **document switcher** (quick-open) with fuzzy filter, Enter = switch active pane, modifier+Enter = open into a new split, a "Create new document" row, and per-row rename/delete. Derived default title (first heading text, else `"Untitled"`).
- **The recursive `paneTree`** — the in-memory `PaneNode` model (`PaneLeaf` | `PaneSplit`), rendered with `react-resizable-panels` for nested vertical/horizontal resizable splits. Each leaf binds `{ paneId, documentId, mode, viewState }`.
- **Pane operations** — split vertically, split horizontally, close (with split collapse + size renormalization), focus (`activePaneId`), resize (via `onLayout`), change a pane's mode, open a document into a pane; keyboard pane navigation (spatial + cycle).
- **Same document in multiple panes** — one shared in-memory canonical model keyed by `documentId`; reference-counted load/release; per-pane `viewState` (cursor/scroll) that is *not* shared. The same-doc-two-live-modes product feature (rich pane + raw pane of one doc) wired through the **bridge** (path A) or the documented **fallback** (path B).
- **Workspace persistence** — the `workspaces` table (one row per user); `workspaces.get` (reactive read, not editor-bound) and `workspaces.save` (debounced mutation); serialize `paneTree` (JSON) + `openDocumentIds` + `activePaneId` + `perPaneViewState` (JSON); restore on load; cross-device resume with **last-write-wins on the workspace row**; dangling-reference reconciliation; keep the serialized row well under Convex's ~1 MiB ceiling.
- **Empty states** — no-documents-yet (inviting prompt; create binds to the pane in rich mode) and empty-pane (a leaf with no bound document; counts as a real pane; there is always at least one pane).

## Out of scope

Explicitly **not** in this phase (deferred to later phases or simply not v1):

- **Undo-tree UI / visualizer** — the branching undo-tree visualizer is Phase 4 ([`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md)). This phase does not render or navigate the DAG. `docNodes` append cadence (if any) is owned by Phases 1/4, not changed here.
- **Version history** — tagged versions, auto/manual snapshots, additive restore are Phase 4 ([`../blueprint/08-version-control.md`](../blueprint/08-version-control.md)). This phase does not touch `versions`.
- **Export & clipboard** — copy (html+plain), copy-as-markdown, export `.md` / `.html` are Phase 5 ([`../blueprint/11-clipboard-export.md`](../blueprint/11-clipboard-export.md)).
- **Bespoke design polish** — the full dark OKLCH typographic design pass is Phase 5 ([`../blueprint/12-design-system.md`](../blueprint/12-design-system.md)). Use restrained, functional dark styling and a low-chrome resize handle here; do not invest in the final visual craft.
- **The global command palette** beyond the document switcher — the broader `cmdk` command palette (all actions) is Phase 5 ([`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md)). Here we build only the **document switcher** overlay (which shares the `cmdk` primitive) and the pane keyboard chords.
- **The mode-switch mechanism itself** — owned by Phase 2 / [`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) and [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §8.2. This phase only *records* a leaf's new `mode` and triggers the existing switch; it does not re-author the lossless caret handoff.
- **Offline buffer changes** — the `localStorage`/IndexedDB crash buffer is owned by [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §6 / Phase 1. Workspace layout does not get its own offline buffer beyond a `beforeunload` best-effort flush.

---

## Work breakdown

Grouped by deliverable. Each group ends with the blueprint section it implements.

### A. Convex: documents lifecycle + workspaces table

- **A1.** Confirm `documents.list` exists as a reactive query over the `by_user_updated` index, returning `{ _id, title, wordCount, updatedAt }` per row (metadata only — safe to bind reactively; the D11 prohibition is about binding an **editor's value** to a query, not about listing titles). Add it if Phase 1 only built `get`.
- **A2.** Add `documents.rename(documentId, title)` mutation (sets `title`, bumps `updatedAt`). Add `documents.remove(documentId)` mutation that deletes the document **and cascades** its history rows (`docNodes`, `versions`) per [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md). (`create` exists from Phase 1.)
- **A3.** Add the `workspaces` table to the Convex schema exactly per canon (see **Data-model changes** below): `userId`, `paneTree: string`, `openDocumentIds: Id<"documents">[]`, `activePaneId: string`, `perPaneViewState: string`, `updatedAt: number`; index `by_user (userId)`.
- **A4.** Add `workspaces.get` (reactive query, returns the single row for the user or `null`) and `workspaces.save(paneTree, openDocumentIds, activePaneId, perPaneViewState)` (upsert the single `by_user` row, set `updatedAt = Date.now()`; last-write-wins — whole row is the unit).

  *Implements [`../blueprint/09-documents-workspace-split.md`](../blueprint/09-documents-workspace-split.md) §1.1–§1.2, §4.1, and [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md).*

### B. The pane-tree model (pure, in-memory)

- **B1.** Define the canonical TypeScript types exactly per [`../blueprint/09-documents-workspace-split.md`](../blueprint/09-documents-workspace-split.md) §3.1: `Mode = "rich" | "raw" | "vim" | "preview"`; `PaneViewState { selection: { anchor; head } | null; scrollTop: number }`; `PaneLeaf { type: "pane"; paneId; documentId; mode; viewState }`; `PaneSplit { type: "split"; direction: "vertical" | "horizontal"; children: PaneNode[]; sizes: number[] }`; `PaneNode = PaneLeaf | PaneSplit`; `PaneTree = PaneNode` (root may be a single leaf).
- **B2.** Implement **pure** tree operations over `PaneNode` (never mutate in place; return a new root):
  - `splitPane(tree, paneId, direction)` — replace the target `PaneLeaf` with a `PaneSplit { direction, children: [original, newLeaf], sizes: [50, 50] }`. Apply the same-direction **flattening** optimization (§3.1/§3.4): splitting in the *same* direction as the parent appends a child to the parent group instead of nesting, keeping the tree shallow and the JSON small.
  - `closePane(tree, paneId)` — remove the leaf; drop its `sizes` entry; **renormalize** remaining sizes to 100; if a split is left with one child, **replace it with that child** (collapse), repeating up the chain; never yield an empty tree (the last pane becomes an empty pane, §5.2). Per §3.4.1.
  - `setPaneDocument(tree, paneId, documentId)` — rebind a leaf's `documentId`; reset/seed its `viewState`.
  - `setPaneMode(tree, paneId, mode)` — record the new `mode` (the lossless switch itself is Phase 2 / [`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md)).
  - `setPaneViewState(tree, paneId, viewState)` — update a leaf's cursor/scroll.
  - `updateSplitSizes(tree, splitNode, sizes)` — set a split's `sizes` from `react-resizable-panels`' `onLayout`.
  - `openDocumentIdsFromTree(root)` — the deduplicated set of distinct `documentId`s across all leaves (§3.4.2).
  - `perPaneViewStateFromTree(root)` — the denormalized `paneId → { mode, viewState }` map derived from the leaves (§4.4).
- **B3.** Unit-test the pure operations: split V then H produces correct nesting; same-direction split flattens; close collapses single-child splits and renormalizes sizes; reference counting drops an id only when no leaf references it.

  *Implements [`../blueprint/09-documents-workspace-split.md`](../blueprint/09-documents-workspace-split.md) §3.1, §3.4, §3.4.1, §3.4.2, §4.4.*

### C. Rendering & interaction (`react-resizable-panels`)

- **C1.** `RenderPaneNode` recursive component (§3.3): a `PaneSplit` renders a `PanelGroup direction={node.direction}` with one `Panel defaultSize={sizes[i]} minSize={MIN_PANE_PERCENT}` per child and a `PanelResizeHandle` between them; a `PaneLeaf` renders the `Pane` (which mounts the right editor engine for `node.mode`). Wire `onLayout(sizes)` → `updateSplitSizes` → debounced workspace save.
- **C2.** **Stable React keys** keyed off `paneId` (and a structural key for splits) so the library does **not** remount editors on resize/reorder — remounting an editor would drop live local state and violate **D11** (§3.3 note). This is load-bearing; verify editors survive a resize without re-hydrating.
- **C3.** Mount the correct engine per `mode` (rich = Milkdown, raw/vim = CodeMirror 6, preview = read-only render) reusing the Phase 1/2 editor components. Each pane reads/writes only its own `viewState`; the editor still owns its live state (D11).
- **C4.** A low-chrome resize handle and minimal pane chrome (a slim header showing the document `title`, `wordCount`, and the active `mode` indicator). Functional dark styling only — final visual polish is Phase 5.
- **C5.** `MIN_PANE_PERCENT` so a pane can't collapse to nothing; a soft UI cap on simultaneously open panes (keeps the row tiny, §4.3) — a UI guard, not a schema constraint.

  *Implements [`../blueprint/09-documents-workspace-split.md`](../blueprint/09-documents-workspace-split.md) §3.3, §3.6.*

### D. Document management UI & switcher

- **D1.** Document switcher overlay built on `cmdk` (§1.3) — a command-palette-style overlay, **not** a persistent sidebar (Principle 5, "the tool disappears"). Reads the reactive `documents.list` directly (no editor state → no D11 concern). Contents: every document sorted by `updatedAt` desc, each row showing `title` + `wordCount`; fuzzy filter by title.
- **D2.** Switcher actions: **Enter** = **switch** the active pane to the chosen document (`setPaneDocument` on `activePaneId`); **modifier+Enter** = open the chosen document into a **new split** of the active pane; a persistent "**Create new document**" row → `documents.create` then switch active pane to it; per-row **rename** (inline, `documents.rename`) and **delete** (with confirm, `documents.remove`).
- **D3.** Wire the switcher invocation to a keyboard shortcut and a minimal chrome affordance (canonical chord owned by [`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md)).
- **D4.** **Derived default title** (§1.4): `deriveTitle(root)` returns the trimmed plain text of the first heading node (any level H1–H6) in the canonical MDAST, else `"Untitled"`. Derivation runs off the in-memory canonical model on the **same debounced persist path** as `markdown`/`wordCount` ([`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md)). A **manual rename** overrides derivation; the persisted shape stays exactly the canon `documents` row (no extra `isManual` field) — derivation only writes `title` when the user has not manually set one for the current heading state.
- **D5.** **Delete reconciliation** (§1.5): on `documents.remove`, confirm; drop the id from `openDocumentIds`; for every leaf bound to the deleted id, rebind to another open document (prefer most-recently-active) else turn it into an **empty pane** (§5.2); if the workspace empties, fall to the no-documents empty state (§5.1); persist (debounced).
- **D6.** Use Convex **optimistic updates** for switcher list UI only (new doc appears immediately after `create`; title updates after `rename`) — **never** for the actively-edited `markdown` field, and **never mutate the optimistic store in place** ([`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §4).

  *Implements [`../blueprint/09-documents-workspace-split.md`](../blueprint/09-documents-workspace-split.md) §1.2–§1.5.*

### E. Same document in multiple panes (the shared canonical model)

- **E1.** A **canonical-model registry** keyed by `documentId`: when a leaf binds a `documentId`, it acquires (ref-counts up) the **one** shared in-memory canonical model (the MDAST, hydrated from `documents.markdown` per [`../blueprint/02-architecture.md`](../blueprint/02-architecture.md)); when no remaining leaf references that id, **release** the model and drop the id from `openDocumentIds` (§3.4.2, §3.5). Two leaves of the same `documentId` get the **same** model instance — not two copies.
- **E2.** **Per-pane `viewState` is not shared.** Each leaf keeps its own cursor/scroll; only the content model is shared. `viewState` lives on the leaf (keyed by `paneId` in `perPaneViewState`); the model is keyed by `documentId` (§3.5).
- **E3. (Path A — live bridge ships)** Wire two panes of the same `documentId` in different live modes (rich + raw) through the **bridge** of [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md): MDAST as the bus; rich→raw = minimal-range diff + one CodeMirror transaction tagged with the bridge origin (§3); raw→rich = `recreateTransform` doc-diff → steps applied to the live ProseMirror state with selection mapped through (§4); the three feedback-loop guards — origin annotation, applying-guard, monotonic version counter (§5); the ~30–60 ms trailing throttle per direction (§6); cursor/scroll preserved by expressing updates as change sets/steps, never whole-document replacement (§7). Reuse the Phase-0/Phase-2 bridge module; do **not** re-author it here — Phase 3's job is to **mount two panes against the one model and start the bridge between them**.
- **E3. (Path B — fallback)** If Phase 0 chose the fallback: a **single** pane uses switch-on-mode only; two panes may be live only on **different** documents (no shared model → nothing to sync); the **same** document in a second pane is allowed **only as read-only Preview** (D5; re-renders from the canonical model, no write-back, cannot jank). Disable the "open same doc as a second *editable* mode" affordance and substitute "open as Preview." Note the chosen path in the PR description and confirm it matches [`../blueprint/14-tech-decisions.md`](../blueprint/14-tech-decisions.md).
- **E4.** Either path: the pane tree is **schema-identical** (§3.5) — a `documentId` may legitimately appear on more than one leaf while `openDocumentIds` counts it once.

  *Implements [`../blueprint/09-documents-workspace-split.md`](../blueprint/09-documents-workspace-split.md) §3.5 and [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §8.1 / §12.*

### F. Workspace persistence, restore & cross-device resume

- **F1.** A single **debounced workspace writer** that coalesces a burst of layout changes into one `workspaces.save` mutation (§4.2). Trigger sources: structural change (split / close / open-doc-into-pane / change-mode), focus change (`activePaneId`), resize (`onLayout` — the chattiest source), and cursor/scroll change (`viewState` → `perPaneViewState`). Serialize `paneTree = JSON.stringify(root)`, `openDocumentIds = openDocumentIdsFromTree(root)`, `activePaneId`, `perPaneViewState = JSON.stringify(perPaneViewStateFromTree(root))`. Debounce ~500 ms (constant owned by [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md)); debounce cursor/scroll **harder** or flush only on idle + on focus/structure changes (restoring a *recent* cursor position is enough). Best-effort flush on `beforeunload` / visibility-hidden.
- **F2.** **Restore on load** (§2.1): read the user's `workspaces` row (one reactive read, **not** editor-bound); parse `paneTree` + `perPaneViewState`; for each `documentId` referenced by a leaf, hydrate the canonical model once (reference-counted/deduplicated — a doc in two panes loads once); mount the `react-resizable-panels` tree from `paneTree` restoring each leaf's `mode` + cursor + scroll; focus `activePaneId`.
- **F3.** **Dangling-reference reconciliation** on load (§2.1 step 6): a `documentId` deleted on another device is dropped from `openDocumentIds`, its panes rebound/emptied (§1.5), and the reconciled workspace re-persisted.
- **F4.** **No `workspaces` row yet** (brand-new user): synthesize a default workspace — one pane, no document (the empty-pane state §5.2), or a freshly created `"Untitled"` document. Default to showing the empty-state prompt rather than littering the list with stray empties (§5.1); an explicit create is one keystroke away.
- **F5.** **`paneTree` ↔ `perPaneViewState` reconciliation** (§4.4): `paneTree` is the structural truth (existence, nesting, sizes, document binding, mode, leaf `viewState`); `perPaneViewState` is a denormalized `paneId → { mode, viewState }` index. On **save**, derive `perPaneViewState` from the tree so they cannot diverge. On **restore**, `paneTree` wins on disagreement; orphan `perPaneViewState` entries whose `paneId` is absent from the tree are dropped.
- **F6.** **Cross-device resume = last-write-wins on the whole `workspaces` row** (§4.5, **D10**): `updatedAt` is the clock; the most recent `workspaces.save` defines the layout every device converges to via the reactive read. This is acceptable because the workspace is *layout*, not content — a lost layout tweak costs nothing irreversible, and content has its own safety net (the undo DAG + version history, Phase 4). LWW on layout never puts a word at risk.
- **F7.** **Keep the row tiny** (§4.3): store **no** document text, history, or rendered HTML in the workspace — only structure and small scalars (`paneTree`: a few hundred bytes to low-single-digit KB for 2–6 panes; `perPaneViewState`: one small object per pane; `openDocumentIds`: a short id array). Keep `viewState` to offsets + a `[0,1]` scroll fraction, not serialized editor state. The same-direction flattening (§3.1) keeps depth/node count down. There is no single-user article-writing scenario where this approaches 1 MiB; assert it in tests anyway.

  *Implements [`../blueprint/09-documents-workspace-split.md`](../blueprint/09-documents-workspace-split.md) §2.1, §4.2–§4.5, §5, and [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §1–§3.*

### G. Empty states & keyboard navigation

- **G1.** **No-documents empty state** (§5.1): a centered, low-chrome prompt to start writing; primary action creates an `"Untitled"` document (`documents.create`) bound to the pane in **rich** mode with the cursor ready; the switcher's "Create new document" row and shortcut do the same.
- **G2.** **Empty-pane state** (§5.2): a valid `PaneLeaf` with an unset (`null`/sentinel) `documentId` and `mode` defaulting to `rich`, **not** counted in `openDocumentIds`; renders a compact prompt to open (switcher targeting this pane) or create a document into it; counts as a real pane for navigation and collapse — there is **always at least one pane**; closing the final pane yields an empty pane, never an empty tree.
- **G3.** **Keyboard pane navigation** (§3.7): move focus to the pane in a direction (left/right/up/down — spatial over the rendered geometry, sets `activePaneId`); cycle focus to next/previous pane in tree order; split active pane V/H; close active pane; change active pane's mode; open the switcher targeting the active pane. **Vim interplay:** pane-navigation chords use a dedicated modifier prefix so they never collide with Vim normal-mode motions regardless of the active pane's mode/sub-mode (resolution owned by [`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md)).

  *Implements [`../blueprint/09-documents-workspace-split.md`](../blueprint/09-documents-workspace-split.md) §3.7, §5.1, §5.2.*

---

## Technical approach & key decisions

1. **The pane tree is pure, in-memory, client-owned state.** All pane operations (split / close / focus / resize / mode / open-doc) mutate the in-memory `PaneTree` (and the focus/`perPaneViewState` maps) as **pure functions returning a new root**, then schedule a debounced persist. None block on the network (Principle 4, "snappy is a feature"). Convex is the *durable* store of layout, never the live one — exactly the D11 discipline applied to layout instead of content.

2. **`react-resizable-panels` is for rendering and resize interaction only — Convex is the truth.** We do **not** use the library's own `autoSaveId` localStorage persistence as the source of truth, because layout must survive across devices (cross-device resume is the whole point). We read `onLayout(sizes)` to update our `PaneSplit.sizes` and trigger the debounced cloud save, and seed `Panel defaultSize` from our persisted `sizes` for exact restore (§3.3, §3.6). The library's nested `PanelGroup`/`Panel` maps 1:1 onto our recursive `PaneSplit`/`PaneLeaf`, and `direction="horizontal"` = side-by-side columns, `"vertical"` = stacked rows.

3. **Stable keys prevent editor remounts.** Keying the rendered tree off `paneId` (plus a structural key for splits) keeps `react-resizable-panels` from remounting an editor on resize/reorder. A remount would drop the editor's live local state — a direct **D11** violation and a cursor-loss bug. This is a non-negotiable invariant, not an optimization.

4. **One canonical model per `documentId`, reference-counted.** Two leaves of the same document share one MDAST instance (the bus); they each keep an independent `viewState`. The registry acquires on bind and releases on the last unbind, dropping the id from `openDocumentIds`. This is what makes same-doc-two-live-modes *live* rather than two copies progressively drifting — the failure mode **D2** exists to reject (see [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §10).

5. **Same-doc two live modes is the bridge of §8.1 — a mode switch (§8.2) happening continuously on both panes.** Phase 3 does not re-author the bridge; it mounts two panes against the one shared model and starts the already-proven bridge between them. If Phase 0 chose the fallback, the *same* pane-tree model supports it with **no schema change** — only the bridge behavior on a same-`documentId` pair differs (degrade to switch-on-mode / Preview-only second pane).

6. **`viewState` is document-position based so it survives mode switches.** Selection is stored as `{ anchor, head }` offsets into the canonical Markdown string (mode-agnostic, mirroring `docNodes.selection`); scroll is a `[0,1]` fraction of scrollable height (maps across rich/raw/preview without pixel coupling). This is why the same cursor can be restored regardless of which mode a pane reopens in.

7. **Two independent timers, two concerns.** The bridge throttle (~30–60 ms, keeps two panes in sync) sits *upstream* of and independent from the debounced persistence to Convex (~500 ms, batches the canonical Markdown / the workspace row). Workspace `save` follows the same debounced posture as content `updateMarkdown` ([`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §2, §4.2). Resize `onLayout` is the chattiest source and **must** be debounced; cursor/scroll churn is debounced harder still.

8. **Workspace is layout, deliberately separate from content.** The single `workspaces` row carries only `paneTree` + `openDocumentIds` + `activePaneId` + `perPaneViewState` — no document text or history. This separation is *why* the row stays tiny regardless of document size and *why* last-write-wins on it is safe (a lost layout tweak is recoverable/trivial; content has the undo DAG + version history as its much stronger net).

9. **The reactive reads in this phase are metadata, not editor content.** `documents.list` (titles + word counts) and `workspaces.get` (layout) are safe to bind reactively — the **D11** prohibition is specifically about binding an **editor's value** to a `useQuery`, not about listing titles or reading layout. The editor is still seeded once on open and never re-bound to a query while focused.

---

## Libraries introduced

| Library | Use | Notes |
|---------|-----|-------|
| [`react-resizable-panels`](https://github.com/bvaughn/react-resizable-panels) | Nested vertical/horizontal resizable splits (`PanelGroup` / `Panel` / `PanelResizeHandle`) rendering the `paneTree`; size round-trip via `onLayout` + `defaultSize`. | Chosen in [`../blueprint/README.md`](../blueprint/README.md) §6. We use it for rendering/resize only; cloud `workspaces` is the persistence truth, **not** its `autoSaveId`. |
| `cmdk` | The document switcher (quick-open) overlay; keyboard-first fuzzy filtering. | Already chosen in [`../blueprint/README.md`](../blueprint/README.md) §6 for the command palette; if Phase 2 introduced it, reuse it — the switcher shares this primitive. The full global palette is Phase 5. |

No other new dependencies. The bridge (`prosemirror-recreate-steps` and the `@codemirror/state` / ProseMirror plumbing), `unified`/`remark-*`, Milkdown, CodeMirror 6, Convex client, Better Auth, Tailwind v4, and Biome are all already present from Phases 0–2. IDs (`paneId`) use the built-in `crypto.randomUUID()` — **no `uuid` dependency** ([`../blueprint/README.md`](../blueprint/README.md) §6).

---

## Data-model changes (Convex)

Add the `workspaces` table **exactly** per canon ([`../blueprint/README.md`](../blueprint/README.md) §7, [`../blueprint/09-documents-workspace-split.md`](../blueprint/09-documents-workspace-split.md) §4.1, full validators in [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md)). Use these exact field names everywhere: `paneTree`, `openDocumentIds`, `activePaneId`, `perPaneViewState`.

```ts
// convex/schema.ts (additions only; do not alter documents/docNodes/versions shapes)
workspaces: defineTable({
  userId: v.id("users"),
  paneTree: v.string(),               // JSON.stringify(PaneTree root) — recursive split layout (09 §3)
  openDocumentIds: v.array(v.id("documents")), // deduplicated set of open documents
  activePaneId: v.string(),           // the focused leaf's paneId
  perPaneViewState: v.string(),       // JSON.stringify(paneId -> { mode, viewState }) (09 §4.4)
  updatedAt: v.number(),              // last-write-wins clock for the row (09 §4.5)
}).index("by_user", ["userId"]),      // one row per user
```

Mutations / queries added (illustrative names; match the codebase's established Convex naming pattern):

- `query workspaces.get` — return the single `by_user` row for the authenticated user, or `null`. Reactive read; **not** bound to any editor (D11).
- `mutation workspaces.save({ paneTree, openDocumentIds, activePaneId, perPaneViewState })` — upsert the single `by_user` row; set `updatedAt = Date.now()`. The whole row is the unit (last-write-wins). Debounced caller (§4.2).
- `query documents.list` — over `by_user_updated`, newest-edited first, returning metadata only. (Confirm/add if Phase 1 only built `get`.)
- `mutation documents.rename({ documentId, title })` — set `title`, bump `updatedAt`.
- `mutation documents.remove({ documentId })` — delete the document **and cascade** its `docNodes` / `versions` rows per [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md).

**Hard constraints respected** ([`../blueprint/README.md`](../blueprint/README.md) §7, [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md)):

- The serialized `workspaces` row stays **well under** Convex's ~1 MiB per-value ceiling — it holds only structure and small scalars (§4.3 / Work item F7). Tests assert the serialized size for a realistic and an adversarial (many-pane) layout.
- No document content, history, or rendered HTML is ever stored in the workspace.
- `documents` / `docNodes` / `versions` shapes are **not** changed by this phase. History rows are storage owned by Phases 1/4.

---

## Acceptance / exit criteria

A reviewer should be able to check each box. The phase is done only when **all** pass (plus the global Definition of Done in [`./README.md`](./README.md)).

> **Status: superseded by [`./README.md`](./README.md).** That phase map marks Phase 3 ✅ Done (Phases 0–5 complete, runtime-verified, with typecheck/biome/test/build green). The unchecked boxes below are the original execution checklist, kept for historical reference; treat the README status as authoritative.

**Document management**

- [ ] `documents.list` shows all of the user's documents newest-edited-first; creating, renaming, and deleting reflect immediately (optimistic for list UI only, never the edited `markdown`).
- [ ] The **document switcher** (`cmdk`) opens via its shortcut, fuzzy-filters by title, shows `title` + `wordCount` per row, and: **Enter** switches the active pane to the chosen doc; **modifier+Enter** opens it into a new split; the "Create new document" row creates and switches; per-row rename + delete (with confirm) work.
- [ ] A document with a first heading shows that heading's text as its title; a document with no heading (or an empty one) shows `"Untitled"`; a **manual rename** overrides derivation and the persisted row carries no extra fields.
- [ ] Deleting a document open in one or more panes rebinds those panes to another open doc (or an empty pane), drops the id from `openDocumentIds`, and never leaves a pane pointing at a tombstone.

**Split panes**

- [ ] A surface can be split **vertically** (stacked rows) **and** **horizontally** (side-by-side columns), nested arbitrarily, via keyboard and UI; resizers drag on the correct axis.
- [ ] Resizing a split persists exact sizes (restored to the same proportions on reload); a pane cannot collapse below `MIN_PANE_PERCENT`.
- [ ] Closing a pane collapses single-child splits up the chain, renormalizes sibling sizes to 100, moves focus to a sibling/nearest leaf, and never produces an empty tree (the last close yields an empty pane).
- [ ] Resizing or reordering panes does **not** remount editors (live local state and cursor survive — verified, since a remount would violate D11).
- [ ] Keyboard pane navigation moves focus spatially (left/right/up/down) and cycles next/previous; in a Vim pane the navigation chords do not collide with Vim motions.

**Same document in multiple panes (the headline criterion)**

- [ ] **(Path A)** The **same** document can be opened as a **rich pane and a raw pane simultaneously**; typing in either pane updates the other **live**, keystroke-by-keystroke, with **two-way sync**, and the **cursor in the non-focused pane is stable** (mapped through the change, not reset to start/end); no feedback-loop double-typing; no progressive drift over an extended edit session. Two panes of one document share **one** in-memory canonical model (not two copies).
- [ ] **(Path B — only if Phase 0 chose the fallback)** A single pane switches modes losslessly (switch-on-mode); the **same** document opens in a second pane as **read-only Preview** that re-renders live from the canonical model; two *different* documents can each be independently live in their own panes. The chosen path is recorded and matches [`../blueprint/14-tech-decisions.md`](../blueprint/14-tech-decisions.md).
- [ ] Two panes of one document keep **independent** cursor/scroll (per-pane `viewState`); only content is shared.

**Workspace persistence & cross-device resume**

- [ ] After arranging a non-trivial layout (e.g. a doc as rich+raw on the left, a reference doc as preview on the right) and pausing, the `workspaces` row persists `paneTree`, `openDocumentIds` (deduplicated), `activePaneId`, and `perPaneViewState`.
- [ ] **Reopening on a second machine** (or a fresh session / cleared local state) restores: the **layout** (nesting + sizes), the **open documents**, the **per-pane modes**, and the **cursor positions** — without losing any content.
- [ ] Concurrent layout edits on two machines resolve by **last-write-wins on the `workspaces` row**; the most recent save is what both devices converge to. No content is lost (content has its own net).
- [ ] A document deleted on device A is reconciled on device B's next load (dropped from `openDocumentIds`, its panes rebound/emptied, workspace re-persisted).
- [ ] A brand-new user (no `workspaces` row) lands in a valid default workspace (empty-pane prompt or a fresh `"Untitled"`), cursor ready.
- [ ] The serialized `workspaces` row is **well under ~1 MiB** for both a realistic (2–6 pane) layout and an adversarial many-pane layout — asserted by a test; no document text/history/HTML is stored in it.
- [ ] Workspace saves are **debounced** (off the hot path); resize/cursor churn does not produce a mutation per event; a `beforeunload` flush best-effort persists the final layout.

**Global gates**

- [ ] `bun run typecheck` passes with no errors.
- [ ] `bun run biome check` passes clean.
- [ ] No data-loss regression: refresh, navigate away, and switch devices without losing content; typing introduces no perceptible input latency; mode switches and same-doc sync feel instant.

---

## Risks & mitigations

| Risk | Likelihood | Mitigation | Fallback |
|------|-----------|-----------|----------|
| **Live two-mode sync is janky** (cursor jumps, feedback loops, raw→rich reparse lag) | Medium — the core unproven mechanism | Reuse the Phase-0-proven bridge verbatim ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md)): MDAST bus, origin guard + applying-guard + version counter, ~30–60 ms throttle, minimal-range diff / `recreateTransform` steps, selection mapped through changes. Run the cursor-stability harness and no-drift-over-N-cycles property tests (§11). | Phase 0's §12 fallback: same-pane switch-on-mode; cross-pane live only on *different* docs; same doc in a second pane is read-only **Preview**. **No schema change** — same pane tree (§3.5). |
| **Editor remounts on resize/reorder** drop live state (cursor loss masquerading as a sync bug) | Medium if keys are wrong | Stable React keys off `paneId` (+ structural key for splits) (§3.3); explicit test that a resize does not re-hydrate the editor. | — (this must be fixed, not worked around). |
| **`react-resizable-panels` `onLayout` is chatty** → mutation storm | High without care | Debounce the workspace writer hard; coalesce a resize burst into one `workspaces.save`; cursor/scroll debounced even harder / idle-flushed (§4.2). | Raise the debounce; flush only on idle + structural/focus changes. |
| **Same doc edited on two devices within the debounce window** (content) | Low (single user) | Content uses local-owns-live + the stale-version guard + idle re-hydration ([`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §5); the append-only undo DAG + version history are the recovery net (Phase 4). | Accept rare last-write-wins on content; restore from version history. |
| **Concurrent *layout* edits on two devices** | Low | Last-write-wins on the whole `workspaces` row by design (§4.5, D10); layout loss is trivial and never risks a word. | Accept; this is intentional. |
| **`workspaces` row grows toward 1 MiB** | Very low | Store only structure + small scalars; `viewState` = offsets + a fraction; flatten same-direction splits; soft cap open panes; assert serialized size in tests (§4.3). | Per-pane state pruning; cap pane count harder (UI guard). |
| **Dangling `documentId`** (deleted elsewhere) breaks restore | Medium | Reconcile on load: drop from `openDocumentIds`, rebind/empty panes, re-persist (§2.1 step 6, §1.5). | Empty the affected pane; never crash on a tombstone. |
| **`paneTree` and `perPaneViewState` diverge** on a partial write | Low | Derive `perPaneViewState` from the tree on every save; on restore `paneTree` wins, orphan entries dropped (§4.4). | Rebuild `perPaneViewState` from the tree on load. |

---

## References

Blueprint (canon — read first):

- [`../blueprint/README.md`](../blueprint/README.md) — locked decisions **D1–D15**, canonical Convex schema (§7), stack (§6), glossary (§11). **This phase must never contradict D1–D15.**
- [`../blueprint/09-documents-workspace-split.md`](../blueprint/09-documents-workspace-split.md) — **the spec this phase builds**: documents, the recursive `paneTree`, pane operations, same-doc shared model, the `workspaces` table, debounced save, restore, cross-device resume, empty states.
- [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) — the live two-mode bridge (MDAST bus, rich↔raw diff/steps, feedback-loop guards, throttling, cursor preservation) and the §12 fallback.
- [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) — local-owns-live (**D11**), debounced persistence, reactive idle hydration, optimistic-update rules, last-write-wins concurrency, debounce constants.
- [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md) — full validators, indexes, cascade rules, and Convex limits for `documents` and `workspaces`.
- [`../blueprint/02-architecture.md`](../blueprint/02-architecture.md) — the single in-memory canonical model keyed by `documentId` that panes share; how a pane hydrates from `documents.markdown`.
- [`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) — the four modes a leaf's `mode` can take; the lossless mode-switch a pane performs (Phase 2; reused, not re-authored).
- [`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) — canonical chords for the switcher, pane navigation, and the Vim-interplay resolution.
- [`../blueprint/14-tech-decisions.md`](../blueprint/14-tech-decisions.md) — where the Phase-0 bridge-vs-fallback decision is recorded.

Plan:

- [`./README.md`](./README.md) — phase map, the global Definition of Done, conventions (bun, Biome, Convex-as-only-write-path, commit policy), and the carried risk register.
- [`./phase-0-spikes.md`](./phase-0-spikes.md) — the throwaway spike that proved the live bridge or selected the fallback (**read its recorded decision before starting E3**).
- [`./phase-1-foundation.md`](./phase-1-foundation.md), [`./phase-2-modes-and-losslessness.md`](./phase-2-modes-and-losslessness.md) — prerequisites.
- [`./phase-4-history.md`](./phase-4-history.md) — undo-tree visualizer + version history (next phase; out of scope here).

External:

- `react-resizable-panels` — <https://github.com/bvaughn/react-resizable-panels> (nested resizable groups; size round-trip via `onLayout` / `defaultSize`).
- `cmdk` — the command/switcher primitive.
- `prosemirror-recreate-steps` / `recreateTransform` — doc-diff → steps for raw→rich (pinned by Phase 0).
