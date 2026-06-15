# Recto — Editor Modes

> Part of the Recto blueprint. The canonical specification is [`./README.md`](./README.md); if anything here contradicts it, the README wins. This file is self-contained: it fully describes the four editing modes, how the user switches between them, and the per-pane mode indicator. The live two-way synchronization that makes switching lossless is mechanically specified in [`./05-lossless-bridge.md`](./05-lossless-bridge.md); the exact supported Markdown constructs are in [`./06-markdown-dialect.md`](./06-markdown-dialect.md); the complete keymap and slash list are in [`./13-keyboard-commands.md`](./13-keyboard-commands.md); the typography and visual tokens are in [`./12-design-system.md`](./12-design-system.md).

---

## 1. Modes overview

Recto edits **one piece of writing through four interchangeable lenses**. The defining product idea (README §1) is that these are not four documents, four formats, or four files — they are four **views (projections)** of a single canonical model.

> **The one rule that governs this entire file** (README §2, D1, D2): there is a single canonical document, held in memory while editing as a **remark MDAST** (the Markdown abstract syntax tree from the `unified`/`remark` ecosystem) and persisted to Convex as a **Markdown string**. Every mode is a *view* of that tree. Modes **never** convert between two competing formats. There is no "rich-text document" and a separate "Markdown document" that must be reconciled — there is the MDAST, and four ways to look at it and edit it.

The four modes (README §1, glossary):

| # | Mode (canon name) | Engine | Editable? | What it shows |
|---|-------------------|--------|-----------|---------------|
| 1 | **Rich text** | Milkdown (remark-backed ProseMirror) | Yes | WYSIWYG rendering of the MDAST (Notion/Substack-like), with a slash command palette and a contextual formatting toolbar |
| 2 | **Raw Markdown** | CodeMirror 6 | Yes | The serialized canonical Markdown string, with Markdown syntax highlighting |
| 3 | **Vim** | CodeMirror 6 + `@replit/codemirror-vim` | Yes | The same serialized Markdown string as raw, with Vim keybindings (normal / insert / visual) layered on |
| 4 | **Preview** | `remark-rehype` + `rehype-sanitize` + `rehype-stringify` | No (read-only) | The MDAST rendered to sanitized HTML, styled with the reading typography |

### 1.1 A pane binds one document to one mode

A **pane** is a leaf in the split layout; it **binds one document to one mode** (README glossary; split mechanics in [`./09-documents-workspace-split.md`](./09-documents-workspace-split.md)). At any instant a pane is showing exactly one of the four modes above for exactly one document. The mode is per-pane state, persisted in `workspaces.perPaneViewState` (README §7).

Two consequences follow, both load-bearing:

- **The same document can be open in two panes in two different modes at once** (D6). For example, rich text on the left, raw Markdown on the right, the *same* document, kept in sync keystroke-by-keystroke. That live cross-pane sync is the subject of [`./05-lossless-bridge.md`](./05-lossless-bridge.md).
- **Switching a pane's mode is instant and lossless** because it is just choosing a different projection of the canonical model the pane is already bound to — nothing is converted, copied, or reconciled at switch time (see §6).

### 1.2 Why this is the only design that is lossless

Rich text and Markdown are not two formats Recto translates between. Milkdown's own document model *is* a remark MDAST (D3), so rich editing edits the canonical tree directly. The raw and Vim editors edit the *serialized* form of that same tree. The preview renders that same tree. Because there is one model and four views, there is no round-trip degradation to accumulate — the documented failure mode of "convert rich ↔ Markdown on every switch" is structurally impossible here (README §2; rejected alternative recorded in [`./14-tech-decisions.md`](./14-tech-decisions.md)).

The rich editor may **only** produce constructs that exist in Recto's Markdown dialect (README §8; full list in [`./06-markdown-dialect.md`](./06-markdown-dialect.md)). There are deliberately no rich-only features that have no Markdown representation; that constraint is what keeps "lossless" honest.

---

## 2. Rich text (Milkdown)

### 2.1 Engine

The rich-text mode is **Milkdown** (D3, README §6), a headless editor framework built on ProseMirror whose **document model is a remark MDAST**. This is the single most important fact about this mode: when you bold a word, insert a table, or add a footnote in rich text, you are mutating the canonical tree directly. There is no "export to Markdown" step — serialization is just asking remark to stringify the tree that is already the truth.

Milkdown configuration (README §6):

| Concern | Plugin / package |
|---------|------------------|
| CommonMark constructs | `@milkdown/preset-commonmark` |
| GFM constructs (tables, task lists, strikethrough, autolinks) | `@milkdown/preset-gfm` |
| Footnotes, frontmatter, dialect parity | remark plugins matching the dialect (`remark-gfm`, `remark-frontmatter`, footnote support) so Milkdown's parser/serializer agrees byte-for-byte with the canonical `remark-parse` / `remark-stringify` pipeline |

The remark plugin set in Milkdown must match the canonical parse/serialize pipeline exactly (README §6, §8). If Milkdown could produce a construct that the canonical pipeline cannot serialize, or serialize one differently, losslessness would break at the seam. This parity is part of the dialect contract enforced by the round-trip corpus in [`./06-markdown-dialect.md`](./06-markdown-dialect.md).

### 2.2 Supported blocks and marks

Rich text supports **every construct in the dialect** (README §8) and nothing outside it. The full normative spec is [`./06-markdown-dialect.md`](./06-markdown-dialect.md); the rich-text capability surface is:

| Category | Constructs |
|----------|------------|
| Headings | H1, H2, H3, H4, H5, H6 |
| Inline marks | **bold**, *italic*, ~~strikethrough~~ (GFM), `inline code` |
| Inline nodes | link, image |
| Block quotes | blockquote (nestable) |
| Code | fenced code block (with language info string) |
| Separators | thematic break / divider (horizontal rule) |
| Lists | bullet (unordered) list, ordered list, **task list** (GFM), all with **nesting** |
| Tables | GFM tables (header row + alignment) |
| Footnotes | footnote reference + footnote definition |

There is intentionally no construct here that is not also expressible as Markdown in the dialect (README §8). Frontmatter (YAML metadata block, D7) is part of the canonical document but is document metadata rather than an in-flow rich-text block; its handling is specified in [`./06-markdown-dialect.md`](./06-markdown-dialect.md).

### 2.3 The slash command palette

Rich text exposes a **slash command palette** for inserting blocks, in the lineage of Notion-style insert menus (reference pattern: <https://tiptap.dev/docs/examples/experiments/slash-commands>). It embodies product principle 5 (README §4): formatting via slash commands and contextual UI, **not** persistent toolbars competing for space.

**Trigger and interaction model:**

| Action | Key | Behavior |
|--------|-----|----------|
| Open palette | type `/` | At the start of an empty block (or after whitespace), typing `/` opens the palette inline at the cursor |
| Filter | continue typing | Typed characters after `/` filter the command list live |
| Move selection down | `↓` | Moves the highlight down the filtered list |
| Move selection up | `↑` | Moves the highlight up the filtered list |
| Select / insert | `Enter` | Inserts the highlighted block, removing the `/` query text |
| Continue / accept-and-advance | `Tab` | Advances/continues selection within the palette |
| Close without inserting | `Esc` | Dismisses the palette, leaving the `/` text as literal characters |

The palette is **fully keyboard-navigable** — a writer never needs the mouse to insert any block. It is keyboard-first by design (consistent with `cmdk`-style command interaction, README §6, and the keyboard philosophy in [`./13-keyboard-commands.md`](./13-keyboard-commands.md)).

**Blocks the palette can insert** (drawn from the dialect): headings H1–H6, bullet list, ordered list, task list, blockquote, fenced code block, table, thematic break/divider, image, footnote. The slash palette inserts **blocks**; inline marks (bold, italic, strikethrough, inline code, link) are applied through the contextual toolbar (§2.4) or Markdown input shortcuts, not via slash.

> The **authoritative, exact slash command list** — every entry, its label, aliases, the block it inserts, and ordering — lives in [`./13-keyboard-commands.md`](./13-keyboard-commands.md). This file describes the palette's behavior and the *category* of blocks it inserts; that file is the source of truth for the literal list.

### 2.4 The contextual formatting toolbar

Rich text uses a **contextual / floating formatting toolbar**, **not a persistent chrome bar** (README §4 principle 5; §5 minimal-chrome principle 6). The toolbar:

- Appears **only when there is a non-empty selection**, floating near the selected text.
- Offers the inline marks that apply to a text selection: **bold**, *italic*, ~~strikethrough~~, `inline code`, and **link** (set/edit/remove).
- Dismisses when the selection collapses or the writer continues typing.

This keeps with the principle that **the tool disappears** (README §4): the writing surface dominates; formatting affordances surface contextually rather than occupying permanent screen real estate. Markdown input shortcuts (e.g. typing `**bold**`, `# `, `- `) remain available in rich text as a faster path for fluent writers; the toolbar is the discoverable fallback, not the primary chrome.

---

## 3. Raw Markdown (CodeMirror 6)

### 3.1 Engine

The raw Markdown mode is **CodeMirror 6** (CM6) (D4, README §6). CM6 is the modern, modular editor core that **Obsidian uses** — chosen for being a lightweight, battle-tested real text editor rather than a textarea or a re-implementation. Raw mode loads:

| Concern | Package |
|---------|---------|
| Markdown language support + syntax highlighting | `@codemirror/lang-markdown` |

### 3.2 What it edits

Raw Markdown edits the **serialized canonical Markdown string directly** — character for character, this is the same string that is persisted to Convex as `documents.markdown` (README §7) and the same string CodeMirror's Vim mode (§4) edits. The writer sees and manipulates the literal Markdown source: `# Heading`, `**bold**`, `| a | b |` table pipes, `[^1]` footnote references, the YAML frontmatter block, and so on.

Syntax highlighting (via `@codemirror/lang-markdown`) colors the Markdown tokens so structure is legible without rendering, but **nothing is hidden or transformed** — what you type is what is stored. There is no WYSIWYG layer in this mode; that is the point of having it.

Because raw mode edits the serialized string while the canonical model is the MDAST, edits made in raw mode flow back into the MDAST (and out to any other live pane on the same document) through the bridge in [`./05-lossless-bridge.md`](./05-lossless-bridge.md).

---

## 4. Vim (CodeMirror 6 + `@replit/codemirror-vim`)

### 4.1 Engine

Vim mode is the **same CodeMirror 6 editor as raw Markdown**, with the **`@replit/codemirror-vim`** extension layered on (D4, README §6). `@replit/codemirror-vim` is **the maintained CM6 Vim package** — it provides **normal**, **insert**, and **visual** modes (reference: <https://github.com/replit/codemirror-vim>). It edits the **same serialized canonical Markdown string** as raw mode (§3.2); the only difference between raw and Vim is the keybinding layer and the modal cursor behavior.

CM6 being Obsidian's editor core (README §6) means this is the same lineage of "real Vim in a real text editor in the browser" that experienced Markdown writers already expect.

### 4.2 Vim sub-modes

| Sub-mode | Cursor / behavior |
|----------|-------------------|
| **normal** | Motions and operators; keys are commands, not text |
| **insert** | Typed keys insert text (closest to ordinary editing) |
| **visual** | Selection mode; motions extend a highlighted selection |

The current Vim sub-mode is surfaced in the **mode indicator** (§7) so the writer always knows whether a keypress will type a character or run a command.

### 4.3 Integration gotchas (normative — get these wrong and Vim breaks)

These are not optional implementation notes; each is a known failure that the round-trip and behavior tests must guard against.

| # | Gotcha | Rule |
|---|--------|------|
| G1 | **Extension order** | `vim()` **must be added BEFORE other keymaps** in the CM6 `extensions` array. Vim must see keys first; if a non-Vim keymap precedes it, that keymap will swallow keys Vim needs (e.g. movement, operators) and Vim behaves erratically. |
| G2 | **Selection rendering** | You **must include `drawSelection`** in the extensions so that **visual-mode selection actually renders**. Without `drawSelection`, visual mode "works" logically but the highlighted range is invisible — the writer cannot see their selection. |
| G3 | **Drive the indicator from mode-change events** | **Subscribe to Vim's mode-change events** to drive the **per-pane mode indicator** (§7). The indicator's normal/insert/visual label is a function of these events, not of guesswork or keystroke sniffing. |
| G4 | **Do not recreate the `EditorView` on every render** | In React, **do NOT recreate the `EditorView` on every render** — re-mounting the view **drops Vim state** (the writer loses their mode, registers, marks, pending operator, etc.). Create the `EditorView` once (e.g. in an effect keyed to the pane/document identity, or via a stable ref) and keep it across renders. |
| G5 | **Sync via transactions, not full control** | **Sync the document via CM6 transactions**, **not by treating `value` as a fully controlled prop.** A naive controlled-component pattern (`value={state}` → dispatch a full replace on every change) destroys the cursor, the Vim mode, and the undo history on every external update. External edits (from the bridge) must be applied as **dispatched transactions** that patch the changed ranges, preserving selection and Vim state. |

G4 and G5 together are the React-integration crux: the **editor owns its live state and is never a controlled component of a reactive query** (README D11; plan performance contract). The bridge applies external Markdown edits as targeted transactions; it does not blow away and rebuild the view. This mirrors the same constraint applied to the rich editor in [`./05-lossless-bridge.md`](./05-lossless-bridge.md).

---

## 5. Preview

### 5.1 Engine and behavior

Preview is **read-only** (D5, README §1, §6). It renders the **canonical MDAST to HTML**, never re-parsing a separate copy of the text — it consumes the same tree every other mode shares, so it cannot drift. The pipeline (README §6):

| Stage | Package | Role |
|-------|---------|------|
| 1 | `remark-rehype` | Transform the canonical MDAST into a HAST (HTML AST) |
| 2 | `rehype-sanitize` | Sanitize the HAST — strip unsafe HTML/attributes before it can reach the DOM |
| 3 | `rehype-stringify` | Serialize the sanitized HAST to an HTML string for display |

Sanitization (`rehype-sanitize`) is non-negotiable even in a single-user tool: pasted or imported content can contain raw HTML, and the preview must never become an injection surface.

Because preview is a pure projection of the MDAST, it requires no second Markdown parser and therefore has no parser to drift from the canonical one (README §6 rationale: "Same AST → HTML; no second parser to drift").

### 5.2 Styling

Preview is styled with the **reading typography** defined in [`./12-design-system.md`](./12-design-system.md) — the considered, premium, dark, typography-first treatment (README §4 principle 6). Preview is where the writer sees the piece as a reader would; it is therefore the most type-forward of the four modes and inherits the reading-mode type scale, measure, and rhythm from the design system rather than the denser editing chrome of the other modes.

Preview is read-only: there is no cursor, no insertion, no toolbar, no slash palette. To edit, the writer switches the pane to rich, raw, or Vim (§6).

---

## 6. Mode switching

### 6.1 Shortcuts

A pane's mode is changed with a keyboard shortcut. All mode-switch chords use **`Ctrl+Shift+*`** (the app-chord namespace; rationale in §8 and [`./13-keyboard-commands.md`](./13-keyboard-commands.md)):

| Target mode | Shortcut |
|-------------|----------|
| Rich text | **`Ctrl+Shift+R`** |
| Raw Markdown | **`Ctrl+Shift+M`** |
| Vim | **`Ctrl+Shift+V`** |
| Preview | **`Ctrl+Shift+P`** |
| Cycle to next mode | a dedicated **cycle binding** (rotates rich → raw → Vim → preview → rich; exact key in [`./13-keyboard-commands.md`](./13-keyboard-commands.md)) |

Shortcuts act on the **active pane** (README §7 `workspaces.activePaneId`). The mode change is also reachable from the command palette (`cmdk`, README §6) for discoverability; [`./13-keyboard-commands.md`](./13-keyboard-commands.md) is the source of truth for the full keymap and the literal cycle key.

### 6.2 Why switching is instant and lossless

Switching is **instant and lossless** (README §1, principle 4) because **all four modes are views of the canonical model** (D2). Switching mode does not convert, export, import, or reconcile anything — the pane simply **mounts a different view over the canonical MDAST it is already bound to**:

- Rich → raw/Vim: the canonical MDAST is serialized to the Markdown string (the same string already kept in sync), and CM6 displays it.
- raw/Vim → rich: Milkdown renders the same canonical MDAST as WYSIWYG.
- any → preview: the MDAST is rendered to HTML.

No conversion happens *at switch time* that could lose information. The continuous, keystroke-level work of keeping the MDAST and the serialized string in agreement happens **while editing**, not at the switch — and its mechanics (origin-guarded, throttled, cursor-preserving diffs in both directions over the MDAST bus) are specified in [`./05-lossless-bridge.md`](./05-lossless-bridge.md). From this file's perspective the contract is simply: when you switch, the new view shows the exact same content, byte-stable within the supported dialect (README §4 principle 3).

### 6.3 What is preserved across a switch

- **Content**: byte-stable within the dialect (the losslessness contract, README §4 principle 3 and §8).
- **Cursor / selection where meaningful**: switching to or from an editable mode preserves caret/selection position as far as the projection allows (the cursor-preservation mechanics are in [`./05-lossless-bridge.md`](./05-lossless-bridge.md)).
- **The document binding**: a switch changes the *mode* of the pane, never the document it is bound to.

---

## 7. The mode indicator UI

Every pane shows a **mode indicator**:

| Property | Specification |
|----------|---------------|
| Scope | **Per-pane** — each pane has its own indicator (two panes can show two different modes for the same document) |
| Visibility | **Always visible** while the pane is mounted |
| Content (non-Vim) | The current mode name: **Rich text**, **Raw Markdown**, **Vim**, or **Preview** |
| Content (Vim) | The mode name **Vim** plus the current **sub-mode**: **normal**, **insert**, or **visual** (e.g. `Vim · normal`) |
| Data source for Vim sub-mode | Driven by subscribing to `@replit/codemirror-vim` **mode-change events** (gotcha G3, §4.3) — never inferred from keystrokes |
| Styling | Minimal, consistent with the bespoke dark design system ([`./12-design-system.md`](./12-design-system.md)); it is chrome, so it stays quiet per principle 5/6 (README §4) |

The Vim sub-mode portion of the indicator is essential, not decorative: in Vim, whether a keypress types a character or runs a command depends entirely on the sub-mode, so the indicator is how the writer knows the meaning of their next keystroke. The indicator updates synchronously with the Vim mode-change events it subscribes to.

The per-pane mode (and, with it, what the indicator shows on restore) is part of `workspaces.perPaneViewState` (README §7), so the indicator reflects the restored mode when a workspace is reopened on any device (README §1 cross-device resume).

---

## 8. Vim vs app-shortcut conflicts

Vim's normal mode treats nearly every bare key as a command (`r`, `m`, `v`, `p`, and so on), so app shortcuts must not collide with them.

**Rule (normative):**

| Rule | Detail |
|------|--------|
| App-chord namespace | Application chords — including all mode switches (§6.1) — use **`Ctrl+Shift+*`** specifically **to avoid colliding with Vim normal-mode keys**. A bare `r`/`m`/`v`/`p` is therefore always free for Vim; `Ctrl+Shift+R`/`M`/`V`/`P` is always the app. |
| Precedence | When a pane is in Vim mode, **Vim keybindings take precedence for bare and Vim-modifier keys**; the app intercepts only its reserved **`Ctrl+Shift+*`** chords. Because the two key spaces are disjoint, there is no ambiguity to resolve — a key is either a Vim key or an app chord, never both. |
| Consequence | The four single-letter mode-switch mnemonics (`R`/`M`/`V`/`P`) are safe to use *because* they are always taken under `Ctrl+Shift`, never bare. |

Note that gotcha G1 (§4.3) — `vim()` before other keymaps in the CM6 extension array — is the implementation that makes this precedence real at the CM6 level: Vim sees keys first, and the app's `Ctrl+Shift+*` chords are handled at the application layer above the CM6 instance. The complete keymap, including how app chords are registered relative to focused editors, is in [`./13-keyboard-commands.md`](./13-keyboard-commands.md).

---

## 9. Key facts (summary of load-bearing decisions)

- **All four modes are VIEWS of the one canonical remark MDAST** — never separate documents, never format-to-format conversion (D1, D2).
- **A pane binds one document to one mode** (README glossary); the same document can be open in two panes in two modes, kept in sync keystroke-by-keystroke (D6).
- **Rich text = Milkdown**, whose model *is* a remark MDAST → rich editing is editing the canonical tree, not "convert later" (D3).
- **Raw + Vim = CodeMirror 6**; `@replit/codemirror-vim` is the **maintained CM6 Vim package** (normal/insert/visual), and **CM6 is what Obsidian uses** (D4).
- **Preview = `remark-rehype` + `rehype-sanitize` + `rehype-stringify`**, read-only, styled with reading typography (D5).
- **Vim React integration**: `vim()` before other keymaps; include `drawSelection`; drive the indicator from mode-change events; never recreate the `EditorView` per render; sync via transactions, not full control (§4.3).
- **Mode switching is instant and lossless** because switching only changes which projection is mounted (§6.2); live sync mechanics are in [`./05-lossless-bridge.md`](./05-lossless-bridge.md).
- **App chords use `Ctrl+Shift+*`** to stay disjoint from Vim normal-mode keys (§8).

---

## 10. Cross-references

| File | Why you'd go there from here |
|------|------------------------------|
| [`./05-lossless-bridge.md`](./05-lossless-bridge.md) | The live two-way sync that keeps the MDAST and serialized string in agreement keystroke-by-keystroke, cursor preservation, origin-guarded throttled diffs — the mechanics behind §6.2 |
| [`./06-markdown-dialect.md`](./06-markdown-dialect.md) | The exact supported constructs (CommonMark + GFM + footnotes + frontmatter), serialization/normalization rules, and the round-trip corpus that guarantees the rich/raw parity §2.1 depends on |
| [`./13-keyboard-commands.md`](./13-keyboard-commands.md) | The authoritative slash command list (§2.3), the full keymap, the literal cycle binding (§6.1), and Vim/app-chord interplay (§8) |
| [`./12-design-system.md`](./12-design-system.md) | The reading typography that styles preview (§5.2) and the visual tokens for the contextual toolbar (§2.4) and mode indicator (§7) |
| [`./09-documents-workspace-split.md`](./09-documents-workspace-split.md) | How panes, the pane tree, and `workspaces.perPaneViewState` persist the per-pane mode this file references |
