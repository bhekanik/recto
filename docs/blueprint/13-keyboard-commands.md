# Recto — Keyboard, Commands & Slash

> Part of the Recto blueprint. The canonical specification is [`./README.md`](./README.md); if anything here contradicts it, the README wins. This file is self-contained: it fully specifies Recto's keyboard model — the global keymap, the `cmdk` command palette, the rich-text slash commands, the Vim interplay, and the conflict-resolution rules between browser defaults, Vim, the editor engines' internal keymaps, and Recto's own global chords.
>
> This file is the **source of truth** for the literal keymap and the literal slash command list that the other files defer to. In particular: [`./04-editor-modes.md`](./04-editor-modes.md) §2.3 and §6.1 explicitly point here for "the authoritative, exact slash command list" and "the literal cycle binding." Where this file states a binding, it is canon; where it states behavior, it must never contradict locked decisions **D1–D15** in [`./README.md`](./README.md).
>
> **Sibling cross-references used throughout:** the four modes, the mode indicator, and the Vim/app-chord rationale are in [`./04-editor-modes.md`](./04-editor-modes.md); the supported Markdown constructs each slash command maps to are in [`./06-markdown-dialect.md`](./06-markdown-dialect.md); the branching undo navigation and visualizer are in [`./07-undo-tree.md`](./07-undo-tree.md); tagged versions / checkpoints and history are in [`./08-version-control.md`](./08-version-control.md); copy and export mechanics are in [`./11-clipboard-export.md`](./11-clipboard-export.md); the visual treatment of the palette, slash menu, and shortcut hints is in [`./12-design-system.md`](./12-design-system.md).

---

## 1. Philosophy: keyboard-first

Recto is **keyboard-first**. The product principle is that *the tool disappears* (README §4, principle 5): minimal chrome, no persistent toolbars competing with the writing surface, formatting via Markdown shortcuts, slash commands, and contextual UI. A keyboard-first model is the operational form of that principle — if the hands never have to leave the home row, there is no need for permanent menu chrome to reach for.

Three rules govern the whole keyboard model:

1. **Every action is reachable without the mouse.** Mode switches, pane management, document switching, history navigation, copy/export, and view toggles all have keyboard paths. The mouse is an accelerator, never a requirement.
2. **Discoverability lives in the command palette, not in chrome.** Because there are no persistent toolbars to scan, the way a writer *finds* an action and *learns its shortcut* is the **command palette** (`cmdk`, README §6). Every palette row shows its own keyboard shortcut (§4), so the palette doubles as a living, searchable cheat-sheet. A writer can do everything through the palette on day one and graduate to direct chords as muscle memory forms — the palette teaches the chord while performing the action.
3. **Chords never fight the writing.** Recto's global chords are deliberately confined to a namespace (`Ctrl+Shift+*`, §7) chosen so they never collide with what the focused editor — especially Vim — needs. Typing always wins inside the text; global chords win only where they are reserved.

These rules are the same ones that make Recto **snappy** (principle 4) and **lossless** (principle 3) at the UI layer: a mode switch is a keystroke that mounts a different projection of the one canonical model ([`./04-editor-modes.md`](./04-editor-modes.md) §6.2), never a transform; an action invoked from the palette runs the same code path as its chord.

> Platform note used in every table below: **mac** uses `Cmd` for the palette-style accelerators that mirror native conventions; **win/linux** uses `Ctrl`. Recto's *mode and structural* chords use **`Ctrl+Shift+*` on all platforms** (including mac) by design — that namespace is reserved (§7) and must stay identical across platforms so the four single-letter mnemonics (`R`/`M`/`V`/`P`) remain disjoint from Vim keys ([`./04-editor-modes.md`](./04-editor-modes.md) §8). Where mac and win/linux differ, both variants are given explicitly.

---

## 2. Full keymap

The keymap below is the complete set of global Recto actions and their bindings. Unless a row says otherwise, a binding fires regardless of which pane or mode has focus (it is a global chord, §7) and acts on the **active pane** (README §7, `workspaces.activePaneId`). Bindings shown as `Ctrl+Shift+*` are identical on mac and win/linux. Bindings that mirror OS conventions are shown as `Cmd/Ctrl+…` (mac / win+linux).

Notation: `Ctrl+Shift+R` means hold Ctrl and Shift, press R. `Cmd/Ctrl+K` means `Cmd+K` on mac, `Ctrl+K` on win/linux. A `·` in a context column separates qualifiers.

### 2.1 Modes (per-pane projection switches)

These act on the active pane and only change which projection of the canonical model is mounted — instant and lossless ([`./04-editor-modes.md`](./04-editor-modes.md) §6). The chords live in the reserved `Ctrl+Shift+*` namespace specifically so a bare `r`/`m`/`v`/`p` stays free for Vim (§7; [`./04-editor-modes.md`](./04-editor-modes.md) §8).

| Action | mac | win / linux | Context |
|--------|-----|-------------|---------|
| Switch active pane to **Rich text** | `Ctrl+Shift+R` | `Ctrl+Shift+R` | Active pane, any mode |
| Switch active pane to **Raw Markdown** | `Ctrl+Shift+M` | `Ctrl+Shift+M` | Active pane, any mode |
| Switch active pane to **Vim** | `Ctrl+Shift+V` | `Ctrl+Shift+V` | Active pane, any mode |
| Switch active pane to **Preview** | `Ctrl+Shift+P` | `Ctrl+Shift+P` | Active pane, any mode |
| **Cycle mode** (next projection) | `Ctrl+Shift+]` | `Ctrl+Shift+]` | Active pane; rotates **Rich text → Raw Markdown → Vim → Preview → Rich text** |
| **Cycle mode** (previous projection) | `Ctrl+Shift+[` | `Ctrl+Shift+[` | Active pane; rotates the same ring in reverse |

> The cycle ring order — **Rich text → Raw Markdown → Vim → Preview → Rich text** — is canon and matches the order stated in [`./04-editor-modes.md`](./04-editor-modes.md) §6.1. `Ctrl+Shift+]` advances around the ring; `Ctrl+Shift+[` reverses it. Both wrap. Because `Ctrl+Shift+P` is the *Preview* mnemonic in Recto, the palette is **not** bound to `Ctrl+Shift+P` (it is `Cmd/Ctrl+K`, §2.2) — this avoids the common browser/editor clash where `Ctrl+Shift+P` means "command palette."

### 2.2 Command palette & documents

| Action | mac | win / linux | Context |
|--------|-----|-------------|---------|
| **Open command palette** (`cmdk`) | `Cmd+K` | `Ctrl+K` | Global |
| **New document** | `Cmd+N` | `Ctrl+Alt+N` | Global |
| **Switch / quick-open document** | `Cmd+P` | `Ctrl+P` | Global; opens the palette pre-scoped to the **Documents** section (§4.2) |

> `Cmd+N` is free on mac (the browser's "new window" is `Cmd+Shift+N` / `Cmd+N` is reclaimable in a focused web app via the global handler, §7.3); on win/linux `Ctrl+N` is a hard browser "new window" that cannot be reliably intercepted, so **New document** is `Ctrl+Alt+N` there. Quick-open uses `Cmd/Ctrl+P`; on win/linux this shadows the browser print dialog and is one of the few defaults Recto intentionally overrides while a pane is focused — see the conflict rules in §7.3. Either way, **every one of these is also a row in the command palette** (§4), which is the discoverable, platform-independent path.

### 2.3 Panes & splits

The split layout is a recursive **pane tree** (README glossary; full mechanics in [`./09-documents-workspace-split.md`](./09-documents-workspace-split.md)), built on `react-resizable-panels` (README §6). These chords operate on the **active pane** (`workspaces.activePaneId`).

| Action | mac | win / linux | Context |
|--------|-----|-------------|---------|
| **Split pane — vertical** (new pane to the right) | `Cmd+\` | `Ctrl+\` | Active pane |
| **Split pane — horizontal** (new pane below) | `Cmd+Shift+\` | `Ctrl+Shift+\` | Active pane |
| **Close pane** | `Cmd+Shift+W` | `Ctrl+Shift+W` | Active pane; does not close the document if another pane still binds it ([`./04-editor-modes.md`](./04-editor-modes.md) / [`./02-architecture.md`](./02-architecture.md) §6.3) |
| **Focus next pane** | `Cmd+K` then `→` *(see note)* | `Ctrl+K` then `→` | Any pane; cycles focus forward through the pane tree |
| **Focus previous pane** | `Cmd+K` then `←` | `Ctrl+K` then `←` | Any pane; cycles focus backward |

> **Focus next/previous pane** use a leader-style two-step (`Cmd/Ctrl+K`, release, then an arrow) so that the bare arrow keys are never stolen from the editor — arrows must remain pure cursor motion inside the text and pure list navigation inside the palette. A single-press alternative `Ctrl+Shift+→` / `Ctrl+Shift+←` is also registered in the global namespace for writers who prefer one chord; both are surfaced in the palette's **Panes** section (§4.2). Splitting a pane targets the **active pane** as the node to split; the newly created pane inherits the same document binding and starts in the same mode as the pane it was split from, then can be switched independently (per-pane mode, [`./04-editor-modes.md`](./04-editor-modes.md) §7).

### 2.4 History — checkpoints, undo tree, versions

These wire to the branching undo tree ([`./07-undo-tree.md`](./07-undo-tree.md)) and tagged versions ([`./08-version-control.md`](./08-version-control.md)). "Create version / tag (checkpoint)" creates a manual tagged version — a durable, named reference to the current node in the DAG (README §7 `versions`, `kind: "manual"`).

| Action | mac | win / linux | Context |
|--------|-----|-------------|---------|
| **Undo** | `Cmd+Z` | `Ctrl+Z` | Focused editable pane (rich / raw / Vim) — walks the undo tree toward the parent node ([`./07-undo-tree.md`](./07-undo-tree.md)) |
| **Redo** | `Cmd+Shift+Z` | `Ctrl+Y` *or* `Ctrl+Shift+Z` | Focused editable pane — walks toward a child node ([`./07-undo-tree.md`](./07-undo-tree.md)) |
| **Create version / tag (checkpoint)** | `Cmd+S` | `Ctrl+S` | Active document; creates a **manual** tagged version ([`./08-version-control.md`](./08-version-control.md)). There is no "save" action — saving is silent and continuous (D11); `Cmd/Ctrl+S` is repurposed to "checkpoint" |
| **Open undo-tree visualizer** | `Ctrl+Shift+U` | `Ctrl+Shift+U` | Global; opens the branching-history visualizer for the active document ([`./07-undo-tree.md`](./07-undo-tree.md)) |
| **Open version history** | `Ctrl+Shift+H` | `Ctrl+Shift+H` | Global; opens the tagged-version timeline for the active document ([`./08-version-control.md`](./08-version-control.md)) |

> `Cmd/Ctrl+S` is given a meaning even though Recto never needs an explicit save (autosave is continuous and silent, README §4 principle 2; D11) — intercepting it prevents the browser's "save page" dialog *and* gives the muscle-memory keystroke a useful, non-destructive job: drop a manual checkpoint. **Undo/Redo are the one place Recto deliberately keeps the OS-standard bare chords** (`Cmd/Ctrl+Z`, `Cmd+Shift+Z` / `Ctrl+Y`) rather than the `Ctrl+Shift+*` namespace, because they belong to the *focused editor's* edit semantics, not to global chrome — and when a pane is in **Vim** mode, undo/redo are owned by Vim (`u` / `Ctrl-r`) per the precedence rules in §6 and §7. The undo-tree visualizer and version-history panel are reached with reserved `Ctrl+Shift+*` chords because they are global app surfaces.

### 2.5 Copy / Export

Full mechanics in [`./11-clipboard-export.md`](./11-clipboard-export.md). "Copy as rich text" and the plain-text fallback are the two clipboard payloads Recto writes together; "Copy as Markdown" is the Markdown-specific path; "Export" writes a file.

| Action | mac | win / linux | Context |
|--------|-----|-------------|---------|
| **Copy** (writes both rich **HTML** + **plain text** to the clipboard) | `Cmd+C` | `Ctrl+C` | Standard copy of the current selection (selection present) |
| **Copy as rich text** (whole document, HTML + plain text payload) | `Cmd+Shift+C` | `Ctrl+Shift+C` | Active document; the rich-HTML-plus-plaintext copy described in [`./11-clipboard-export.md`](./11-clipboard-export.md) |
| **Copy as Markdown** (whole document, canonical Markdown string) | `Cmd+Alt+C` | `Ctrl+Alt+C` | Active document; copies the canonical serialized Markdown ([`./11-clipboard-export.md`](./11-clipboard-export.md)) |
| **Export** (open the export action — `.md` / `.html`) | `Ctrl+Shift+E` | `Ctrl+Shift+E` | Active document; export to `.md` or `.html` ([`./11-clipboard-export.md`](./11-clipboard-export.md)) |

> Bare `Cmd/Ctrl+C` keeps its OS meaning (copy the current selection); inside the rich editor that selection copy already places both HTML and plain text on the clipboard (the "copy" payload, [`./11-clipboard-export.md`](./11-clipboard-export.md)). The two document-scope copy variants and export are distinct global actions in the **Copy/Export** palette section (§4.2). Export is a single reserved chord that opens the export affordance where the writer chooses `.md` or `.html`; the format choice itself is a palette/dialog selection, not separate top-level chords, to keep the keymap small.

### 2.6 View

| Action | mac | win / linux | Context |
|--------|-----|-------------|---------|
| **Toggle word count / status** | `Ctrl+Shift+S` | `Ctrl+Shift+S` | Global; shows/hides the word-count + status readout. Word count is **always available** (D15) — this toggles its *visibility chrome*, not its computation |
| **Toggle focus mode** | `Ctrl+Shift+F` | `Ctrl+Shift+F` | Global; collapses remaining chrome to maximize the writing surface (principle 5/6, README §4) |

> Toggling the word-count/status readout never disables the count — D15 makes word count always available; it is derived from the live model regardless of whether its chip is visible ([`./02-architecture.md`](./02-architecture.md) §4). Focus mode is a chrome state, not a fifth mode; the four canonical modes are unchanged ([`./04-editor-modes.md`](./04-editor-modes.md) §1).

### 2.7 Keymap at a glance (all global actions)

| Action | mac | win / linux |
|--------|-----|-------------|
| Mode → Rich text | `Ctrl+Shift+R` | `Ctrl+Shift+R` |
| Mode → Raw Markdown | `Ctrl+Shift+M` | `Ctrl+Shift+M` |
| Mode → Vim | `Ctrl+Shift+V` | `Ctrl+Shift+V` |
| Mode → Preview | `Ctrl+Shift+P` | `Ctrl+Shift+P` |
| Cycle mode (next / prev) | `Ctrl+Shift+]` / `Ctrl+Shift+[` | `Ctrl+Shift+]` / `Ctrl+Shift+[` |
| Command palette | `Cmd+K` | `Ctrl+K` |
| New document | `Cmd+N` | `Ctrl+Alt+N` |
| Quick-open / switch document | `Cmd+P` | `Ctrl+P` |
| Split vertical | `Cmd+\` | `Ctrl+\` |
| Split horizontal | `Cmd+Shift+\` | `Ctrl+Shift+\` |
| Close pane | `Cmd+Shift+W` | `Ctrl+Shift+W` |
| Focus next / prev pane | `Ctrl+Shift+→` / `Ctrl+Shift+←` | `Ctrl+Shift+→` / `Ctrl+Shift+←` |
| Undo / Redo | `Cmd+Z` / `Cmd+Shift+Z` | `Ctrl+Z` / `Ctrl+Y` (or `Ctrl+Shift+Z`) |
| Create version / tag (checkpoint) | `Cmd+S` | `Ctrl+S` |
| Open undo-tree visualizer | `Ctrl+Shift+U` | `Ctrl+Shift+U` |
| Open version history | `Ctrl+Shift+H` | `Ctrl+Shift+H` |
| Copy as rich text | `Cmd+Shift+C` | `Ctrl+Shift+C` |
| Copy as Markdown | `Cmd+Alt+C` | `Ctrl+Alt+C` |
| Export | `Ctrl+Shift+E` | `Ctrl+Shift+E` |
| Toggle word count / status | `Ctrl+Shift+S` | `Ctrl+Shift+S` |
| Toggle focus mode | `Ctrl+Shift+F` | `Ctrl+Shift+F` |

---

## 3. Two distinct keyboard surfaces

It is important not to conflate the two `↑/↓/Enter/Esc`-driven menus Recto has, because they live in different layers and serve different jobs:

| Surface | Lives where | Engine | Scope | Section |
|---------|-------------|--------|-------|---------|
| **Command palette** | Application chrome, over the whole studio | `cmdk` (README §6) | All actions + all documents | §4 |
| **Slash command palette** | Inline at the cursor, **inside the rich-text editor only** | Milkdown insert menu ([`./04-editor-modes.md`](./04-editor-modes.md) §2.3) | Insertable Markdown **blocks** for the current document | §5 |

They share an interaction grammar (`↑/↓` move, `Enter` select, `Esc` close, type to filter) on purpose — it is one muscle memory — but the command palette acts on the *app* and the slash palette inserts *content*. The slash palette exists only in **Rich text** mode; the command palette exists everywhere.

---

## 4. Command palette (`cmdk`)

The command palette is Recto's discoverability and command surface. It is built on **`cmdk`** (README §6) and is opened with `Cmd/Ctrl+K` (§2.2). Its visual treatment — overlay, sectioning, shortcut-hint styling — follows [`./12-design-system.md`](./12-design-system.md).

### 4.1 Behavior

- **Fuzzy search over everything.** A single query box fuzzy-matches across *all actions* (every row in the §2 keymap and more) **and all documents** (by title). Typing `prev`, `prview`, or `pv` all surface "Switch to Preview"; typing a document title surfaces that document.
- **Sectioned results.** Matches are grouped into stable sections (§4.2) so the list is scannable even before filtering. With an empty query the palette shows recent/likely actions and recent documents; as the query narrows, empty sections collapse.
- **Every row shows its shortcut.** Each action row renders its keyboard shortcut on the right (the same chord from §2, platform-correct). This is how the palette teaches the keymap (philosophy rule 2, §1): you find the action by name, you see and learn the chord, you eventually skip the palette.
- **Selecting runs the real action.** Choosing a palette row invokes the *same* handler the chord would — there is exactly one implementation per action, registered once (§7.3), surfaced two ways.

### 4.2 Sections

| Section | Contents |
|---------|----------|
| **Documents** | Open / quick-open documents by title; **New document**. (This is the section `Cmd/Ctrl+P` opens pre-scoped to, §2.2.) |
| **Modes** | Switch active pane to Rich text / Raw Markdown / Vim / Preview; Cycle mode next / previous ([`./04-editor-modes.md`](./04-editor-modes.md) §6) |
| **Panes** | Split vertical; Split horizontal; Close pane; Focus next pane; Focus previous pane ([`./09-documents-workspace-split.md`](./09-documents-workspace-split.md)) |
| **History** | Create version / tag (checkpoint); Open undo-tree visualizer; Open version history; (and undo/redo, which also have native chords) ([`./07-undo-tree.md`](./07-undo-tree.md), [`./08-version-control.md`](./08-version-control.md)) |
| **Copy/Export** | Copy as rich text; Copy as Markdown; Export `.md`; Export `.html` ([`./11-clipboard-export.md`](./11-clipboard-export.md)) |
| **View** | Toggle word count / status; Toggle focus mode |

The section order above is the canonical display order: **Documents, Modes, Panes, History, Copy/Export, View**.

### 4.3 Keyboard navigation

| Key | Behavior |
|-----|----------|
| `↑` / `↓` | Move the highlight up / down through the visible (filtered) rows, across section boundaries |
| `Enter` | Run the highlighted action, or open the highlighted document; then close the palette |
| `Esc` | Close the palette without running anything; focus returns to the previously active pane |
| *(type)* | Any printable character filters the list live (fuzzy); `Backspace` widens the filter |

The palette is **fully keyboard-operable end to end**: open with `Cmd/Ctrl+K`, type to filter, `↑/↓` to highlight, `Enter` to run, `Esc` to dismiss — the mouse is never required. This mirrors the slash palette's grammar (§5) so a writer learns one set of motions.

---

## 5. Slash commands (Rich text mode)

In **Rich text** mode (Milkdown), typing `/` opens an inline insert palette at the cursor ([`./04-editor-modes.md`](./04-editor-modes.md) §2.3). It exists **only** in Rich text mode; Raw Markdown, Vim, and Preview have no slash palette (in raw/Vim you type the Markdown directly; Preview is read-only).

The slash palette inserts **blocks** and a small set of inline constructs; the inline *marks* on an existing selection are normally applied through the contextual formatting toolbar or Markdown input shortcuts ([`./04-editor-modes.md`](./04-editor-modes.md) §2.4). Every entry the slash palette can produce is a construct that exists in Recto's Markdown dialect (README §8) — there are no rich-only entries, because the rich editor may only produce things with a faithful Markdown representation (D2; [`./04-editor-modes.md`](./04-editor-modes.md) §1.2).

### 5.1 The slash command list (authoritative)

This is the canonical, ordered list the rest of the blueprint defers to ([`./04-editor-modes.md`](./04-editor-modes.md) §2.3). "Trigger label" is what the writer reads in the menu; "Aliases" are additional fuzzy-match terms; "Inserts (dialect construct)" names the [`./06-markdown-dialect.md`](./06-markdown-dialect.md) construct produced, which is what serializes into the canonical Markdown string.

| # | Trigger label | Aliases | Inserts (dialect construct → Markdown) |
|---|---------------|---------|----------------------------------------|
| 1 | **Heading 1** | `h1`, `title` | ATX heading level 1 → `# ` |
| 2 | **Heading 2** | `h2`, `subtitle` | ATX heading level 2 → `## ` |
| 3 | **Heading 3** | `h3` | ATX heading level 3 → `### ` |
| 4 | **Bold** | `b`, `strong` | Strong inline mark → `**…**` |
| 5 | **Italic** | `i`, `em`, `emphasis` | Emphasis inline mark → `*…*` |
| 6 | **Strikethrough** | `strike`, `del`, `s` | GFM strikethrough → `~~…~~` |
| 7 | **Inline code** | `code`, `mono` | Inline code span → `` `…` `` |
| 8 | **Bullet list** | `ul`, `unordered`, `list` | Unordered list → `- ` items |
| 9 | **Numbered list** | `ol`, `ordered`, `number` | Ordered list → `1. ` items |
| 10 | **Task list** | `todo`, `checkbox`, `check` | GFM task list → `- [ ] ` items |
| 11 | **Blockquote** | `quote`, `bq` | Block quote → `> ` |
| 12 | **Code block** | `pre`, `fence`, `codeblock` | Fenced code block → ` ``` ` + info string (language) |
| 13 | **Divider** | `hr`, `rule`, `separator` | Thematic break → `---` |
| 14 | **Table** | `tbl`, `grid` | GFM table → header row + alignment row + `|` cells |
| 15 | **Link** | `url`, `href`, `a` | Inline link → `[text](url)` |
| 16 | **Image** | `img`, `picture` | Image → `![alt](src)` |
| 17 | **Footnote** | `fn`, `note`, `ref` | Footnote reference + definition → `[^id]` … `[^id]: …` |

> Headings stop at H1–H3 in the slash list because those are the practical structural levels for newsletters/articles; the dialect supports H4–H6 (README §8), and they remain reachable via Markdown input shortcuts (`#### `, etc.) and the canonical Markdown in raw/Vim mode. **Bold / Italic / Strikethrough / Inline code** appear in the slash list as a convenience when there is no selection (they insert an empty, ready-to-type mark); on an existing selection the contextual toolbar ([`./04-editor-modes.md`](./04-editor-modes.md) §2.4) is the primary path. **Link** and **Image** open a small inline field to capture the URL/`src` before insertion.

### 5.2 Slash palette keyboard navigation

These match the behavior canonized in [`./04-editor-modes.md`](./04-editor-modes.md) §2.3:

| Key | Behavior |
|-----|----------|
| `↓` | Move the highlight **down** the filtered list |
| `↑` | Move the highlight **up** the filtered list |
| `Enter` | **Select / insert** the highlighted block; removes the `/` query text from the document |
| `Esc` | **Close** the palette without inserting; the typed `/query` is left as literal characters |
| `Tab` | **Continue typing** — accept-and-advance within the palette (advances selection / continues the query as specified in [`./04-editor-modes.md`](./04-editor-modes.md) §2.3) |
| *(type)* | Characters typed after `/` **filter** the list live (fuzzy over labels + aliases) |

The slash palette is opened by typing `/` at the start of an empty block or after whitespace ([`./04-editor-modes.md`](./04-editor-modes.md) §2.3, "Open palette"). It is fully keyboard-navigable — a writer never needs the mouse to insert any block.

### 5.3 How slash maps to the dialect

Each slash entry produces a node in the **canonical remark MDAST** (D1) — not HTML, not a rich-only widget. Because Milkdown's document model *is* the MDAST ([`./02-architecture.md`](./02-architecture.md) §2.1), inserting "Table" from the slash menu mutates the canonical tree directly; serializing that tree with the unified pipeline yields the GFM table syntax shown in the "Inserts" column above. The exact serialization/normalization rules for each construct — table alignment, footnote ordering, fenced-code info strings, link/image escaping — are specified in [`./06-markdown-dialect.md`](./06-markdown-dialect.md) and guarded by its round-trip corpus. The slash list therefore cannot contain anything outside that file's supported set; if a construct is not round-trip-safe in the dialect, it is not a slash entry.

---

## 6. Vim interplay

When a pane is in **Vim** mode (CodeMirror 6 + `@replit/codemirror-vim`, D4; [`./04-editor-modes.md`](./04-editor-modes.md) §4), the keyboard split between "Vim" and "Recto" is deliberate and unambiguous.

### 6.1 Normal-mode keys belong to Vim

In Vim's **normal** sub-mode, nearly every bare key is a command (`r` replace, `m` mark, `v` visual, `p` paste, `d`, `y`, `c`, `w`, `b`, motions, operators, counts). Those keys belong to Vim and Recto does not touch them. This is why Recto's global chords live in the `Ctrl+Shift+*` namespace (§7; [`./04-editor-modes.md`](./04-editor-modes.md) §8): a bare `r`/`m`/`v`/`p` is *always* free for Vim, and `Ctrl+Shift+R`/`M`/`V`/`P` is *always* the app. The two key spaces are **disjoint** — a key is either a Vim key or a Recto chord, never both — so there is no ambiguity to resolve.

### 6.2 `Esc` returns Vim to normal mode — it does not switch app mode

`Esc` inside a Vim pane is a **Vim** key: it returns Vim from insert/visual to **normal** sub-mode. It does **not** switch the pane's Recto mode and does not close the pane or any app surface. Switching *out of* Vim mode is done with the mode chords (`Ctrl+Shift+R/M/P` or the cycle binding, §2.1) or the command palette — never with `Esc`. (`Esc` *does* close the command palette and the slash palette, §4.3/§5.2, but those are app surfaces that are not open while you are typing inside a focused Vim editor.)

### 6.3 Precedence rules (Vim pane focused)

| Order | Key class | Owner | Example |
|-------|-----------|-------|---------|
| 1 | Recto reserved chords `Ctrl+Shift+*` | **Recto (global)** | `Ctrl+Shift+R` switches to Rich text even while Vim has focus |
| 2 | Vim normal/insert/visual keys & Vim modifier combos | **Vim** | bare `r`, `dd`, `p`, `Ctrl-r` (Vim redo), `Esc` (→ normal) |
| 3 | Remaining editor / browser keys | **CodeMirror / browser** | arrow keys when Vim passes them through, `Tab` indentation |

The rule: **the reserved `Ctrl+Shift+*` namespace is intercepted by Recto first (§7.3), everything else inside a Vim pane is Vim's.** Because the namespaces are disjoint, this is not a contested precedence — it is a clean partition. Undo/redo (§2.4) are the explicit case where, *in a Vim pane*, the OS chords yield to Vim's own `u` / `Ctrl-r`: the focused editor owns its edit semantics (§7), and Recto does not impose `Cmd/Ctrl+Z` over Vim's undo.

### 6.4 The mode indicator reflects the Vim sub-mode

The per-pane **mode indicator** ([`./04-editor-modes.md`](./04-editor-modes.md) §7) shows `Vim · normal`, `Vim · insert`, or `Vim · visual`, driven by subscribing to `@replit/codemirror-vim`'s **mode-change events** (gotcha G3, [`./04-editor-modes.md`](./04-editor-modes.md) §4.3) — never inferred from keystrokes. This matters for the keyboard model: whether the next keypress *types a character* or *runs a command* depends entirely on the sub-mode, so the indicator is how the writer reads the meaning of their next key. The indicator updates synchronously with those events.

---

## 7. Conflict-resolution rules

Four keymaps compete for every keystroke: **(a) browser defaults**, **(b) Vim** (in a Vim pane), **(c) the editor engines' internal keymaps** (Milkdown/ProseMirror and CodeMirror 6), and **(d) Recto's global chords**. The model below states which wins where, and how Recto's chords are registered so they win exactly where intended without breaking editing keys.

### 7.1 Precedence order

For a given keystroke, ownership is decided top-down:

| Priority | Layer | Wins when |
|----------|-------|-----------|
| 1 | **Recto reserved global chords** (`Ctrl+Shift+*`, plus the OS-mirroring accelerators `Cmd/Ctrl+K/N/P/S/\`) | The key matches a reserved Recto binding. Registered at the application layer (§7.3) so it is seen regardless of which editor is focused. |
| 2 | **Vim** (only if the focused pane is in Vim mode) | The key is a Vim key (bare / Vim-modifier) and is **not** a reserved Recto chord. Vim is installed *before* other CM6 keymaps (gotcha G1) so it sees keys first within CodeMirror. |
| 3 | **Editor engine internal keymap** (Milkdown/ProseMirror or CodeMirror 6) | The key is an editing key the focused engine handles (e.g. Markdown input rules, list indentation, `Enter` to split a block) and was not claimed above. |
| 4 | **Browser default** | Nothing above claimed the key; the browser does its normal thing. |

The single load-bearing design choice that makes this clean: **Recto's structural/mode chords occupy `Ctrl+Shift+*`, a namespace that none of Vim's normal-mode keys, Milkdown's input rules, or CodeMirror's editing keys use.** Disjoint namespaces turn what would be a precedence *fight* into a precedence *partition* ([`./04-editor-modes.md`](./04-editor-modes.md) §8).

### 7.2 Where each layer must not be disturbed

- **Editing keys are never stolen.** Bare keys, `Enter`, `Tab` (indentation/continuation), arrows, `Backspace`, and Markdown input shortcuts must reach the focused engine (Milkdown or CM6). Recto never binds bare printable keys or unmodified navigation keys globally. This is why "Focus next/previous pane" uses `Ctrl+Shift+arrow` (or a `Cmd/Ctrl+K` leader), never a bare arrow (§2.3).
- **Vim must see its keys first within CM6.** `vim()` is added **before** other CM6 keymaps (gotcha G1, [`./04-editor-modes.md`](./04-editor-modes.md) §4.3); otherwise a competing keymap swallows movement/operator keys and Vim breaks.
- **External edits never come through as a controlled-value reset.** The bridge applies cross-pane edits as dispatched CM6 transactions / ProseMirror steps (gotcha G5, [`./04-editor-modes.md`](./04-editor-modes.md) §4.3; [`./05-lossless-bridge.md`](./05-lossless-bridge.md)), preserving selection, Vim state, and the cursor — a keyboard concern because a clobbered cursor is indistinguishable from a stolen keystroke to the writer.

### 7.3 How Recto's global chords are registered (so they win where intended)

1. **One application-level chord handler, capture-phase.** Recto registers a single global keydown handler at the studio shell, in the **capture phase**, so a reserved chord is recognized *before* the event reaches the focused editor. This is what lets `Ctrl+Shift+R` switch modes while a Milkdown or Vim editor has focus, without the editor ever seeing those keys.
2. **Only the reserved namespace is intercepted.** The handler matches **only** the `Ctrl+Shift+*` chords and the explicit OS-mirroring accelerators in §2 (`Cmd/Ctrl+K`, `Cmd/Ctrl+N`/`Ctrl+Alt+N`, `Cmd/Ctrl+P`, `Cmd/Ctrl+S`, `Cmd/Ctrl+\`, `Cmd+Shift+\`/`Ctrl+Shift+\`, `Cmd+Shift+W`/`Ctrl+Shift+W`, `Cmd+Shift+C`/`Ctrl+Shift+C`, `Cmd+Alt+C`/`Ctrl+Alt+C`). On a match it `preventDefault()`s, stops propagation, runs the action, and (where the chord shadows a browser default like `Cmd/Ctrl+P`, `Cmd/Ctrl+S`, `Cmd/Ctrl+N`) suppresses the browser default while a studio pane is focused. **Every other key falls through untouched** to Vim → engine → browser per §7.1.
3. **Undo/redo are intentionally *not* globally intercepted in editable panes.** They are left to the focused engine (CM6 history, or Vim's `u`/`Ctrl-r` in a Vim pane; Milkdown/ProseMirror history in rich) so the undo tree ([`./07-undo-tree.md`](./07-undo-tree.md)) is driven by the engine that owns the live edit, not by chrome. The palette/visualizer entries (§2.4) are the global, discoverable surface for history.
4. **Single source per action.** Each action is implemented once and bound from one registry; the chord handler (§7.3.1) and the `cmdk` palette (§4) both dispatch into that registry. There is never a second, divergent implementation — which is also why a palette row can faithfully display the exact chord (§4.1).
5. **Browser defaults Recto deliberately overrides** (only while a studio pane is focused): `Cmd/Ctrl+P` (print → quick-open), `Cmd/Ctrl+S` (save page → checkpoint), and on mac `Cmd+N` (handled where reclaimable; on win/linux `Ctrl+N` is *not* reliably interceptable, hence New document is `Ctrl+Alt+N`, §2.2). Browser chords Recto **never** fights (`Cmd/Ctrl+T`, `Cmd/Ctrl+W` for tab/window, `Cmd/Ctrl+L` for the address bar, `Cmd/Ctrl+R` for reload at the browser level) keep their meaning; note Recto's reload-adjacent intent is served by `Ctrl+Shift+R` meaning "Rich text" *inside* the focused app, while the browser's bare-equivalent reload is unaffected because Recto's binding requires `Shift`.

> The net effect: Recto's chords win only in their reserved namespace and a short, explicit accelerator list; Vim wins all of its keys in a Vim pane; the editor engines keep every editing key; and the browser keeps everything else. The partition is the mechanism — disjoint namespaces (§7.1) plus a single capture-phase handler that touches only what it reserves (§7.3.2).

---

## 8. Key facts (summary of load-bearing decisions)

- **Keyboard-first**: every action has a keyboard path; discoverability is the **`cmdk`** command palette, which shows each action's shortcut (§1, §4).
- **Mode chords** are `Ctrl+Shift+R` (Rich text), `Ctrl+Shift+M` (Raw Markdown), `Ctrl+Shift+V` (Vim), `Ctrl+Shift+P` (Preview), plus cycle `Ctrl+Shift+]` / `Ctrl+Shift+[` over the ring **Rich text → Raw Markdown → Vim → Preview** ([`./04-editor-modes.md`](./04-editor-modes.md) §6.1).
- **Command palette** = `Cmd/Ctrl+K`; fuzzy over all actions + documents; sectioned **Documents, Modes, Panes, History, Copy/Export, View**; `↑/↓` move, `Enter` run, `Esc` close (§4).
- **Slash palette** exists only in **Rich text**; lists 17 insertable constructs (§5.1); `↓/↑` move, `Enter` insert, `Esc` close (leaving literal `/`), `Tab` continue, typing filters; every entry maps to a [`./06-markdown-dialect.md`](./06-markdown-dialect.md) construct in the canonical MDAST (§5.2–5.3).
- **Vim interplay**: normal-mode keys belong to Vim; Recto's chords use `Ctrl+Shift+*` to stay disjoint; `Esc` returns Vim to normal (does not switch app mode); the per-pane indicator shows `Vim · normal/insert/visual` from mode-change events (§6).
- **Conflict resolution**: precedence is Recto reserved chords → Vim (if focused) → editor engine → browser; chords are registered via a single **capture-phase** application handler that intercepts **only** the reserved namespace + a short accelerator list, leaving all editing keys to the focused engine (§7).
- **Undo/redo** stay with the focused engine (CM6 history, Vim `u`/`Ctrl-r`, ProseMirror history) and drive the branching undo tree ([`./07-undo-tree.md`](./07-undo-tree.md)); the visualizer (`Ctrl+Shift+U`) and version history (`Ctrl+Shift+H`) are the global surfaces (§2.4).

---

## 9. Cross-references

| File | Why you'd go there from here |
|------|------------------------------|
| [`./04-editor-modes.md`](./04-editor-modes.md) | The four modes, the mode-switch chords' rationale, the slash palette behavior (§2.3), the cycle binding (§6.1), the per-pane mode indicator (§7), and the Vim/app-chord disjoint-namespace rule (§8) this file is the literal source of truth for |
| [`./06-markdown-dialect.md`](./06-markdown-dialect.md) | The exact dialect construct each slash entry produces (§5.1, §5.3), serialization/normalization rules, and the round-trip corpus that constrains the slash list |
| [`./07-undo-tree.md`](./07-undo-tree.md) | What Undo/Redo, the undo-tree visualizer (`Ctrl+Shift+U`), and branch navigation actually do over the append-only DAG |
| [`./08-version-control.md`](./08-version-control.md) | What "Create version / tag (checkpoint)" (`Cmd/Ctrl+S`) and "Open version history" (`Ctrl+Shift+H`) do — tagged versions, auto/manual, additive restore |
| [`./11-clipboard-export.md`](./11-clipboard-export.md) | What Copy (HTML+plain), Copy as rich text, Copy as Markdown, and Export `.md`/`.html` write, and where the format choice is made |
| [`./12-design-system.md`](./12-design-system.md) | The visual treatment of the command palette, the slash menu, the shortcut hints, the mode indicator, and the focus-mode / word-count chrome |
| [`./09-documents-workspace-split.md`](./09-documents-workspace-split.md) | The pane tree, the active pane (`workspaces.activePaneId`), and how split/close/focus chords manipulate it |
