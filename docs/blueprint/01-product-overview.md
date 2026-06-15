# Recto — Product Overview

> **Scope of this file.** This is the product vision and the experience we are building: what Recto is, who it is for, how it feels to use, the concrete situations it is built for, what "good" means, and what we explicitly will not do in v1. It is the entry point to the blueprint and is written to stand on its own — every term it relies on is defined here, so you do not need to have read the other files to understand it. Where another file owns the full mechanics of something mentioned here, it is named by its exact filename. The canonical specification for *what* we are building is [`README.md`](./README.md) in this directory; the *how and in what order* lives in [`../plan/README.md`](../plan/README.md). If anything here ever appears to contradict [`README.md`](./README.md), **`README.md` wins** — reconcile and fix this file.

---

## 1. Vision

Recto is a **private, single-user, web-based writing studio** for newsletters and long-form articles. You open it and you are already writing — cursor blinking, last document and window layout restored exactly as you left them. Everything you type is continuously saved to the cloud, so you can sit down at a different computer and continue mid-sentence with the same documents, the same split layout, and the same edit history. The interface is dark-only, typography-first, and bespoke: the type *is* the UI, and the writing surface dominates a quiet, minimal chrome.

**The defining idea — one document, four lenses, lossless switching.** There is exactly **one piece of writing**, and you edit it through **four interchangeable lenses**:

1. **Rich text** — a WYSIWYG editor (Notion/Substack-like) with a slash command palette and contextual formatting.
2. **Raw Markdown** — a plain-text Markdown editor.
3. **Vim** — Vim keybindings (normal / insert / visual) layered on the Markdown editor.
4. **Preview** — a read-only rendered view of the Markdown.

Switching lenses is **instant and lossless**: the words, structure, and every supported construct survive every switch with no drift and no degradation. This is possible only because of one rule the whole product rests on — see §3.

---

## 2. Who it is for, and why it has accounts at all

### 2.1 The single writer (the owner)

Recto is for **one writer: the owner.** It is a personal tool, tuned for one person's drafting workflow. There is no notion of teammates, guests, readers, reviewers, or audiences inside the product.

| Trait | Recto's stance |
|-------|----------------|
| Users | Exactly one — the owner. |
| Collaboration | None. No real-time co-editing, presence, comments, or mentions. |
| Sharing | None. No share links, no public pages, no published surface. |
| Output | The writing leaves Recto only by **copy** or **export** (see §5e and [`11-clipboard-export.md`](./11-clipboard-export.md)). |
| Design target | Desktop, dark-only. |

Because there is only one writer, the product can make choices that a multi-tenant tool cannot: the entire window state is treated as a single restorable session, edit history is a personal artifact rather than a shared record, and there is no merge-conflict UX to design around for human collaborators.

### 2.2 Why authentication exists

Recto uses **Better Auth** for authentication (this is locked decision **D12**; Clerk is the documented fallback). It exists for **exactly one reason: to scope cloud state to one identity.** All persisted state — documents, edit history, tagged versions, and the saved window layout — is stored in Convex (locked decision **D10**) and keyed to the owner's user record so that "open it anywhere and resume" resolves to *your* data and nothing else.

Auth is **not** here for collaboration, permissions, roles, or visibility controls. There is no second user to authorize against and nothing to share. If multi-user features did not exist as a possibility, the auth layer would still be needed purely as the key under which the cloud state lives. That is its whole job.

---

## 3. The one rule everything rests on (so "lossless" is honest)

Before the walkthrough, one structural fact — because it is *why* the experience below is possible, and it is referenced throughout. The full mechanics live in [`02-architecture.md`](./02-architecture.md) and [`05-lossless-bridge.md`](./05-lossless-bridge.md); the data shapes live in [`03-data-model.md`](./03-data-model.md).

> **There is a single canonical document. Every mode (lens) is a *view* (projection) of it. Modes never convert between two competing formats.**

- The **canonical model** is a **Markdown abstract syntax tree (MDAST**, from the `remark`/`unified` ecosystem**)** held in memory while you edit, and **persisted to Convex as a Markdown string** (locked decision **D1**). The Markdown string is the source of truth at rest.
- **Rich text** uses **Milkdown** (locked decision **D3**), whose own document model *is* a remark MDAST — so rich editing is editing the canonical tree directly, not "convert to Markdown later."
- **Raw Markdown** and **Vim** use **CodeMirror 6** with `@replit/codemirror-vim` (locked decision **D4**), editing the serialized canonical Markdown string.
- **Preview** renders the MDAST to HTML via `remark-rehype` + `rehype-sanitize` (locked decision **D5**).

This is the only design under which switching lenses is genuinely lossless. The alternative — converting rich-text ↔ Markdown on every switch — causes progressive **round-trip** degradation, a documented, real failure mode that the project explicitly rejects (see [`14-tech-decisions.md`](./14-tech-decisions.md)). Everything in the experience below — instant switching, splitting one document into two live editable lenses, never losing a word — depends on this single rule holding.

---

## 4. The core experience — a narrative walkthrough

This is a concrete, step-by-step account of using Recto, in the order a session actually unfolds.

### 4.1 Open → the cursor is ready

You open Recto in a browser. There is no splash, no project picker, no "create your first document" wizard. The dark surface comes up and the cursor is already blinking in your text. You can type the first word of your session before you have consciously decided to start.

### 4.2 Last document and layout restored

What you see is precisely where you left off — restored from your **workspace**, the persisted record of your session. Concretely, on load Recto restores:

- the set of **open documents** (`workspaces.openDocumentIds`),
- the **pane tree** — your split layout (`workspaces.paneTree`),
- which **pane** was focused (`workspaces.activePaneId`), and
- each pane's **mode and cursor/scroll position** (`workspaces.perPaneViewState`).

If you last had a draft open in rich text on the left and a reference document open in preview on the right, that exact arrangement returns, scrolled to the same place, caret where you left it. Resume is true resume — you continue mid-sentence. (Full mechanics: [`09-documents-workspace-split.md`](./09-documents-workspace-split.md) and [`10-sync-persistence.md`](./10-sync-persistence.md).)

### 4.3 Write in rich text

You write in the **rich text** lens — the WYSIWYG surface. It behaves like a modern block editor: type Markdown shortcuts (`# ` for a heading, `- ` for a list, `> ` for a quote, `**bold**`, `` `code` ``) and they become formatted blocks as you type. Because Milkdown's document model *is* the canonical MDAST, every keystroke is an edit to the canonical document directly — nothing is being staged for a later conversion.

As you type, two things happen quietly in the background: the **word count** updates (always available — locked decision **D15**), and your text is **autosaved** to Convex on a debounce. The editor owns its live state and never waits on the network to accept a keystroke (locked decision **D11**); saving happens off the hot path. You never press save and you never see a save spinner stealing focus.

### 4.4 Slash command

You type `/` and a **slash command palette** opens inline at the cursor. From it you insert and transform structure without leaving the keyboard or reaching for a toolbar — headings, lists, task lists, tables, code blocks, dividers, footnotes, and so on. The palette only offers constructs that exist in the supported Markdown dialect (§7 and [`06-markdown-dialect.md`](./06-markdown-dialect.md)), because the rich editor may only produce things that have a faithful Markdown representation. That constraint is deliberate: it is what keeps lossless honest.

### 4.5 Switch to raw Markdown / Vim

You want to see the underlying Markdown, so you switch the pane's lens to **raw Markdown**. The switch is **instant and lossless** — same canonical document, now shown as editable plain-text Markdown in CodeMirror 6. Everything you wrote in rich text is there as exact Markdown source; nothing was reflowed, re-escaped, or lost. You make a few precise text edits.

Then you turn on **Vim**, which layers Vim keybindings (normal / insert / visual modes) onto that same Markdown editor. You navigate with `h j k l`, change a word with `cw`, delete a line with `dd`, and visually select a block — full modal editing over the same canonical document. The current lens is always shown by a mode indicator so you are never guessing which lens (or which Vim sub-mode) you are in. (Lens details and switching: [`04-editor-modes.md`](./04-editor-modes.md); keymap and Vim interplay: [`13-keyboard-commands.md`](./13-keyboard-commands.md).)

### 4.6 Split the surface to reference while writing

You need to keep an outline visible while you draft the body. You **split the writing surface**. Splits are vertical and/or horizontal and nest arbitrarily, forming a **pane tree** where each leaf — a **pane** — binds one document to one lens. You put your draft in rich text on the left and your outline in preview on the right, and you keep writing with both visible.

Recto supports something stronger than a static side-by-side: the **same document may be open in two live, editable lenses at once** — for example rich text and raw Markdown — kept in sync **keystroke by keystroke** (locked decision **D6**). Type a sentence in the rich pane and watch the Markdown appear in the raw pane in real time, and vice versa, with the cursor preserved in each. This is the **bridge** — the live two-way sync between rich and raw over the canonical MDAST — and it is the hardest single mechanism in the product (full mechanics: [`05-lossless-bridge.md`](./05-lossless-bridge.md)). Resizing and re-splitting is direct, and the layout is part of the workspace, so it is restored on your next open and on every device.

### 4.7 Tag a version

You reach a draft you are happy with and want a durable, named point to come back to. You **tag a version** — give the current state a label (e.g. "first full draft"). A **version / tag** is a named, durable reference to a specific point in the document's history. Recto also creates **auto** versions on its own at sensible moments; manual ones are the ones you name. Versions live in the `versions` table as references into the history store, with `kind: "auto" | "manual"`. Restoring a version is **additive** — it brings the old state back as a new forward point rather than destroying anything that came after, so tagging and restoring can never cost you work. (Full mechanics: [`08-version-control.md`](./08-version-control.md).)

### 4.8 Branch the undo tree

You then try a bold rewrite of a section — and decide you preferred the original. Undo here is **not a single linear chain**. Recto keeps a **branching undo tree** (locked decision **D8**): when you undo and then type something new, you do not erase the path you backed out of — you create a **branch**, and the path you abandoned is still there to return to. The history is an append-only DAG of immutable **nodes** (the `docNodes` table), so navigating it is undo/redo *across branches*: you can walk back to before the rewrite, down a different branch to the version you tried, and back again. Both the tree and your tagged versions are synced across devices. (Full mechanics: [`07-undo-tree.md`](./07-undo-tree.md).)

### 4.9 Copy / export

The piece is done in Recto; now it needs to live somewhere else — an email, a CMS, a `.md` file. You **copy** it (Recto puts both rich HTML and plain text on the clipboard, plus a copy-as-Markdown option) or **export** it as a `.md` or `.html` file. That is the only way writing leaves Recto — there is no publishing or sending inside the product. (Full mechanics: [`11-clipboard-export.md`](./11-clipboard-export.md).)

---

## 5. Detailed use cases

Each is a short, concrete scenario the product must serve well.

### (a) Drafting a newsletter from scratch

You sit down to write this week's newsletter. Recto opens to a ready cursor. You start in **rich text**, typing the opening line immediately. You use Markdown shortcuts for a heading and a bulleted list, hit `/` to drop in a divider and a code block for a snippet, and keep writing. The **word count** sits visible the whole time so you can hit your length target. Everything autosaves silently to the cloud as you go. When the draft holds together, you **tag a version** called "draft 1." Nothing about this flow required setup, configuration, or pressing save.

### (b) Long-form article edited against a reference pane

You are writing a 2,500-word article and want your research notes beside the draft. You **split** the surface vertically: the article in **rich text** on the left, your notes document in **preview** (read-only rendered Markdown) on the right. You write the body while glancing at the reference, scrolling the right pane independently. Mid-session you realize you want to edit the notes too, so you flip the right pane's lens to **raw Markdown** and amend them. Both documents and the split layout are part of your **workspace**, so when you reopen Recto tomorrow on a different machine, the same two-pane arrangement returns, scrolled and positioned as you left it.

### (c) Heavy Vim-driven revision

You have a finished first draft that needs a hard editing pass. You switch the pane to **raw Markdown** and turn on **Vim**. Now you revise modally over the same canonical document: jump between paragraphs, `dd` lines you are cutting, `cw` to swap words, visual-select and reflow a block, use search to hop to a phrase. The mode indicator shows you are in Vim and which sub-mode (normal / insert / visual) you are in. None of this is a separate "Vim document" — it is the same single canonical document the rich editor was showing, so when you flip back to **rich text** the result is exactly your revisions, losslessly. (Keymap and Vim details: [`13-keyboard-commands.md`](./13-keyboard-commands.md).)

### (d) Recovering an earlier idea via the undo tree / a tagged version

Two days ago you wrote a punchy intro, then rewrote it three times and drifted away from it. You want the original back. Two complementary paths:

- **Undo tree** — you open the branching history and walk back to before the rewrites. Because undo is a tree, not a line, the abandoned intro is still a node on a branch you can navigate to directly — even though you typed plenty since. You can move to it and branch forward from there. (Full mechanics: [`07-undo-tree.md`](./07-undo-tree.md).)
- **Tagged version** — or, if you had **tagged a version** at that moment, you restore that tag. Restore is **additive**: the old intro returns as a new forward state, and everything you wrote in the meantime is still intact on its own branch. Either way, the earlier idea is recoverable and nothing is destroyed to get it. (Full mechanics: [`08-version-control.md`](./08-version-control.md).)

### (e) Exporting / copying to paste into an email or CMS

The article is final. To paste it into an email client with formatting preserved, you **copy** — Recto puts both rich **HTML** and **plain text** on the clipboard, so the destination takes whichever it supports. To paste into a Markdown-aware CMS, you use **copy-as-Markdown**. To keep a file, you **export** the document as `.md` or `.html`. This is the boundary of the product: writing leaves Recto by copy or export only; Recto does not send or publish. (Full mechanics: [`11-clipboard-export.md`](./11-clipboard-export.md).)

---

## 6. Quality bar / success criteria

"Good" in Recto means it feels **instant, lossless, never-lose-work, and premium.** Concretely:

| Dimension | What "good" feels like |
|-----------|------------------------|
| **Open and write** | The cursor is ready on load; last document and layout are restored. Zero setup friction — no wizard, no picker, no save button. |
| **Never lose a word** | Autosave is silent and continuous. A refresh, a crash, or switching machines never costs text. Persistence, undo, word count, and standard editing are non-negotiable safety nets. |
| **Lossless** | A document that round-trips rich → raw → rich comes back byte-stable within the supported dialect (§7). If a construct cannot round-trip, the dialect is narrowed and documented — it is **never** silently dropped. |
| **Snappy** | Typing never waits on the network. Mode (lens) switches are instant. Sync is debounced off the hot path. |
| **Premium and bespoke** | Considered typography, a restrained dark OKLCH palette, deliberate motion. The tool disappears: minimal chrome, the writing surface dominates. Not a templated default. (Full system: [`12-design-system.md`](./12-design-system.md).) |
| **Resume anywhere** | Sit down at any computer and pick up mid-sentence — same documents, same split layout, same history. |

The product principles behind this bar, restated for self-containment:

1. **Open and write.** Zero setup friction; cursor ready; last document and layout restored.
2. **Never lose a word.** Autosave silent and continuous; no switch, refresh, crash, or device change costs text.
3. **Lossless or it doesn't ship.** Rich → raw → rich must round-trip byte-stable within the supported dialect.
4. **Snappy is a feature.** Typing never blocks on the network; mode switches are instant.
5. **The tool disappears.** Minimal chrome; the writing surface dominates; formatting via Markdown shortcuts, slash commands, and contextual UI — not persistent toolbars.
6. **Premium and bespoke.** Considered typography, restrained dark palette, deliberate motion.
7. **Minimalism removes chrome, not safety nets.** Menus may be hidden; persistence, undo, word count, and standard editing may not be dropped.

---

## 7. The Markdown dialect (the losslessness contract, in brief)

Losslessness is only meaningful against a defined set of constructs. Recto's dialect is **CommonMark + GFM + footnotes + YAML frontmatter** (locked decision **D7**), and every construct in it is guaranteed to **round-trip** — meaning `serialize(parse(markdown))` equals `normalize(markdown)` for that construct. Summary of what is supported and guaranteed:

- **CommonMark:** headings H1–H6, paragraphs, bold/italic, inline code, links, images, blockquotes, ordered/unordered (nested) lists, fenced code blocks, thematic breaks (dividers), hard/soft breaks.
- **GFM:** tables, task lists, strikethrough, autolinks.
- **Footnotes** (GFM-style references + definitions).
- **YAML frontmatter** (document metadata block).

The rich editor may **only** produce constructs expressible in this dialect — there are no rich-only features without a Markdown representation. Footnotes and tables are the classic lossy spots; remark handles them in the AST and they are guarded by a round-trip property-test corpus. Full spec and serialization rules: [`06-markdown-dialect.md`](./06-markdown-dialect.md).

---

## 8. Non-goals (v1)

These mirror the blueprint [`README.md`](./README.md) and are restated and briefly expanded here. Each is a deliberate scope boundary, not an omission to be fixed later in v1.

- **Multi-user / real-time collaboration, presence, comments, sharing.** Recto is single-user by design (§2). There is no co-editing, no presence indicators, no comment threads, no mentions, and no share links or public pages. The only data-scoping identity exists so cloud state resolves to the one owner (§2.2).
- **A light theme.** The product is **dark only** (locked decision **D13**). The dark OKLCH palette and typography are the design, not a default that a light mode would mirror.
- **Mobile-native apps.** The design target is **desktop**; responsive web is acceptable, but there is no iOS/Android native app and no mobile-first layout work in v1.
- **Publishing / sending newsletters.** Recto does not send email or publish to any platform. Writing leaves the product by **export + copy only** (§5e, [`11-clipboard-export.md`](./11-clipboard-export.md)).
- **Plugins / extensibility API.** There is no public plugin system or third-party extension surface in v1. The feature set is fixed and curated.
- **Book-length manuscripts.** Documents that exceed Convex's **~1 MiB per-document ceiling** are out of scope; long-but-reasonable articles are in scope. (Storage strategy and limits: [`03-data-model.md`](./03-data-model.md).)

---

## 9. Expanded glossary

Builds on the canonical glossary in [`README.md`](./README.md). These are the load-bearing terms used across the blueprint; use these exact names everywhere.

- **Canonical model** — the in-memory **remark MDAST** (Markdown abstract syntax tree from the `remark`/`unified` ecosystem) that is the single source of truth *while editing*. At rest, it is persisted to Convex as a **Markdown string** (the source of truth at rest). Every lens is a view of this one model; there is never a second competing document.
- **Mode / lens** — one of the four interchangeable views of the canonical model: **rich text**, **raw Markdown**, **Vim**, **preview**. "Mode" and "lens" are used interchangeably. A mode is a *projection* of the canonical model, never a separate format that gets converted to and from.
- **Pane** — a leaf in the split layout. A pane binds **one document to one mode (lens)**. It is the smallest unit of "a document being shown in a particular way."
- **Pane tree** — the recursive **vertical/horizontal split layout** of panes. Splits nest arbitrarily; the leaves are panes. The structure is serialized into `workspaces.paneTree` and restored on load.
- **Workspace** — the persisted set of **open documents + pane tree + per-pane state**, restored on load to give "resume where I left off." Backed by the `workspaces` table: `openDocumentIds`, `paneTree`, `activePaneId`, and `perPaneViewState` (each pane's mode + cursor/scroll). One workspace per user.
- **Node** — an immutable entry in a document's undo-tree DAG, stored as a row in the `docNodes` table. Nodes are append-only and never mutated; each carries a delta (`patch`) of the canonical Markdown versus its parent, an occasional full `snapshot` for fast materialization, an optional `selection`, and the `origin` (device/client) that created it.
- **Undo tree** — the **branching** DAG of edit states for a document (the collection of `docNodes`). Because it branches, undoing and then typing creates a new branch rather than erasing the path you backed out of; navigating the tree is undo/redo *across branches*. The document's `currentNodeId` points at the node you are currently on.
- **Version / tag** — a **named, durable reference to a node** (a row in the `versions` table, with `label` and `kind: "auto" | "manual"`). Recto creates **auto** versions; you create **manual** ones. **Restoring a version is additive** — the old state returns as a new forward point and nothing after it is destroyed.
- **Bridge** — the **live two-way sync between the rich and raw editors over the canonical MDAST.** It is what makes the same document editable in two live lenses at once (locked decision **D6**), kept in sync keystroke-by-keystroke with the cursor preserved in each pane. The MDAST is the bus; updates are origin-guarded, throttled, and cursor-preserving. (Full mechanics: [`05-lossless-bridge.md`](./05-lossless-bridge.md).)
- **Round-trip** — the losslessness contract: `serialize(parse(markdown))` must equal `normalize(markdown)` for every supported construct. A document that round-trips rich → raw → rich must come back byte-stable within the supported dialect (§7). Guarded by a property-test corpus.

---

## 10. How this relates to the build plan

This file (and the rest of `blueprint/`) defines **what** Recto is. The companion directory [`../plan/`](../plan/README.md) defines **how and in what order** it gets built. Read [`../plan/README.md`](../plan/README.md) for the full execution context; each phase file there is self-contained and can be handed to an implementer.

The two genuinely novel, unproven mechanisms — **live two-mode editing of one document** (the **bridge**, §4.6) and the **cloud-persisted branching undo tree** (§4.8) — are front-loaded as throwaway spikes so that no product UI is built on an unproven foundation. The phase order then follows dependency:

| Phase | Title | What it delivers (relative to this overview) |
|-------|-------|----------------------------------------------|
| [0](../plan/phase-0-spikes.md) | **Spikes** | Prove (or pick fallbacks for) the live two-mode **bridge** (§4.6) and the cloud **undo tree** DAG (§4.8) before any product UI. |
| [1](../plan/phase-1-foundation.md) | **Foundation** | Next.js + Convex + Better Auth + the dark shell; document CRUD; one rich-text surface that syncs and never loses words; live **word count** (§4.1–4.3). |
| [2](../plan/phase-2-modes-and-losslessness.md) | **Modes & losslessness** | Add raw Markdown, Vim, and preview; lossless mode switching; the slash palette; full GFM + footnotes + frontmatter with round-trip tests (§4.4–4.5, §7). |
| [3](../plan/phase-3-multi-doc-split-workspace.md) | **Multi-doc, split & workspace** | Document switcher; nested split panes; same-doc-two-live-modes; workspace persistence and cross-device resume (§4.2, §4.6). |
| [4](../plan/phase-4-history.md) | **History** | The undo-tree visualizer wired to the persisted DAG; version history with auto + manual tags; additive restore (§4.7–4.8, §5d). |
| [5](../plan/phase-5-polish-and-export.md) | **Polish & export** | Command palette; clipboard (html+plain) and copy-as-Markdown; export `.md` / `.html`; the bespoke design pass (§4.9, §5e). |

Phases are sequential — do not start phase *N+1* until phase *N* is done — except the Phase 0 spikes, which are throwaway and *inform* (not block) the design of Phase 1 onward. Every phase must also meet the global Definition of Done in [`../plan/README.md`](../plan/README.md): exit criteria pass, types and lint are clean, there are no data-loss regressions, typing stays snappy, and the blueprint is updated if the implementation deviated (the blueprint is the source of truth).
