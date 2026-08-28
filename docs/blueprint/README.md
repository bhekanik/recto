# Recto — Blueprint

> **This is the canonical specification for Recto.** It is the single source of truth for *what we are building*. The `../plan/` directory describes *how and in what order we build it*. Every other file in this `blueprint/` directory expands one area of this document in full, self-contained detail.

If anything in a detailed blueprint file contradicts this README, **this README wins** — open an issue and reconcile.

---

## 1. What Recto is

Recto is a **private, single-user, web-based writing studio** for newsletters and long-form articles. You open it and start writing immediately. Your work is always saved to the cloud, so you can sit down at any computer and pick up mid-sentence, with the same documents, the same window layout, and the same edit history.

The defining idea: **one piece of writing, edited through four interchangeable lenses** —

1. **Rich text** — a WYSIWYG editor (Notion/Substack-like) with a slash command palette and formatting toolbar.
2. **Raw Markdown** — a plain-text Markdown editor.
3. **Vim** — Vim keybindings layered on the Markdown editor (normal / insert / visual).
4. **Preview** — a read-only rendered view of the Markdown.

Switching between lenses is **instant and lossless**. You can **split the writing surface** vertically and/or horizontally to write against a reference. Every document has a **branching undo tree** (not linear undo) and a **tagged version history**, both synced across devices. The interface is **typography-first and bespoke** — the type *is* the UI — in a paired **Twilight** (dark) and **Paper** (light) palette that follows the system appearance.

It is a personal tool. There is no multi-user collaboration, no sharing, no public surface. The only reason it has authentication at all is that cloud state must be scoped to one identity (you).

---

## 2. The one architectural rule everything depends on

> **There is a single canonical document. Every mode is a *view* (projection) of it. Modes never convert between two competing formats.**

The canonical form is a **Markdown abstract syntax tree (MDAST, from the `remark`/`unified` ecosystem)**, held in memory while editing and **persisted to Convex as a Markdown string**.

- The **rich text** editor is [Milkdown](https://milkdown.dev/), whose own document model *is* a remark MDAST — so rich editing is not "convert to Markdown later," it is editing the canonical tree directly.
- The **raw Markdown** and **Vim** editors are [CodeMirror 6](https://codemirror.net/), editing the serialized canonical Markdown string.
- The **preview** renders the MDAST to HTML via `remark-rehype` + `rehype-sanitize`.

This is the **only** design that makes "lossless" true. Converting rich-text ↔ Markdown on every mode switch causes progressive round-trip degradation — this is a documented, real failure mode (see [`14-tech-decisions.md`](./14-tech-decisions.md)), and we explicitly reject it.

See [`02-architecture.md`](./02-architecture.md) and [`05-lossless-bridge.md`](./05-lossless-bridge.md) for the full mechanics.

---

## 3. Locked decisions

These are settled. Changing one is a significant scope change, not a tweak.

| # | Decision | Choice |
|---|----------|--------|
| D1 | Canonical document model | **remark MDAST** in memory; persisted as a **Markdown string** in Convex |
| D2 | Modes are | **views of the canonical model**, never format-to-format conversions |
| D3 | Rich text engine | **Milkdown** (remark-backed ProseMirror) |
| D4 | Raw + Vim engine | **CodeMirror 6** + `@replit/codemirror-vim` |
| D5 | Preview | `remark-rehype` + `rehype-sanitize` → HTML |
| D6 | Split panes | **Same document may be open in two live, editable modes at once** (rich + raw), kept in sync keystroke-by-keystroke |
| D7 | Markdown dialect | **CommonMark + GFM** (tables, task lists, strikethrough, autolinks) **+ footnotes + YAML frontmatter** |
| D8 | Undo | **Branching undo tree** (not linear), **cloud-persisted** as an append-only DAG |
| D9 | Version control | **Tagged versions** (auto + manual), **additive restore**, sharing the append-only store with undo but with distinct semantics |
| D10 | Backend / sync | **Convex**, debounced **last-write-wins snapshot** sync; **no** `prosemirror-sync` / Yjs / CRDT |
| D11 | Editing performance model | **Local editor owns live state**; debounced persistence; hydrate-on-open/idle; the editor is never a controlled component of a reactive query |
| D12 | Auth | **Better Auth** (default), single user, private |
| D13 | Theme | ~~**Dark only.** No light theme~~ — **reversed by [ADR-20](./14-tech-decisions.md#adr-20--light-theme-paper-palette--appearance-setting-reverses-d13)** (2026-08-28): Twilight (dark) + Paper (light), appearance follows the system with an override. Aurora/Dawn/Moonlit stay dark-only |
| D14 | App framework | **Next.js (App Router)**, TypeScript strict, **bun**, ESM |
| D15 | Word count | Always available |

---

## 4. Product principles

1. **Open and write.** Zero setup friction. The cursor is ready on load; the last document and layout are restored.
2. **Never lose a word.** Autosave is silent and continuous. A refresh, a crash, or switching machines never costs text.
3. **Lossless or it doesn't ship.** A document that round-trips rich → raw → rich must come back byte-stable within the supported dialect.
4. **Snappy is a feature.** Typing never waits on the network. Mode switches are instant.
5. **The tool disappears.** Minimal chrome; the writing surface dominates. Formatting via Markdown shortcuts, slash commands, and contextual UI — not persistent toolbars competing for space.
6. **Premium and bespoke.** Considered typography, restrained dark palette, deliberate motion. Not a templated shadcn default.
7. **Minimalism removes chrome, not safety nets.** We can hide menus; we cannot drop persistence, undo, word count, or standard editing.

---

## 5. Non-goals (v1)

- Multi-user / real-time collaboration, presence, comments, sharing.
- Mobile-native apps (responsive web is fine; the design target is desktop).
- Publishing / sending newsletters (export + copy only).
- Plugins / extensibility API.
- Book-length manuscripts that exceed Convex's ~1 MiB per-document ceiling (see `03-data-model.md`); long-but-reasonable articles are in scope.

---

## 6. Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| App framework | Next.js (App Router), mostly client components | Matches the user's `planetaryescape` Convex + Next pattern source; SPA feel |
| Package manager / runtime | **bun** | Project default for new scaffolds |
| Language | TypeScript, strict, ESM | Project default |
| Backend / sync | **Convex** | Reactive queries; "always saved, resume anywhere" |
| Auth | **Better Auth** (Clerk is the fallback) | Single-user identity to scope cloud state |
| Rich text | **Milkdown** + `@milkdown/preset-commonmark`, `@milkdown/preset-gfm`, remark plugins | Document model *is* remark MDAST → least-lossy |
| Raw + Vim | **CodeMirror 6**, `@codemirror/lang-markdown`, `@replit/codemirror-vim` | Lightest real Vim (normal/insert/visual); Obsidian-grade |
| Markdown core | `unified`, `remark-parse`, `remark-stringify`, `remark-gfm`, `remark-frontmatter` | Canonical AST + serialization |
| Preview | `remark-rehype`, `rehype-sanitize`, `rehype-stringify` | Same AST → HTML; no second parser to drift |
| Rich↔raw diffing | `prosemirror-recreate-steps` (or equivalent doc-diff → steps) | Apply external Markdown edits into the live rich doc without nuking the cursor |
| Split layout | `react-resizable-panels` | Nested vertical/horizontal pane tree |
| Command palette | `cmdk` | Keyboard-first actions, mode/doc switching |
| Styling | Tailwind v4, shadcn primitives, **OKLCH** dark palette | User conventions |
| Lint / format | **Biome** | User convention |
| IDs | `crypto.randomUUID()` / ULID for node ids | Built-in; no uuid dep |

---

## 7. Convex data model (canonical names — use these exact names everywhere)

Full detail and validators in [`03-data-model.md`](./03-data-model.md). Summary contract:

```ts
// users — provided/managed by Better Auth.

documents: {
  userId: Id<"users">,
  title: string,
  markdown: string,         // canonical serialized Markdown (the source of truth at rest)
  wordCount: number,
  currentNodeId: string,    // pointer into the undo-tree DAG (docNodes.nodeId)
  createdAt: number,
  updatedAt: number,
}                            // index: by_user (userId), by_user_updated (userId, updatedAt)

docNodes: {                 // append-only branching undo-tree DAG; nodes are immutable
  documentId: Id<"documents">,
  nodeId: string,           // client-generated ULID; globally unique
  parentNodeId: string | null,
  patch: string,            // compact delta of canonical Markdown vs parent
  snapshot?: string,        // occasional full Markdown snapshot for fast materialization
  selection: { anchor: number, head: number } | null,
  origin: string,           // device/client id that created the node
  createdAt: number,
}                            // index: by_document (documentId), by_document_node (documentId, nodeId)

versions: {                 // tagged snapshots — references into docNodes
  documentId: Id<"documents">,
  nodeId: string,           // the docNodes node this version points at
  label: string,
  kind: "auto" | "manual",
  createdAt: number,
}                            // index: by_document (documentId)

workspaces: {               // one per (user, device) since ADR-21; "resume where I left off"
  userId: Id<"users">,
  paneTree: string,         // JSON: recursive split layout (see 09)
  openDocumentIds: Id<"documents">[],
  activePaneId: string,
  perPaneViewState: string, // JSON: per-pane mode + cursor/scroll
  updatedAt: number,
}                            // index: by_user (userId)
```

**Hard constraints to respect (Convex):** max ~1 MiB per document/value; store history as **separate rows** (never an embedded array of versions); delta-encode `docNodes.patch` with periodic `snapshot`s.

---

## 8. Markdown dialect (the losslessness contract)

Supported and guaranteed to round-trip (full spec + serialization rules in [`06-markdown-dialect.md`](./06-markdown-dialect.md)):

- **CommonMark**: headings H1–H6, paragraphs, bold/italic, inline code, links, images, blockquotes, ordered/unordered lists (nested), fenced code blocks, thematic breaks (dividers), hard/soft breaks.
- **GFM**: tables, task lists, strikethrough, autolinks.
- **Footnotes** (GFM-style references + definitions).
- **YAML frontmatter** (document metadata block).

The rich editor may **only** produce constructs expressible in this dialect — there are no rich-only features that have no Markdown representation. This is what keeps "lossless" honest. Every supported construct has explicit parse + serialize rules and is covered by the round-trip property-test corpus.

---

## 9. The three hard parts (where risk concentrates)

1. **Live two-mode sync** ([`05-lossless-bridge.md`](./05-lossless-bridge.md)) — two editor engines editing one document in real time. MDAST is the bus; origin-guarded, throttled, cursor-preserving diffs in both directions. *Spiked first in Phase 0.*
2. **Cloud-persisted undo tree** ([`07-undo-tree.md`](./07-undo-tree.md)) — append-only immutable nodes union-merge across devices with no conflict; the current pointer is last-write-wins. *Spiked first in Phase 0.*
3. **Footnotes & tables round-trip** ([`06-markdown-dialect.md`](./06-markdown-dialect.md)) — the classic lossy spots; remark handles them in the AST, guarded by the round-trip corpus.

---

## 10. Blueprint document map

Read these in order for a full understanding; each is self-contained.

| File | Covers |
|------|--------|
| [`01-product-overview.md`](./01-product-overview.md) | Vision, the user, core experience, use cases, glossary, non-goals |
| [`02-architecture.md`](./02-architecture.md) | Canonical-model spine, components, data flow, client/server split |
| [`03-data-model.md`](./03-data-model.md) | Convex schema, indexes, validators, limits, storage strategy |
| [`04-editor-modes.md`](./04-editor-modes.md) | The four modes in detail, mode switching, indicator, shortcuts |
| [`05-lossless-bridge.md`](./05-lossless-bridge.md) | Live two-mode sync, MDAST bus, recreate-steps, cursor preservation |
| [`06-markdown-dialect.md`](./06-markdown-dialect.md) | Supported features, serialization/normalization rules, round-trip corpus |
| [`07-undo-tree.md`](./07-undo-tree.md) | Branching undo model, grouping, navigation, persistence, visualizer |
| [`08-version-control.md`](./08-version-control.md) | Tagged versions, auto/manual snapshots, additive restore, diff/compare |
| [`09-documents-workspace-split.md`](./09-documents-workspace-split.md) | Multi-doc, split panes, pane tree, workspace persistence |
| [`10-sync-persistence.md`](./10-sync-persistence.md) | Convex sync, local-owns-live, debounce, concurrency, offline |
| [`11-clipboard-export.md`](./11-clipboard-export.md) | Copy (html+plain), copy-as-markdown, export .md / .html |
| [`12-design-system.md`](./12-design-system.md) | Dark OKLCH palette, typography, layout, motion, components, a11y |
| [`13-keyboard-commands.md`](./13-keyboard-commands.md) | Full keymap, mode shortcuts, command palette, Vim interplay |
| [`14-tech-decisions.md`](./14-tech-decisions.md) | ADR-style decisions + rejected alternatives + rationale + references |

---

## 11. Glossary

- **Canonical model** — the in-memory remark MDAST that is the truth while editing.
- **Mode / lens** — one of: rich text, raw Markdown, Vim, preview. A view of the canonical model.
- **Pane** — a leaf in the split layout; binds one document to one mode.
- **Pane tree** — the recursive vertical/horizontal split layout of panes.
- **Workspace** — the persisted set of open documents + pane tree + per-pane state, restored on load.
- **Node** — an immutable entry in a document's undo-tree DAG (`docNodes`).
- **Undo tree** — the branching DAG of edit states; navigating it is undo/redo across branches.
- **Version / tag** — a named, durable reference to a node (`versions`); restoring is additive.
- **Bridge** — the live two-way sync between the rich and raw editors over the canonical MDAST.
- **Round-trip** — serialize(parse(markdown)); must equal normalize(markdown) for supported constructs.
