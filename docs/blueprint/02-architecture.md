# Recto — Architecture

> **Scope of this file.** This document specifies Recto's system architecture: the single rule the entire system is organized around, the canonical document model, the runtime topology (client vs server), the data flow for a single edit, the in-memory model lifecycle, the module/package layout, the state-management discipline, and the error/recovery posture. It closes by tying the design back to the product principles.
>
> This file expands §2 ("The one architectural rule everything depends on") and §6–§7 of [`README.md`](./README.md). If anything here contradicts [`README.md`](./README.md), **the README wins** — open an issue and reconcile. This file never contradicts locked decisions **D1–D15**.
>
> **Sibling cross-references used throughout:** the live two-mode mechanics live in [`./05-lossless-bridge.md`](./05-lossless-bridge.md); the Convex schema and storage limits live in [`./03-data-model.md`](./03-data-model.md); the sync/debounce/offline contract lives in [`./10-sync-persistence.md`](./10-sync-persistence.md); the branching undo DAG lives in [`./07-undo-tree.md`](./07-undo-tree.md).

---

## 1. The one rule

> **There is a single canonical document. Every mode is a *view* (projection) of it. Modes never convert between two competing formats.** (Locked: **D2**.)

Recto presents one piece of writing through four interchangeable lenses — **rich text**, **raw Markdown**, **Vim**, and **preview** (§1 of [`README.md`](./README.md)). It is tempting to implement these as four independent editors that hand documents to each other on switch: rich text serializes to Markdown when you leave it; the raw editor parses that Markdown back into a rich tree when you return. **Recto explicitly rejects that design.** There is exactly one document representation. Every lens reads from it and writes to it. No lens owns a private, competing copy in a different format.

### 1.1 Why this is the *only* design that makes "lossless" true

"Lossless" is a locked product promise: *a document that round-trips rich → raw → rich must come back byte-stable within the supported dialect* (Product principle 3, §4 of [`README.md`](./README.md)). There are only two ways to build a multi-mode editor, and only one of them can keep that promise.

**The rejected design — format-to-format conversion (peer formats).** Each mode holds its own native representation, and switching modes converts between them:

```
   ┌──────────┐   serialize    ┌──────────┐   parse     ┌──────────┐
   │   rich   │ ─────────────▶ │ markdown │ ──────────▶ │   rich   │
   │ (format) │ ◀───────────── │ (format) │ ◀────────── │ (format) │
   └──────────┘    parse       └──────────┘  serialize  └──────────┘
        every switch is a transform; transforms compose; error accumulates
```

In this design each switch is a *transform*, and transforms **compose**. Any construct that two formats represent differently — a footnote, a table cell's alignment, a list's loose/tight spacing, a hard line break, a frontmatter key order — drifts a little on each crossing. The drift compounds. Switch back and forth enough and the document degrades. This is a documented, real failure mode (catalogued in [`./14-tech-decisions.md`](./14-tech-decisions.md)), and it is fatal to principle 3.

**The chosen design — single canonical model with projections (D1, D2).** There is one representation. Modes are not peers that convert to each other; they are **views (projections)** of the same underlying object:

```
                         ┌───────────────────────────┐
                         │   CANONICAL MODEL (D1)     │
                         │   remark MDAST (in memory) │
                         └───────────────────────────┘
              project ↗        project ↑        project ↖   project ↑
          ┌──────────┐    ┌──────────┐    ┌──────────┐  ┌──────────┐
          │   rich   │    │   raw    │    │   vim    │  │ preview  │
          │ (a VIEW) │    │ (a VIEW) │    │ (a VIEW) │  │ (a VIEW) │
          └──────────┘    └──────────┘    └──────────┘  └──────────┘
                  switching a lens does NOT transform the document
```

Switching a lens does not transform anything. It changes *which projection you are looking at* — the canonical object is untouched. Because there is no transform on the path, there is nothing to accumulate error. Round-trip stability collapses to a single, testable property on the canonical layer: `serialize(parse(markdown)) === normalize(markdown)` for every supported construct (the round-trip contract, §8 and Glossary of [`README.md`](./README.md); enforced by the corpus in [`./06-markdown-dialect.md`](./06-markdown-dialect.md)). Losslessness is therefore a property of **one** boundary, not of an N×N web of mode-to-mode conversions. That is why this is the only design under which "lossless" can be true rather than merely close.

> Practical corollary (D2, and §8 of [`README.md`](./README.md)): the rich editor may **only** produce constructs expressible in the supported Markdown dialect. There are no rich-only features without a Markdown representation, because a rich-only feature would have nowhere to live in the canonical model.

---

## 2. The canonical model

> **Locked (D1):** the canonical document is a **remark MDAST** held in memory while editing, and **persisted to Convex as a Markdown string**.

The canonical model has two faces of the *same* truth:

| Face | Representation | When it is the operative form | Owner |
|------|----------------|-------------------------------|-------|
| **In memory (editing)** | remark **MDAST** (the `remark`/`unified` Markdown AST) | While a document is open and being edited | The client (see §4) |
| **At rest (persistence)** | A **Markdown string** | When stored/synced in Convex `documents.markdown` | Convex (see §3, [`./03-data-model.md`](./03-data-model.md)) |

These are not two different documents. The Markdown string is `remark-stringify(MDAST)`, and the MDAST is `remark-parse(markdown)`. The string is the durable, transport- and storage-friendly serialization; the tree is the live, editable form. The **unified pipeline** (`unified`, `remark-parse`, `remark-stringify`, `remark-gfm`, `remark-frontmatter`; §6 of [`README.md`](./README.md)) is the only code allowed to cross between them, and it does so deterministically — which is exactly what makes the round-trip property checkable.

### 2.1 Why "Milkdown's document model *is* remark MDAST" is the load-bearing fact

The rich-text engine is **Milkdown** (D3): a ProseMirror-based WYSIWYG editor whose own internal document model is a remark MDAST. This is not an implementation detail — it is the keystone of the whole architecture.

Because Milkdown's document *is* the canonical MDAST:

- **Rich editing is not "convert to Markdown later."** It is editing the canonical tree directly. When you bold a word or insert a table in the rich view, you are mutating the same MDAST that *is* the document. There is no later serialization step that could lose information, because there is no second format to serialize *into* — the rich editor was already operating on the canonical form.
- There is **no rich-only representation** that has to be reconciled. The thing the user manipulates with formatting and slash commands and the thing we persist are the same structure.
- The "lossless" boundary (§1.1) is preserved even while editing rich text, because rich editing never leaves the canonical layer.

Contrast a generic WYSIWYG editor whose native model is HTML or a bespoke JSON: there, rich editing produces a *non-Markdown* structure, and you are forced back into the rejected format-to-format design. Milkdown is chosen precisely so that the rich lens is a projection rather than a competing format (this rationale is recorded in [`./14-tech-decisions.md`](./14-tech-decisions.md)).

### 2.2 How CodeMirror edits the serialized string

The **raw Markdown** and **Vim** lenses are **CodeMirror 6** (D4: `@codemirror/lang-markdown`, plus `@replit/codemirror-vim` for the Vim lens). CodeMirror is a *text* editor — its model is a flat string of characters, not a tree. So the raw and Vim lenses edit the **serialized canonical Markdown string** directly.

That means the canonical model exists in two concrete in-memory shapes depending on which lens is *currently driving the edit*, but they are kept identified with each other by the unified pipeline:

```
   rich lens edit  →  mutate MDAST            →  (serialize) → Markdown string
   raw/vim edit    →  mutate Markdown string  →  (parse)     → MDAST
```

When the active lens is rich, the MDAST is authoritative and the string is derived. When the active lens is raw/Vim, the string is authoritative and the MDAST is derived. In both cases the unified pipeline keeps the two faces consistent, and when *two live lenses of the same document are open at once* (D6), the **bridge** ([`./05-lossless-bridge.md`](./05-lossless-bridge.md)) is what keeps the MDAST and the string in lockstep keystroke-by-keystroke, using the MDAST as the shared bus and origin-guarded, cursor-preserving diffs in both directions.

### 2.3 Preview is a pure read-only projection

The **preview** lens (D5) renders the MDAST to HTML via `remark-rehype` → `rehype-sanitize` → `rehype-stringify` (§6 of [`README.md`](./README.md)). It is read-only and writes nothing back. Crucially it reuses the *same* AST — there is no second Markdown parser that could drift from the editing one. Preview is the cleanest example of a pure projection: same canonical tree in, HTML out, no path back.

---

## 3. System overview

The canonical MDAST sits at the center. The four lenses are projections of it on the client. Convex sits below as the durable, reactive store. Persistence is **debounced snapshot** writes; restoration is **reactive hydrate** (D10, D11; full contract in [`./10-sync-persistence.md`](./10-sync-persistence.md)).

```
 ┌──────────────────────────────────────── CLIENT (browser) ─────────────────────────────────────────┐
 │                                                                                                     │
 │   ┌───────────┐     ┌───────────┐                  ┌───────────┐                  ┌──────────────┐  │
 │   │   RICH    │     │    RAW    │                  │    VIM    │                  │   PREVIEW    │  │
 │   │ Milkdown  │     │ CodeMirror│                  │ CodeMirror│                  │ remark-rehype│  │
 │   │ (D3)      │     │ 6 (D4)    │                  │ 6 + vim   │                  │ +sanitize(D5)│  │
 │   │ EDITS THE │     │ EDITS THE │                  │ EDITS THE │                  │  READ-ONLY   │  │
 │   │  MDAST    │     │  STRING   │                  │  STRING   │                  │  projection  │  │
 │   └─────┬─────┘     └─────┬─────┘                  └─────┬─────┘                  └──────▲───────┘  │
 │         │ projection      │ projection                  │ projection                    │ render    │
 │         ▼                 ▼                              ▼                               │           │
 │   ┌───────────────────────────────────────────────────────────────────────────────────────────┐   │
 │   │                          CANONICAL MODEL  —  remark MDAST (in memory) (D1)                   │   │
 │   │                one per OPEN document; shared by every pane showing that document            │   │
 │   │            ◀── unified pipeline: remark-parse / remark-stringify (the only crossing) ──▶     │   │
 │   │            ◀────────────── BRIDGE keeps live lenses in lockstep (D6, ./05) ─────────────▶    │   │
 │   └───────────────────────────────────────────────────────────────────────────────────────────┘   │
 │         │                                                            ▲                               │
 │         │ debounced snapshot mutation (off the hot path, D10/D11)    │ reactive hydrate (useQuery)   │
 └─────────┼────────────────────────────────────────────────────────── │ ──────────────────────────────┘
           ▼                                                            │
 ┌──────────────────────────────────────── CONVEX (server) ──────────────────────────────────────────┐
 │                                                                                                     │
 │   documents   markdown (canonical string at rest) · title · wordCount · currentNodeId · timestamps  │
 │   docNodes    append-only branching undo-tree DAG; immutable nodes; delta patch + periodic snapshot │
 │   versions    tagged references into docNodes (auto + manual)                                       │
 │   workspaces  one per user: paneTree · openDocumentIds · activePaneId · perPaneViewState            │
 │                                                                                                     │
 │   Better Auth (D12) scopes every row to one user · last-write-wins snapshot sync (D10)              │
 └─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Notes on the diagram (all locked or sibling-specified):

- The four boxes at the top are **views**, not stores — they all point inward at the one canonical model (D2).
- Only the **rich** lens edits the tree; **raw/Vim** edit the string; **preview** only reads. The pipeline and the bridge reconcile these (§2.2, [`./05-lossless-bridge.md`](./05-lossless-bridge.md)).
- The downward arrow is a **debounced** mutation, never a per-keystroke write (D11; [`./10-sync-persistence.md`](./10-sync-persistence.md)).
- The upward arrow is **reactive hydration** via Convex `useQuery`, used on open/idle — never bound directly into a live editor's value (D11; §7).
- The four Convex tables and their indexes are canon; their exact validators and limits are in [`./03-data-model.md`](./03-data-model.md).

---

## 4. Client vs server responsibilities

The split is deliberate and locked by **D10 / D11**: **the client owns everything about editing and the live model; Convex owns everything about persistence, synchronization, and identity.** The editor is *never* a controlled component of a reactive query.

| Concern | Owner | Detail |
|---------|-------|--------|
| The live canonical MDAST | **Client** | The authoritative editing state lives in memory in the browser (D1, D11). |
| Rich/raw/Vim/preview rendering & input | **Client** | Milkdown (D3), CodeMirror 6 (D4), preview pipeline (D5). |
| Live two-mode bridge | **Client** | Keystroke-by-keystroke sync of two open lenses of one doc (D6; [`./05-lossless-bridge.md`](./05-lossless-bridge.md)). |
| Undo-tree construction & navigation | **Client** | The client builds and walks the DAG; nodes are emitted to Convex (D8; [`./07-undo-tree.md`](./07-undo-tree.md)). |
| Word count | **Client** | Always available, derived from the live model (D15). |
| Debounced persistence | **Client → Convex** | The client decides *when* to flush; Convex is the only write path. |
| Durable storage of the canonical string | **Convex** | `documents.markdown` (D1; [`./03-data-model.md`](./03-data-model.md)). |
| History storage (append-only DAG, tags) | **Convex** | `docNodes`, `versions` as separate rows (D8, D9; [`./03-data-model.md`](./03-data-model.md), [`./07-undo-tree.md`](./07-undo-tree.md)). |
| Cross-device sync & reactivity | **Convex** | Reactive queries hydrate idle devices (D10; [`./10-sync-persistence.md`](./10-sync-persistence.md)). |
| Conflict policy | **Convex (policy) / Client (apply)** | Debounced **last-write-wins snapshot**; DAG nodes union-merge with no conflict (D8, D10). |
| Auth / identity scoping | **Convex + Better Auth** | Single user; every row scoped to one `userId` (D12). |
| Workspace persistence | **Convex** | `workspaces` row: pane tree, open docs, per-pane view state ([`./03-data-model.md`](./03-data-model.md), `09`). |

The performance contract behind this split: **typing never waits on the network** (Product principle 4). All input lands in the local model synchronously; the network is touched only by debounced, off-hot-path mutations. Convex's role is durability and resume, not live editing.

---

## 5. Data flow for a single edit

A single keystroke flows as follows. Steps in `[brackets]` are conditional. This is the canonical edit path for D6/D10/D11.

```
 (1) keystroke in the active lens (rich / raw / vim)
        │
        ▼
 (2) LOCAL canonical model updates synchronously
        rich  → mutate MDAST                (Milkdown, D3)
        raw   → mutate Markdown string      (CodeMirror, D4)  ──┐ unified pipeline keeps
        vim   → mutate Markdown string      (CM6 + vim, D4)   ──┘ MDAST ⇄ string consistent
        │
        ▼
 (3) [if a sibling pane shows the SAME document in another live lens (D6)]
        bridge propagates the change over the MDAST bus to that pane,
        origin-guarded + throttled + cursor-preserving        → (./05-lossless-bridge.md)
        │
        ▼
 (4) word count + undo-node candidate recomputed locally (D15, D8)
        │
        ▼   (debounced — NOT every keystroke; off the hot path; D11)
 (5) debounced Convex mutation fires:
        • write canonical string  → documents.markdown (+ title, wordCount, updatedAt)
        • append an immutable node → docNodes (delta patch vs parent; periodic snapshot)
        • advance documents.currentNodeId to the new node      → (./07-undo-tree.md)
        │
        ▼
 (6) Convex reactive query recomputes; OTHER IDLE devices showing this
        document re-hydrate to the new canonical string         → (./10-sync-persistence.md)
        (the active editing client does NOT re-hydrate from this — it already owns the truth)
```

The asymmetry in step (6) is the whole point of **D11**: the device doing the typing already holds the authoritative live model, so it must not be clobbered by the round-trip of its own write coming back as a query result. Only *idle* devices (or a freshly opened pane) consume the reactive update. The exact debounce window, the stale-version guard, and the offline buffering behavior are specified in [`./10-sync-persistence.md`](./10-sync-persistence.md); the node-append and DAG-merge semantics are in [`./07-undo-tree.md`](./07-undo-tree.md); the cross-pane propagation in step (3) is specified in [`./05-lossless-bridge.md`](./05-lossless-bridge.md).

---

## 6. In-memory model lifecycle

> **Rule:** there is exactly **one canonical model per open document per client**. Every pane showing that document — in any lens, including two *live* lenses at once — shares that **one** model instance.

This one-model-per-open-document rule is precisely what makes **same-document-two-live-modes** (D6) possible and coherent. If two panes of the same document each held their own model, you would be back in the rejected peer-format design (§1.1) and would have to reconcile them on every keystroke. Because they share one model, "syncing the two panes" is not a sync between two documents at all — it is two projections reading and writing the one model, mediated by the bridge ([`./05-lossless-bridge.md`](./05-lossless-bridge.md)).

### 6.1 Identity, sharing, and counting

| Question | Answer |
|----------|--------|
| How many canonical models exist? | One per **distinct open `documentId`** on this client. |
| Two panes, same document, rich + raw? | **Share the one model** (this enables D6). |
| Two panes, *different* documents? | **Two separate models**, fully independent. |
| Same document open on two devices? | **Two models** (one per client) reconciled only through Convex (D10), not in shared memory. |

### 6.2 Creation

A canonical model is created (parse the persisted `documents.markdown` into an MDAST and instantiate the lens editors that bind to it) when:

- A document is **opened into a pane** and no model for that `documentId` currently exists on the client, or
- The workspace is **restored on load** (§7; `09`) and brings previously-open documents back — one model per restored open document.

### 6.3 Destruction

A canonical model is destroyed (its editor instances torn down and the in-memory tree released) when:

- The **last pane** referencing that `documentId` is closed (closing one of several panes on the same document does **not** destroy the model — the others still share it), or
- The document is removed from the workspace's `openDocumentIds`.

Before destruction, the standard guarantee holds: a final debounced flush is forced so no pending edits are lost (§8). Reference-count the model by the number of panes bound to it; tear down at zero.

---

## 7. Proposed module / package layout

A single Next.js (App Router) application (D14), TypeScript strict, ESM, bun. The layout below groups code by the architectural roles defined above. This is the *proposed* structure; the data-model details it imports are canon in [`./03-data-model.md`](./03-data-model.md), and the sibling areas it references are canon in their own files.

```
recto/
├─ app/                      # Next.js App Router routes (mostly client components)
│  ├─ (auth)/                # Better Auth screens (D12)
│  ├─ layout.tsx             # dark-only shell (D13); design tokens applied here
│  └─ (studio)/              # the writing studio route(s): panes, workspace
│
├─ convex/                   # THE server. Schema + functions = only write path.
│  ├─ schema.ts              # documents · docNodes · versions · workspaces (D10; ./03)
│  ├─ documents.ts           # queries/mutations for the canonical string (D1)
│  ├─ docNodes.ts            # append-only DAG nodes; union-merge (D8; ./07)
│  ├─ versions.ts            # tagged versions; additive restore (D9; ./08)
│  ├─ workspaces.ts          # workspace persistence; resume (./09)
│  └─ auth.ts                # Better Auth integration (D12)
│
├─ lib/
│  ├─ markdown/              # the unified pipeline — the ONLY MDAST⇄string crossing
│  │                         #   unified, remark-parse, remark-stringify, remark-gfm,
│  │                         #   remark-frontmatter; remark-rehype + rehype-sanitize (D5; ./06)
│  ├─ editor/                # lens wrappers
│  │  ├─ milkdown/           #   rich lens — model IS the MDAST (D3)
│  │  └─ codemirror/         #   raw + vim lenses — edit the string (D4, @replit/codemirror-vim)
│  ├─ bridge/                # live two-mode sync over the MDAST bus (D6; ./05)
│  ├─ history/               # undo-tree DAG: build/walk/group/diff-encode (D8; ./07)
│  ├─ sync/                  # debounced persistence hooks; hydrate-on-open/idle (D10/D11; ./10)
│  └─ workspace/             # pane tree, open docs, per-pane view state (./09)
│
├─ components/               # UI: panes, split layout (react-resizable-panels),
│  │                         #   command palette (cmdk), word count, mode indicator,
│  │                         #   undo-tree visualizer, version history
│  └─ ...
│
└─ design/                   # design tokens: OKLCH dark palette, typography scale,
                             #   motion; Tailwind v4 + shadcn primitives (D13; ./12)
```

Boundaries to respect, derived directly from the one rule and the client/server split:

- `lib/markdown` is the **sole** place MDAST ↔ Markdown-string crossing happens. Nothing else may parse or stringify Markdown — that is how the round-trip property stays enforceable in one place ([`./06-markdown-dialect.md`](./06-markdown-dialect.md)).
- `lib/editor/*` wrappers expose lenses as **projections**; they never hold a competing canonical format (§1, D2).
- `lib/bridge` is the only code that couples two live lenses; it uses the MDAST as the bus ([`./05-lossless-bridge.md`](./05-lossless-bridge.md)).
- `lib/sync` is the only client code that talks to Convex mutations for document content; `convex/` is the only server write path (D10, and Plan conventions).

---

## 8. State management

Three stores, with strict, non-overlapping responsibilities. The discipline here is the operational form of **D11** — *the editor is never a controlled component of a reactive query.*

| State | Where it lives | Rule |
|-------|----------------|------|
| Live editor instances + canonical model | **React `ref`s** (imperative handles) | Never React-controlled by a server query. The Milkdown/CodeMirror instances hold the live model; React renders the *container*, not the value (D11). |
| Workspace / pane / UI state | **Client store (e.g. Zustand)** | Pane tree, active pane, per-pane lens choice, transient UI (palette open, etc.). Persisted to Convex `workspaces` via `lib/sync` ([`./03-data-model.md`](./03-data-model.md), `09`). |
| All durable persistence | **Convex** | Document content, history DAG, versions, workspace snapshot. The source of truth at rest (D10). |

Why editors live in refs and not in React state: binding an editor's value to a `useQuery` result makes the editor a controlled component of the network. Every reactive update would re-set the editor value and **clobber the cursor and the live undo state** (Risk register, [`../plan/README.md`](../plan/README.md); Risk "Cursor clobbered by reactive sync"). So the editor owns its live state imperatively; `useQuery` is consulted only to **hydrate on open/idle**, never to drive keystroke-level rendering. The flow of reactive data is one-directional and gated: query → (open/idle only) → hydrate; it never becomes query → render → editor-value.

---

## 9. Error handling & recovery posture

The non-negotiable promise is **never lose a word** (Product principle 2; Plan Definition of Done item 3). The architecture backs it with layered safety, ordered from most-local to most-durable:

1. **Local-owns-live (first line).** Because the canonical model lives in memory and is authoritative (D11), input is never blocked or lost waiting on the network. A slow or failed mutation cannot cost the user a keystroke.
2. **Local draft buffer.** Pending, not-yet-flushed canonical content is retained locally (so an in-flight debounce window, a tab close, or a crash does not drop the most recent edits). On reload the local buffer is reconciled against the hydrated `documents.markdown`; the freshest content wins, and the version-history safety net (below) covers the rare conflict. Exact buffering/flush mechanics are specified in [`./10-sync-persistence.md`](./10-sync-persistence.md).
3. **Forced flush on teardown.** When a model is destroyed (§6.3) or the page is unloading, a final debounced mutation is forced before release.
4. **Append-only history as a backstop.** The `docNodes` DAG is append-only and immutable (D8); even if a `documents.markdown` snapshot is overwritten by a last-write-wins race, prior states remain reachable through the undo tree and tagged versions (D8, D9; [`./07-undo-tree.md`](./07-undo-tree.md)). History is the durable undo-of-last-resort.
5. **Graceful offline.** With no network, editing continues entirely on the local model and draft buffer; mutations queue and flush on reconnect. Reactive hydration simply pauses. The offline contract — queueing, reconnect flush, and the stale-version guard for the "two devices within the debounce window" case — is specified in [`./10-sync-persistence.md`](./10-sync-persistence.md).

Recovery is therefore additive, matching D9's **additive restore** stance and Product principle 7 (*minimalism removes chrome, not safety nets*): we never destructively overwrite history to recover; we restore forward.

---

## 10. Why this architecture (lossless + snappy)

The design exists to satisfy two product principles that a naive multi-mode editor cannot satisfy together:

- **Lossless or it doesn't ship (principle 3).** Satisfied by §1: one canonical model, modes as projections, a single serialize/parse boundary in `lib/markdown`. There is no N×N conversion web to accumulate error — losslessness reduces to one testable property ([`./06-markdown-dialect.md`](./06-markdown-dialect.md)). Milkdown's MDAST-native model (§2.1) keeps even rich editing inside the canonical layer, so no lens is ever a competing format (D1–D5).
- **Snappy is a feature (principle 4).** Satisfied by §4–§5 and §8: the client owns the live model (D11); typing updates memory synchronously and never waits on Convex; persistence is debounced off the hot path (D10); mode switching is changing a projection, not running a transform, so it is instant.

And it does so without dropping safety nets (principle 7): persistence, branching undo, version history, and word count are all retained — minimalism here removes chrome, not the safety nets, exactly as the locked principles demand.

In one sentence: **one canonical remark MDAST, four projections of it, a single serialize/parse boundary, and a client that owns the live model while Convex owns durability — this is the smallest design under which "lossless" and "snappy" are both true at once.**

---

### Cross-references

- Live two-mode sync mechanics (MDAST bus, recreate-steps, cursor preservation): [`./05-lossless-bridge.md`](./05-lossless-bridge.md)
- Convex schema, indexes, validators, storage limits: [`./03-data-model.md`](./03-data-model.md)
- Debounce, hydrate-on-idle, concurrency, offline contract: [`./10-sync-persistence.md`](./10-sync-persistence.md)
- Branching undo DAG, node append, union-merge, current pointer: [`./07-undo-tree.md`](./07-undo-tree.md)
- Canonical decisions D1–D15 and the document map: [`./README.md`](./README.md)
