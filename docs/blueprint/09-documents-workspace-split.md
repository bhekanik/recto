# 09 — Documents, Workspace & Split Panes

> Part of the [Recto Blueprint](./README.md). This file is self-contained: it restates the canon it depends on so you can read it alone. Where it touches another area, it cross-references the sibling file by exact filename. If anything here contradicts [`README.md`](./README.md), **the README wins**.

This document specifies three tightly related capabilities:

1. **Documents** — the unit of writing. Listing, creating, renaming, deleting, switching, and the document switcher UI.
2. **Split panes** — the recursive binary `paneTree` that tiles the writing surface into nested vertical/horizontal splits, each leaf a **pane** that binds one document to one mode.
3. **Workspace** — the single persisted record per user (the `workspaces` table) that captures *which documents are open*, *how the surface is split*, and *what each pane was doing* — so a second machine opens to the same arrangement. This is the literal mechanism behind Product Principle 1, "Open and write… the last document and layout are restored."

This is the feature set of **Phase 3** in the plan. See [`../plan/phase-3-multi-doc-split-workspace.md`](../plan/phase-3-multi-doc-split-workspace.md) for build order, exit criteria, and risks.

---

## 0. Canon this file depends on (restated)

From [`README.md`](./README.md) — do not contradict these:

- **D2** — Modes are **views of one canonical model**, never format-to-format conversions.
- **D6** — The **same document may be open in two live, editable modes at once** (rich + raw), kept in sync keystroke-by-keystroke. The pane tree is what makes this physically visible.
- **D10** — Backend is **Convex**, with **debounced last-write-wins snapshot** sync. No `prosemirror-sync` / Yjs / CRDT.
- **D11** — The **local editor owns live state**; the editor is *never* a controlled component of a reactive query. Workspace state is hydrated on open, not bound live.
- **D13** — Dark only.
- **D14** — Next.js (App Router), TypeScript strict, **bun**, ESM.

Canonical names used throughout (use these exact spellings everywhere):

| Name | Meaning |
|------|---------|
| `documents` | Convex table; one row per piece of writing. |
| `workspaces` | Convex table; **one row per user**; the persisted "resume where I left off" record. |
| `paneTree` | Field on `workspaces`; JSON string of the recursive split layout. |
| `openDocumentIds` | Field on `workspaces`; the set of `Id<"documents">` currently open. |
| `activePaneId` | Field on `workspaces`; the `paneId` of the focused pane. |
| `perPaneViewState` | Field on `workspaces`; JSON string of per-pane mode + cursor/scroll. |
| **Pane** | A *leaf* of the `paneTree`; binds one `documentId` to one `mode`. |
| **Workspace** | The persisted set of open documents + `paneTree` + per-pane state, restored on load. |

Glossary alignment (verbatim from [`README.md`](./README.md) §11): *Pane* — a leaf in the split layout; binds one document to one mode. *Pane tree* — the recursive vertical/horizontal split layout of panes. *Workspace* — the persisted set of open documents + pane tree + per-pane state, restored on load.

---

## 1. Documents

### 1.1 The `documents` table (canon)

From [`README.md`](./README.md) §7 and [`03-data-model.md`](./03-data-model.md). The full validators and indexes live in [`03-data-model.md`](./03-data-model.md); this is the contract this file operates against.

```ts
documents: {
  userId: Id<"users">,
  title: string,
  markdown: string,         // canonical serialized Markdown (source of truth at rest)
  wordCount: number,
  currentNodeId: string,    // pointer into the undo-tree DAG (docNodes.nodeId)
  createdAt: number,
  updatedAt: number,
}                            // index: by_user (userId), by_user_updated (userId, updatedAt)
```

The fields that matter to *this* document:

| Field | Role in documents/workspace UX |
|-------|--------------------------------|
| `title` | Shown in the document switcher, the open-documents list, and pane headers. Derived (see §1.4) but editable. |
| `markdown` | The at-rest canonical form. **Never** rendered directly by a pane; a pane hydrates an in-memory canonical model from it (see [`02-architecture.md`](./02-architecture.md)). |
| `wordCount` | Surfaced in the switcher and pane status; always available (D15). |
| `updatedAt` | The default sort key for the document list (most-recently-edited first), via the `by_user_updated` index. |

`markdown`, `currentNodeId`, undo (`docNodes`), and version history (`versions`) are *out of scope* for this file; they belong to [`10-sync-persistence.md`](./10-sync-persistence.md), [`07-undo-tree.md`](./07-undo-tree.md), and [`08-version-control.md`](./08-version-control.md). Here we treat a document as an addressable thing with a title and a word count that can be opened into panes.

### 1.2 Document lifecycle operations

All writes go through Convex mutations (per [`../plan/README.md`](../plan/README.md) conventions: Convex functions are the only write path). Listing is a reactive query. The list query is safe to bind reactively — it is *metadata*, not editor content; the D11 prohibition is about binding an **editor's value** to a query, not about listing titles.

| Operation | What it does | Convex call (illustrative names) | Workspace side effect |
|-----------|--------------|----------------------------------|------------------------|
| **List** | All of the user's documents, newest-edited first. | `query documents.list` over `by_user_updated`. | None. |
| **Create** | New empty document; `title` = `"Untitled"`; empty `markdown`; `wordCount` = 0. | `mutation documents.create`. | Opens the new document into the **active pane** (replacing what it showed) and adds its id to `openDocumentIds`. |
| **Rename** | Set `title`. Manual override of the derived title (§1.4). | `mutation documents.rename`. | Pane headers and switcher relabel reactively. |
| **Delete** | Remove the document and its history rows. | `mutation documents.remove` (cascades `docNodes`/`versions` per [`03-data-model.md`](./03-data-model.md)). | Any pane bound to it must be reconciled — see §1.5. |
| **Switch** | Show an existing document in the active pane. | No mutation; a client action that rebinds the active pane's `documentId`. | Updates `paneTree`, `openDocumentIds`, `perPaneViewState` (debounced save, §4). |

> **Switch ≠ open-in-new-pane.** *Switching* changes what the **active pane** displays. *Splitting* (§3.4) creates a new pane and may open a different document into it. Both are workspace mutations on the client model; only the debounced persist touches Convex (§4).

### 1.3 The document switcher UI

The switcher is the primary way to move between documents without restructuring the layout. It is a **command-palette-style overlay** built on `cmdk` (the same primitive as the global palette; see [`13-keyboard-commands.md`](./13-keyboard-commands.md)), not a persistent sidebar — consistent with Product Principle 5, "the tool disappears."

- **Invocation:** a keyboard shortcut (canonical keymap in [`13-keyboard-commands.md`](./13-keyboard-commands.md)) and a minimal affordance in the chrome.
- **Contents:** every document for the user, sorted by `updatedAt` desc, each row showing `title` and `wordCount`. Fuzzy filter by title as you type.
- **Primary action (Enter):** **switch** the active pane to the chosen document (§1.2).
- **Secondary action (modifier+Enter):** open the chosen document into a **new split** of the active pane (§3.4) — the entry point to multi-doc layouts.
- **Create action:** a persistent "Create new document" row (and a shortcut) that runs `documents.create` and switches the active pane to it.
- **Per-row actions:** rename (inline), delete (with a confirm; see §1.5).

```
┌──────────────────────────────────────────────┐
│  ⌕  search documents…                         │
├──────────────────────────────────────────────┤
│  ＋ Create new document                        │
├──────────────────────────────────────────────┤
│  On Typographic Restraint           1,204 w   │  ← active doc, highlighted
│  Newsletter — June drop               842 w   │
│  Notes: lossless bridge               318 w   │
│  Untitled                               0 w   │
└──────────────────────────────────────────────┘
   Enter → switch active pane    ⇧Enter → open in split
```

The switcher reads the reactive `documents.list` query directly; it has no editor state and therefore no D11 concern.

### 1.4 Titles — derived default

A document has no separate "first line is the title" convention forced on the writer. Instead:

- **Default title is derived** from the canonical model: the text of the **first heading node** (any level, H1–H6) in the MDAST. If there is no heading, or it is empty, the title is **`"Untitled"`**.
- Derivation runs off the canonical model already in memory (see [`02-architecture.md`](./02-architecture.md)) when the document is saved/persisted; it is cheap (one walk to the first heading) and happens on the same debounced persist path as `markdown` and `wordCount` (see [`10-sync-persistence.md`](./10-sync-persistence.md)).
- A **manual rename** (§1.2) sets an explicit `title` that **overrides** derivation. We store a single `title` field (no separate "isManual" flag in the canon schema); the rule is operational: *derivation only writes `title` when the user has not manually set one for the current heading state.* The simplest honest implementation: derivation proposes a title; if the user renamed, the rename wins until they rename again or clear it. Keep the persisted shape exactly the canon `documents` row — no extra fields.

```ts
/** Derive the default title from the canonical MDAST. */
function deriveTitle(root: MdastRoot): string {
  const heading = findFirstHeading(root); // first node of type "heading"
  const text = heading ? mdastToPlainText(heading).trim() : "";
  return text.length > 0 ? text : "Untitled";
}
```

> Why derive rather than force a title field in the editor: it honors Principle 1 (open and write — no title prompt) and Principle 5 (no chrome). The writer types a heading; the document names itself.

### 1.5 Deleting a document that is open in panes

Deletion must never leave a pane pointing at a tombstone. On `documents.remove`:

1. Confirm (documents are precious; deletion is destructive and is *not* the same as closing a pane — closing a pane keeps the document).
2. Remove the document id from `openDocumentIds`.
3. For every leaf pane whose `documentId` is the deleted id: rebind it to **another open document** if one exists (prefer the most-recently-active), else turn it into an **empty pane** (§5.2).
4. If the deletion empties the workspace entirely, fall to the **no-documents empty state** (§5.1).
5. Persist the reconciled workspace (debounced, §4).

---

## 2. The workspace concept

A **workspace** is the persisted answer to "where was I?" It is exactly three things, and nothing more:

1. **Which documents are open** — `openDocumentIds`.
2. **How the surface is split** — `paneTree`.
3. **What each pane was doing** — `perPaneViewState` (the per-pane mode + cursor + scroll), plus `activePaneId` for focus.

There is **one workspace per user** (the `workspaces` table has a `by_user` index and we keep a single row). It is **restored on load** so that opening Recto on a second machine reconstructs the same documents, the same window layout, and the same cursor positions — the literal promise in [`README.md`](./README.md) §1.

The workspace is *layout state*, deliberately separate from *document content*:

- **Document content** (`markdown`, history) lives in `documents` / `docNodes` / `versions` and is owned by [`10-sync-persistence.md`](./10-sync-persistence.md), [`07-undo-tree.md`](./07-undo-tree.md), [`08-version-control.md`](./08-version-control.md).
- **Layout** (which docs, how split, where the cursor sat) lives in the single `workspaces` row.

This separation is why a workspace row stays tiny (§4.3) regardless of how large the documents are.

### 2.1 Restore on load (cross-device resume)

On app load:

1. Read the user's `workspaces` row (one reactive read; *not* bound to any editor).
2. Parse `paneTree` (JSON) and `perPaneViewState` (JSON).
3. For each `documentId` referenced by a leaf, hydrate its canonical model from `documents.markdown` (mechanics in [`02-architecture.md`](./02-architecture.md) and [`10-sync-persistence.md`](./10-sync-persistence.md)). **Reference-counted, deduplicated** — a document referenced by two panes is loaded once (see §2.2 / §3.5).
4. Mount the `react-resizable-panels` tree from `paneTree`; restore each leaf's `mode`, cursor and scroll from `perPaneViewState`.
5. Focus the pane named by `activePaneId`.
6. Reconcile dangling references (a `documentId` deleted on another device): drop it from `openDocumentIds`, rebind/empty its panes (§1.5), and re-persist.

If there is no `workspaces` row yet (brand-new user), synthesize a default workspace: one pane, no document (the empty-pane state, §5.2) or a freshly created `"Untitled"` document — see §5.1.

---

## 3. Split panes — the pane tree model

The writing surface is tiled by a **recursive binary tree of splits**. Internal nodes are *splits*; leaves are *panes*.

- An **internal (split) node** has a `direction` (`"vertical" | "horizontal"`), an ordered list of children, and per-child `sizes` (percentages summing to 100). It is binary in the canonical sense — each split introduces two children — but the type permits an ordered children array so adjacent same-direction splits can be flattened into one resizable group (this maps cleanly onto how `react-resizable-panels` represents a `PanelGroup` with N `Panel`s; see §3.6).
- A **leaf (pane) node** binds one document to one mode: `{ paneId, documentId, mode, viewState }`, where `viewState` holds cursor/scroll for that pane.

Direction semantics (matching `react-resizable-panels`' `PanelGroup direction`):

| `direction` | Children are arranged | Resizer drag axis |
|-------------|-----------------------|-------------------|
| `"horizontal"` | side by side (left ↔ right columns) | horizontal |
| `"vertical"` | stacked (top ↕ bottom rows) | vertical |

### 3.1 TypeScript type for the pane tree

This is the in-memory shape. The persisted `paneTree` field is **`JSON.stringify` of the root `PaneNode`** (Convex stores it as a `string` per canon, §4.1).

```ts
/** One of the four lenses from 04-editor-modes.md. */
type Mode = "rich" | "raw" | "vim" | "preview";

/** Cursor + scroll for a single pane. Document-position based so it
 *  survives mode switches via the lossless bridge (see 05-lossless-bridge.md). */
interface PaneViewState {
  /** Selection as offsets into the canonical Markdown string (anchor/head),
   *  mirroring docNodes.selection in 03-data-model.md. Mode-agnostic. */
  selection: { anchor: number; head: number } | null;
  /** Vertical scroll as a fraction [0,1] of the scrollable height, so it
   *  maps across rich/raw/preview without pixel coupling. */
  scrollTop: number;
}

/** A leaf: exactly one document shown through exactly one mode. */
interface PaneLeaf {
  type: "pane";
  paneId: string;            // crypto.randomUUID(); stable for the pane's life
  documentId: Id<"documents">;
  mode: Mode;
  viewState: PaneViewState;
}

/** An internal node: a resizable group of children along one axis. */
interface PaneSplit {
  type: "split";
  direction: "vertical" | "horizontal";
  /** Ordered children; length >= 2. Binary splits produce 2; adjacent
   *  same-direction splits may be flattened into one group of N. */
  children: PaneNode[];
  /** Per-child size as a percentage of this group; same length as children;
   *  sums to ~100. Persisted so 'react-resizable-panels' restores exact sizes. */
  sizes: number[];
}

type PaneNode = PaneLeaf | PaneSplit;

/** The persisted JSON in workspaces.paneTree is JSON.stringify(this root). */
type PaneTree = PaneNode; // root may be a single leaf (no splits yet)
```

Notes:

- `documentId` lives on the **leaf**, not in `viewState`, because two leaves can share one `documentId` (D6; §3.5). The shared thing is the in-memory canonical model keyed by `documentId`; the *pane-local* thing is `viewState` (each pane keeps its own cursor/scroll) and `mode`.
- `paneId` is a `crypto.randomUUID()` (per [`README.md`](./README.md) §6, IDs are built-in; no `uuid` dep) and is the key for `perPaneViewState` and `activePaneId`.
- The same per-pane facts appear in two persisted places by design (see §4.4): the **truth** is the leaf inside `paneTree`; `perPaneViewState` is a denormalized `paneId → { mode, viewState }` map kept for cheap restore and to keep the two clearly named canon fields populated.

### 3.2 JSON example

A two-document layout: on the **left**, the same document open twice — rich text on top, raw Markdown below (the D6 "two live modes" case); on the **right**, a reference document in preview.

```json
{
  "type": "split",
  "direction": "horizontal",
  "sizes": [62, 38],
  "children": [
    {
      "type": "split",
      "direction": "vertical",
      "sizes": [55, 45],
      "children": [
        {
          "type": "pane",
          "paneId": "f0c1a2b3-0001-4aaa-8bbb-000000000001",
          "documentId": "doc_essay",
          "mode": "rich",
          "viewState": { "selection": { "anchor": 412, "head": 412 }, "scrollTop": 0.18 }
        },
        {
          "type": "pane",
          "paneId": "f0c1a2b3-0002-4aaa-8bbb-000000000002",
          "documentId": "doc_essay",
          "mode": "raw",
          "viewState": { "selection": { "anchor": 980, "head": 1024 }, "scrollTop": 0.44 }
        }
      ]
    },
    {
      "type": "pane",
      "paneId": "f0c1a2b3-0003-4aaa-8bbb-000000000003",
      "documentId": "doc_reference",
      "mode": "preview",
      "viewState": { "selection": null, "scrollTop": 0.0 }
    }
  ]
}
```

The companion `workspaces` fields for this layout:

```json
{
  "openDocumentIds": ["doc_essay", "doc_reference"],
  "activePaneId": "f0c1a2b3-0001-4aaa-8bbb-000000000001",
  "perPaneViewState": "{\"f0c1a2b3-0001-...\":{\"mode\":\"rich\",\"viewState\":{\"selection\":{\"anchor\":412,\"head\":412},\"scrollTop\":0.18}},\"f0c1a2b3-0002-...\":{\"mode\":\"raw\",\"viewState\":{\"selection\":{\"anchor\":980,\"head\":1024},\"scrollTop\":0.44}},\"f0c1a2b3-0003-...\":{\"mode\":\"preview\",\"viewState\":{\"selection\":null,\"scrollTop\":0.0}}}"
}
```

Note `doc_essay` appears **once** in `openDocumentIds` though it is bound to two panes — `openDocumentIds` is the *deduplicated set of open documents*, while `paneTree` is the *layout*, which may reference a document more than once.

Rendered shape:

```
┌───────────────── horizontal split (62 / 38) ─────────────────┐
│  ┌───── vertical split (55 / 45) ─────┐  │                    │
│  │  doc_essay · rich  [active]        │  │                    │
│  ├────────────────────────────────────┤  │  doc_reference     │
│  │  doc_essay · raw                   │  │  · preview         │
│  └────────────────────────────────────┘  │                    │
└───────────────────────────────────────────┴────────────────────┘
```

### 3.3 Rendering the tree with `react-resizable-panels`

We use [`react-resizable-panels`](https://github.com/bvaughn/react-resizable-panels) for nested resizable vertical/horizontal splits (chosen in [`README.md`](./README.md) §6). The library natively supports **nested groups** and **persistence of sizes** (its `autoSaveId` / `onLayout`), and its `PanelGroup direction` maps 1:1 onto our `PaneSplit.direction`.

We **do not** lean on the library's own `autoSaveId` localStorage persistence as the source of truth — our truth is the cloud `workspaces` row, because layout must survive across devices (cross-device resume is the whole point). We use the library purely for rendering and for the resize interaction, and we read its `onLayout(sizes)` callback to update our `PaneSplit.sizes` and trigger the debounced workspace save (§4).

```tsx
function RenderPaneNode({ node }: { node: PaneNode }) {
  if (node.type === "pane") {
    return <Pane leaf={node} />; // mounts the right editor for node.mode
  }
  return (
    <PanelGroup
      direction={node.direction}
      onLayout={(sizes) => updateSplitSizes(node, sizes) /* → debounced save */}
    >
      {node.children.map((child, i) => (
        <Fragment key={paneKey(child)}>
          {i > 0 && <PanelResizeHandle />}
          <Panel defaultSize={node.sizes[i]} minSize={MIN_PANE_PERCENT}>
            <RenderPaneNode node={child} />
          </Panel>
        </Fragment>
      ))}
    </PanelGroup>
  );
}
```

- `direction="horizontal"` → side-by-side columns; `direction="vertical"` → stacked rows (matches the table in §3).
- `defaultSize` is seeded from our persisted `sizes`, so restore is exact.
- `MIN_PANE_PERCENT` enforces a sane minimum so a pane can't collapse to nothing.
- A stable React key (`paneKey`) keyed off `paneId` (and a structural key for splits) prevents the library from remounting editors on resize/reorder — remounting an editor would drop live state, violating D11.

### 3.4 Pane operations

All pane operations mutate the **in-memory** `PaneTree` (and the `perPaneViewState`/`activePaneId` map), then schedule a debounced persist (§4). None of them block on the network (Principle 4, "snappy is a feature").

| Operation | Effect on the tree | Notes |
|-----------|--------------------|-------|
| **Split a pane vertically** | Replace the target `PaneLeaf` with a `PaneSplit { direction: "vertical", children: [original, newLeaf], sizes: [50, 50] }`. | New stacked row below. |
| **Split a pane horizontally** | Same, with `direction: "horizontal"`. | New column beside. |
| **Open a document into a pane** | Set the (active or target) leaf's `documentId`; reset/seed its `viewState`; ensure id in `openDocumentIds`. | From the switcher (§1.3) or palette. |
| **Change a pane's mode** | Set the leaf's `mode` (one of rich/raw/vim/preview). | The lossless mode switch itself is owned by [`04-editor-modes.md`](./04-editor-modes.md); here we only record the new `mode`. Cursor is preserved via document-position `viewState` + the bridge ([`05-lossless-bridge.md`](./05-lossless-bridge.md)). |
| **Focus a pane** | Set `activePaneId`. | Drives keyboard target and visual emphasis. |
| **Resize** | Update the parent `PaneSplit.sizes` from `react-resizable-panels`' `onLayout`. | Debounced; sizes are percentages. |
| **Close a pane** | Remove the leaf; **collapse** its parent split (§3.4.1). | The *document is not deleted* — only the pane. Update `openDocumentIds` (§3.4.2). |

If the new-split flattening optimization is enabled (§3.1), splitting a pane in the **same** direction as its parent appends a child to the parent group instead of nesting a new binary split — keeping the tree shallow and the JSON small (§4.3).

#### 3.4.1 Closing a pane and collapsing splits

When a leaf is removed, its parent split must not be left with a single child. Collapse rules:

1. Remove the leaf from `parent.children` and drop its corresponding entry in `parent.sizes`.
2. **Renormalize** the remaining `sizes` to sum to 100.
3. If `parent.children.length === 1`, **replace the parent split with its sole remaining child** (collapse). Repeat up the tree as needed.
4. If the removed pane was the `activePaneId`, focus moves to a sibling/nearest leaf (§3.7) and `activePaneId` is updated.
5. If the **last** pane in the whole tree is closed, fall to the **empty-pane** state (§5.2) — there is always at least one pane.

```ts
function closePane(tree: PaneNode, paneId: string): PaneNode {
  // Walk to the parent split, drop the leaf, renormalize sizes,
  // collapse single-child splits up the chain. Returns the new root.
  // (Pure function over PaneTree; never mutates in place.)
}
```

#### 3.4.2 Reference counting `openDocumentIds`

`openDocumentIds` is the deduplicated set of documents referenced by *any* leaf. Maintain it as the set of distinct `documentId`s across the tree:

- **Open / split-in** a document → ensure its id is present.
- **Close a pane / change a pane's document** → if **no remaining leaf** references the old `documentId`, drop it from `openDocumentIds` *and* release its in-memory canonical model (§3.5).

```ts
function openDocumentIdsFromTree(root: PaneNode): Id<"documents">[] {
  const ids = new Set<Id<"documents">>();
  walkLeaves(root, (leaf) => ids.add(leaf.documentId));
  return [...ids];
}
```

### 3.5 Same document in multiple panes (D6)

This is intended and load-bearing. When two (or more) leaves carry the **same `documentId`**, they **share exactly one in-memory canonical model** — the MDAST keyed by `documentId` described in [`02-architecture.md`](./02-architecture.md). They do **not** each hold an independent copy.

```
                 panes keyed by paneId
   ┌──────────────┐        ┌──────────────┐
   │ pane A        │        │ pane B        │
   │ documentId=X  │        │ documentId=X  │
   │ mode=rich     │        │ mode=raw      │
   │ viewState A   │        │ viewState B   │   ← per-pane cursor/scroll
   └──────┬────────┘        └──────┬────────┘
          │     both bind to       │
          ▼                        ▼
        ┌──────────────────────────────┐
        │  ONE canonical MDAST for X    │  ← shared in memory (02-architecture.md)
        │  (the bus; 05-lossless-bridge)│
        └──────────────────────────────┘
                      │ debounced persist (10-sync-persistence.md)
                      ▼
              documents.markdown (X)
```

How two panes of one document in different modes stay **live**:

1. Both panes are *views* of the one canonical model (D2). Pane A's Milkbown/rich editor and Pane B's CodeMirror/raw editor are both projections of the same MDAST.
2. A keystroke in either pane is reconciled into the shared canonical model through the **lossless bridge** ([`05-lossless-bridge.md`](./05-lossless-bridge.md)): the bridge is the MDAST bus, with origin-guarded, throttled, cursor-preserving diffs in both directions. The other pane re-projects from the updated model. This is the concrete realization of D6 — "two live, editable modes at once, kept in sync keystroke-by-keystroke."
3. **`viewState` is per-pane, not shared.** Pane A keeps its own cursor and scroll; Pane B keeps its own. Only the *content* is shared. That is why `viewState` lives on the leaf and is keyed by `paneId` in `perPaneViewState`, while the canonical model is keyed by `documentId`.
4. Because the model is shared (not two copies round-tripping through Markdown), there is no progressive degradation — the failure mode D2/§2 of [`README.md`](./README.md) exists to reject. The bridge guarantees losslessness; the pane tree just decides *how many windows look at the one model*.

The fallback (from the plan's risk register) if same-pane live two-mode sync proves janky: same-document panes degrade to switch-on-mode, while **different documents in different panes always stay independently live** (they don't even share a model, so there is nothing to sync). The pane tree model supports both without schema change — only the bridge's behavior differs.

### 3.6 Why `react-resizable-panels` fits

- **Nested groups:** a `PanelGroup` can contain a `Panel` that itself contains another `PanelGroup` — exactly our recursive `PaneSplit` → `PaneSplit`/`PaneLeaf`.
- **Direction:** `PanelGroup direction="horizontal" | "vertical"` is our `PaneSplit.direction`.
- **Size persistence:** the library reports layout via `onLayout(sizes: number[])` and accepts `defaultSize`, so we round-trip our `sizes` array exactly. We persist to the cloud `workspaces` row rather than its localStorage `autoSaveId`, because layout must cross devices.
- **Resize handles:** `PanelResizeHandle` between panels; we style it as a thin, low-chrome divider per [`12-design-system.md`](./12-design-system.md).

Reference: <https://github.com/bvaughn/react-resizable-panels>.

### 3.7 Keyboard navigation between panes

Focus is keyboard-first (Principle 5; full keymap in [`13-keyboard-commands.md`](./13-keyboard-commands.md)). The canonical *behaviors* this file specifies (the exact chords are owned by [`13-keyboard-commands.md`](./13-keyboard-commands.md)):

- **Move focus** to the pane in a direction (left/right/up/down) — spatial navigation over the rendered geometry; sets `activePaneId`.
- **Cycle focus** to the next/previous pane in tree order.
- **Split active pane** vertically / horizontally.
- **Close active pane**.
- **Change active pane's mode** (rich/raw/vim/preview) — defers to [`04-editor-modes.md`](./04-editor-modes.md).
- **Open switcher** (§1.3) targeting the active pane.

Vim interaction: when the active pane is in **vim** mode, pane-navigation chords must not collide with Vim normal-mode motions. The resolution rule (detailed in [`13-keyboard-commands.md`](./13-keyboard-commands.md)): pane navigation uses a dedicated modifier prefix so it is unambiguous regardless of the active pane's mode and Vim sub-mode.

---

## 4. Workspace persistence

### 4.1 The `workspaces` table (canon)

Verbatim from [`README.md`](./README.md) §7 (full validators in [`03-data-model.md`](./03-data-model.md)):

```ts
workspaces: {               // one per user; "resume where I left off"
  userId: Id<"users">,
  paneTree: string,         // JSON: recursive split layout (this file, §3)
  openDocumentIds: Id<"documents">[],
  activePaneId: string,
  perPaneViewState: string, // JSON: per-pane mode + cursor/scroll
  updatedAt: number,
}                            // index: by_user (userId)
```

Field-by-field, as produced by this document:

| Field | Source | Serialization |
|-------|--------|---------------|
| `paneTree` | The in-memory `PaneTree` root (§3.1). | `JSON.stringify(root)`. The full recursive split layout. |
| `openDocumentIds` | `openDocumentIdsFromTree(root)` (§3.4.2). | Native Convex array of `Id<"documents">`. Deduplicated set of open docs. |
| `activePaneId` | The focused leaf's `paneId`. | Plain string. |
| `perPaneViewState` | `paneId → { mode, viewState }` map (§4.4). | `JSON.stringify(map)`. Per-pane mode + cursor/scroll. |
| `updatedAt` | Set by the mutation. | Number (ms epoch); the last-write-wins clock (§4.5). |

### 4.2 Debounced save (off the hot path)

Workspace persistence follows the same discipline as content persistence in [`10-sync-persistence.md`](./10-sync-persistence.md): **the local model owns live state; the cloud is updated by a debounced mutation.** The editor is never a controlled component of the workspace query (D11).

Any of these schedule a debounced `workspaces.save` mutation:

- Pane structural change: split, close, open-document-into-pane, change-mode.
- Focus change: `activePaneId` update.
- Resize: `react-resizable-panels` `onLayout` (this is the *chattiest* source — debounce is essential).
- Cursor/scroll change within a pane: updates `viewState` → `perPaneViewState`.

```ts
// Single debounced writer; coalesces a burst of changes into one mutation.
const saveWorkspace = debounce((ws: WorkspaceSnapshot) => {
  void convex.mutation(api.workspaces.save, {
    paneTree: JSON.stringify(ws.root),
    openDocumentIds: openDocumentIdsFromTree(ws.root),
    activePaneId: ws.activePaneId,
    perPaneViewState: JSON.stringify(ws.perPaneViewState),
  });
}, WORKSPACE_SAVE_DEBOUNCE_MS); // e.g. ~500ms; tuned in 10-sync-persistence.md
```

- Cursor/scroll churn (which is constant during normal use) is debounced harder / or flushed only on idle and on focus/structure changes — restoring the cursor to a *recent* position is enough; it does not need to be the last keystroke's pixel. The debounce constants are owned by [`10-sync-persistence.md`](./10-sync-persistence.md).
- A flush on `beforeunload`/visibility-hidden best-effort persists the final layout so a quick close still resumes correctly.

### 4.3 Keep the row tiny (Convex ~1 MiB ceiling)

[`README.md`](./README.md) §5/§7 and [`03-data-model.md`](./03-data-model.md) note Convex's ~1 MiB per-value ceiling. The `workspaces` row must stay **well under** it. It does so naturally because it contains **no document content** — only structure and small scalars:

- `paneTree`: a handful of nested nodes; each leaf is four small fields. A realistic layout (2–6 panes) is a few hundred bytes to low single-digit KB. Flattening same-direction splits (§3.1) keeps depth and node count down.
- `perPaneViewState`: one small object per pane (`mode` + two numbers).
- `openDocumentIds`: a short array of ids.

There is **no scenario** in single-user article writing where this row approaches 1 MiB. To keep it that way: never store document text, history, or rendered HTML in the workspace; cap the practical number of simultaneously open panes (a soft UI limit, not a schema constraint); and keep `viewState` to offsets + a fraction, not serialized editor state.

### 4.4 `paneTree` vs `perPaneViewState` — why both, and reconciliation

Both fields carry per-pane `mode` + `viewState`. This is deliberate and matches the canon (the README lists `perPaneViewState` as a distinct field). The rule:

- **`paneTree` is the structural truth** — it defines existence, nesting, sizes, document binding, mode, and the leaf's `viewState`.
- **`perPaneViewState` is a denormalized `paneId → { mode, viewState }` index**, convenient for fast per-pane restore and for satisfying the named canon field without walking the tree.

On **save**, derive `perPaneViewState` from the tree's leaves so they cannot diverge:

```ts
function perPaneViewStateFromTree(root: PaneNode): Record<string, { mode: Mode; viewState: PaneViewState }> {
  const map: Record<string, { mode: Mode; viewState: PaneViewState }> = {};
  walkLeaves(root, (leaf) => {
    map[leaf.paneId] = { mode: leaf.mode, viewState: leaf.viewState };
  });
  return map;
}
```

On **restore**, the `paneTree` is authoritative for structure; `perPaneViewState` is used to hydrate (or sanity-check) each leaf's `mode`/`viewState`. If they disagree (e.g., a partial write), the `paneTree` wins; orphan entries in `perPaneViewState` whose `paneId` is absent from the tree are dropped.

### 4.5 Cross-device resume semantics (last-write-wins)

There is one `workspaces` row per user (`by_user`). Two machines editing layout concurrently is resolved by **last-write-wins on the workspace row** — consistent with D10 ("debounced last-write-wins snapshot sync"). The whole row is the unit; `updatedAt` is the clock. The most recent `workspaces.save` mutation defines the layout every device then converges to via the reactive read.

This is acceptable and intentional because:

- The workspace is *layout*, not content. Losing a layout tweak (a pane size, a focus change) costs nothing irreversible. Document **content** has its own, much stronger safety net — the branching undo tree and version history ([`07-undo-tree.md`](./07-undo-tree.md), [`08-version-control.md`](./08-version-control.md)) — and content sync is governed separately by [`10-sync-persistence.md`](./10-sync-persistence.md). LWW on layout does **not** put a single word at risk.
- Single-user means truly-simultaneous two-machine layout edits are rare. The plan's risk register ([`../plan/README.md`](../plan/README.md)) lists "same doc edited on two devices within debounce window" and accepts rare last-write-wins for layout, with version history as the content safety net.

Restore always reflects the latest persisted row, so opening machine B after machine A's debounce flushes reconstructs A's arrangement — the "second machine opens to the same arrangement" promise. Dangling references (a document deleted elsewhere) are reconciled on load (§2.1 step 6).

---

## 5. Empty states

### 5.1 No documents yet

First run, or after deleting the last document. The workspace cannot reference anything, so:

- Render a single full-surface pane in an **inviting empty state**: a centered, low-chrome prompt to start writing, honoring Principle 1 ("open and write") and the dark, typography-first design ([`12-design-system.md`](./12-design-system.md)).
- The primary action **creates a `"Untitled"` document** (`documents.create`) and binds it to that pane in **rich** mode, cursor ready. The document switcher's "Create new document" row (§1.3) and its shortcut do the same.
- We may auto-create the first `"Untitled"` document on first run so the cursor is literally ready on load (Principle 1), or present the prompt — either keeps the workspace valid. The default is to show the prompt rather than litter the document list with stray empties; an explicit create is one keystroke away.

```
┌──────────────────────────────────────────────┐
│                                                │
│                                                │
│              Start writing.                    │
│        ⏎  Create a new document                │
│        ⌘K Open the document switcher           │
│                                                │
│                                                │
└──────────────────────────────────────────────┘
```

### 5.2 An empty pane

A pane can exist without a bound document — after closing the last document out of it, after deleting the document it showed (§1.5), or as the lone pane in a fresh workspace. An empty pane:

- Is a valid `PaneLeaf` whose `documentId` is unset (a nullable binding) and `mode` defaults to `rich`. (Schema note: the canon `PaneLeaf` carries a `documentId`; an empty pane uses a sentinel/`null` binding in the in-memory model and is simply not counted in `openDocumentIds`. This is the one place a leaf has no document.)
- Renders a compact prompt: **open a document** (invokes the switcher targeting this pane, §1.3) or **create a new document** into this pane.
- Counts as a real pane for navigation (§3.7) and collapse (§3.4.1): there is **always at least one pane** in the tree; closing the final pane yields an empty pane, never an empty tree.

```
┌──────────────── empty pane ────────────────┐
│                                              │
│        No document open here.                │
│   ⏎ Open a document   ⌥⏎ Create new          │
│                                              │
└──────────────────────────────────────────────┘
```

---

## 6. Cross-references (siblings)

- [`02-architecture.md`](./02-architecture.md) — the single in-memory canonical model keyed by `documentId` that panes share; client/server split; how a pane hydrates from `documents.markdown`.
- [`04-editor-modes.md`](./04-editor-modes.md) — the four modes a leaf's `mode` can take; the lossless mode-switch a pane performs when its `mode` changes; the mode indicator.
- [`05-lossless-bridge.md`](./05-lossless-bridge.md) — the MDAST bus that keeps two panes of the **same** document in different live modes synchronized keystroke-by-keystroke (D6); origin-guarded, throttled, cursor-preserving diffs.
- [`10-sync-persistence.md`](./10-sync-persistence.md) — the debounce machinery and constants shared by workspace and content persistence; local-owns-live (D11); cross-device convergence; offline behavior.
- [`03-data-model.md`](./03-data-model.md) — full validators, indexes, and Convex limits for `documents` and `workspaces`.
- [`07-undo-tree.md`](./07-undo-tree.md) / [`08-version-control.md`](./08-version-control.md) — the content safety net that makes layout last-write-wins (§4.5) acceptable.
- [`../plan/phase-3-multi-doc-split-workspace.md`](../plan/phase-3-multi-doc-split-workspace.md) — the implementation phase that builds everything in this file: document switcher, nested split panes, same-doc-two-live-modes, workspace persistence and cross-device resume.

External: `react-resizable-panels` — <https://github.com/bvaughn/react-resizable-panels> (nested resizable groups; size persistence via `onLayout`/`defaultSize`).
