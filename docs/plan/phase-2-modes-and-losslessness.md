# Phase 2 — Modes & Losslessness

> **Status: Complete** (all exit criteria met; mode shortcuts use `⌘K` palette + `Alt+1–4` instead of `Ctrl+Shift+*` per UX feedback).

> **Execution companion to the blueprint.** This file describes *how and in what order* Phase 2 gets built. The canonical *what* is the blueprint: read [`../blueprint/README.md`](../blueprint/README.md) first (it holds locked decisions **D1–D15**, the canonical Convex schema, the Markdown dialect summary, and the glossary). This phase expands and is bound by four blueprint files: [`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md), [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md), [`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md), and [`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md).
>
> This file is **self-contained**: it restates its goal, prerequisites, scope, work breakdown, technical approach, the data-model and dependencies it touches, explicit out-of-scope items, testable exit criteria, and risks. An implementer should be able to execute it with only the blueprint open alongside. If anything here contradicts the blueprint, **the blueprint wins** — open an issue and reconcile (per [`../plan/README.md`](./README.md) Definition of Done §5).

---

## Goal

Turn the single rich-text editing surface delivered in Phase 1 into **all four canonical modes** — **Rich text**, **Raw Markdown**, **Vim**, **Preview** ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §1) — and make **switching a pane's mode instant and lossless** by routing every mode through one canonical remark MDAST (**D1**, **D2**).

Concretely, at the end of Phase 2:

- The unified Markdown pipeline (`remark-parse` + `remark-gfm` + `remark-frontmatter` for parse; `remark-stringify` with the frozen canonical options for serialize) is the **single** (de)serialization used by every mode and by persistence ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §2).
- A single pane can switch among rich / raw / Vim / preview with **switch-on-mode** handoff through the canonical model — byte-stable within the supported dialect ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §8.2).
- The full dialect (CommonMark + GFM + footnotes + YAML frontmatter, **D7**) works end-to-end in all modes.
- The **round-trip property-test corpus** ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §6) is green. **This corpus is the phase gate.**

> **Boundary with Phase 3.** This phase ships **single-pane switch-on-mode** only. The *same document open in two live editable panes at once* (**D6**, the live two-way bridge of [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §1–§8.1) is **out of scope here** and is productized in Phase 3 (multi-doc, split, workspace). Phase 0 already spiked the live bridge and decided the bridge-vs-fallback approach ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §12); Phase 2 builds the *switch* half of that mechanism — which is the same canonical-model handoff happening on demand instead of continuously ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §8.2, "the bridge is just §8.2 happening continuously").

---

## Why now / prerequisites

Phase 2 is the second build phase. It assumes the following are already true and **must not re-do them**:

1. **Phase 0 spikes are done.** The live two-mode bridge and the cloud undo-tree DAG were spiked as throwaways ([`../plan/README.md`](./README.md) Phase map). Two Phase-0 outcomes are load-bearing inputs here:
   - **The bridge approach is decided.** Either the full live bridge ships (Phase 3) or it falls back to switch-on-mode for the same document ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §12). **Either way, single-pane switch-on-mode is in scope for Phase 2 and is unaffected by the fallback decision** — the fallback only relaxes **D6** (two simultaneous live modes), never **D1–D5** or the lossless guarantee ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §12).
   - **The `prosemirror-recreate-steps` build is pinned.** Phase 0 pinned the exact `recreateTransform` build to use ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §4). Phase 2 does **not** need `recreateTransform` for switch-on-mode (a switch tears down and remounts; there is no live diff), but it is documented here because Phase 3 will, and the bridge-protocol primitives this phase introduces are designed to host it.

2. **Phase 1 foundation is done** ([`../plan/README.md`](./README.md) Phase map, Phase 1 refs `02`, `03`, `10`, `12`). Specifically:
   - Next.js (App Router) + Convex + Better Auth shell exists; dark, typography-first ([`../blueprint/README.md`](../blueprint/README.md) §6, **D12**, **D13**, **D14**).
   - **Document CRUD** exists: the `documents` table with `markdown: string` as the canonical serialized form at rest ([`../blueprint/README.md`](../blueprint/README.md) §7).
   - **One rich-text surface (Milkdown) that syncs and never loses words** exists, with live word count (**D15**). Its persistence is the debounced, local-owns-live, hydrate-on-open/idle model (**D11**); the editor is never a controlled component of a reactive query ([`../plan/README.md`](./README.md) Performance contract).

3. **The performance contract carries forward unchanged** ([`../plan/README.md`](./README.md) §Conventions, **D11**): the live editor owns its state; persistence is debounced off the hot path; mode switches feel instant. Phase 2 introduces a second engine (CodeMirror 6) and must apply the same contract to it (the Vim gotchas G4/G5 below are the CM6 form of this rule).

> **Net:** Phase 1 gave us one mode (rich) over the canonical model. Phase 2 gives us the other three modes and the lossless single-pane switch between all four, plus the dialect end-to-end and the corpus that proves it.

---

## In scope

1. **The unified Markdown pipeline as the single (de)serialization for all modes.** One parser config, one serializer config, created once and shared ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §2). The serializer uses the frozen `CANONICAL_STRINGIFY` options ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §2.1; full option table in [`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §2.2–§2.3).
2. **Raw Markdown mode** — CodeMirror 6 + `@codemirror/lang-markdown`, editing the serialized canonical Markdown string ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §3).
3. **Vim mode** — the *same* CodeMirror 6 editor with `@replit/codemirror-vim` layered on (normal / insert / visual), honoring gotchas **G1–G5** ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §4).
4. **Preview mode** — `remark-rehype` (+ `allowDangerousHtml`) → `rehype-sanitize` → `rehype-stringify`, read-only, styled with the reading typography ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §5; [`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §4.6).
5. **Single-pane switch-on-mode (lossless mode switching).** A pane switches among the four modes; the switch is a canonical-model handoff, not a conversion ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §8.2), with caret translation where the projection allows ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §6.3).
6. **Mode-switch keyboard shortcuts** — `Ctrl+Shift+R/M/V/P` plus cycle next/prev `Ctrl+Shift+]` / `Ctrl+Shift+[` over the ring **Rich text → Raw Markdown → Vim → Preview → Rich text** ([`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §2.1), registered via the capture-phase global chord handler ([`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §7.3).
7. **The always-visible per-pane mode indicator**, including the Vim sub-mode (`Vim · normal` / `Vim · insert` / `Vim · visual`), driven by Vim mode-change events ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §7; [`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §6.4).
8. **The rich-text slash command palette** (Milkdown insert menu), keyboard-navigable (`↑/↓/Enter/Esc/Tab/filter`), inserting the 17 dialect blocks of [`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §5.1 ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §2.3).
9. **Full dialect support end-to-end** — GFM tables, task lists, strikethrough, autolinks, footnotes, YAML frontmatter — produced and round-tripped by every mode ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §1).
10. **The round-trip property-test corpus** — all 25 cases of [`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §6 asserting `serialize(parse(md)) === normalize(md)` (and the four companion assertions), run under `bun run test`. **This is the phase gate.**

---

## Out of scope

These are explicitly **not** built in Phase 2 (most are later phases). Listing them prevents scope creep:

- **Same document open in two live, simultaneously-editable panes** (the live two-way bridge, **D6**, [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §1–§8.1). → Phase 3.
- **Multi-document UI / document switcher** ([`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §4.2 Documents section, quick-open). → Phase 3.
- **Split panes / the pane tree / `react-resizable-panels`** (split vertical/horizontal, close pane, focus next/prev). → Phase 3.
- **Workspace persistence & cross-device resume** (`workspaces` row, `paneTree`, `perPaneViewState`). → Phase 3. *(Phase 2 holds per-pane mode in client state only; persisting it is Phase 3.)*
- **Branching undo tree visualizer and `docNodes` DAG navigation** (`Ctrl+Shift+U`). → Phase 4. *(Phase 2 keeps each engine's native undo/redo; bridge/switch updates must not pollute undo history — see Technical Approach §6.)*
- **Tagged versions / version history / additive restore** (`versions`, `Cmd/Ctrl+S` checkpoint, `Ctrl+Shift+H`). → Phase 4.
- **The full `cmdk` command palette** (`Cmd/Ctrl+K`). → introduced in Phase 5 polish (Phase 2 only needs the mode-switch chords; it does **not** build the palette). *(If a minimal palette already exists from Phase 1, Phase 2 only registers its Mode rows; it does not build new sections.)*
- **Clipboard (HTML + plain), copy-as-Markdown, export `.md` / `.html`** ([`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §2.5). → Phase 5.
- **Structured frontmatter metadata panel** — open decision O1 ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §8). Phase 2 edits frontmatter **as a raw YAML block** ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §4.3).
- **Bespoke final design pass / motion polish** ([`../blueprint/README.md`](../blueprint/README.md) §6). → Phase 5. *(Phase 2 styles preview with the reading typography from the design system but does not do the final visual pass.)*

---

## Work breakdown

Grouped into seven workstreams. WS-1 (the pipeline) is the dependency root; WS-2/3/4 (the engines) depend on it; WS-5 (switching) depends on WS-2/3/4; WS-6 (slash) and WS-7 (corpus) can proceed in parallel once WS-1 lands.

### WS-1 — The canonical Markdown pipeline (the single source of (de)serialization)

- **WS-1.1** Create `canonical/parse.ts`: `unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ["yaml"])`; export `parse(md): Root` ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §2.1).
- **WS-1.2** Create `canonical/stringify-options.ts`: the frozen `CANONICAL_STRINGIFY` object ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §2.1) carrying the full option table ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §2.2–§2.3): `bullet:"-"`, `emphasis:"_"`, `strong:"*"`, `fences:true`, `fence:"`"`, `listItemIndent:"one"`, `rule:"-"`, `ruleRepetition:3`, `ruleSpaces:false`, `setext:false`, `incrementListMarker:true`, `tightDefinitions:true`, `resourceLink:true`. `Object.freeze` it; do not pass ad-hoc options anywhere else.
- **WS-1.3** Create `canonical/serialize.ts`: `unified().use(remarkStringify, CANONICAL_STRINGIFY).use(remarkGfm).use(remarkFrontmatter, ["yaml"])`; export `serialize(tree: Root): string`. **`remark-gfm` and `remark-frontmatter` must be attached to the serializer too** — they register the to-markdown handlers for `table`, `delete`, `footnoteReference`, `footnoteDefinition`, task-list `checked`, and `yaml`; without them those nodes throw or silently degrade ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §2.2).
- **WS-1.4** Create `canonical/normalize.ts`: `normalize = (md) => serialize(parse(md))` ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §3).
- **WS-1.5** Repoint Phase 1's Milkdown rich editor to use **this** pipeline for its parse/serialize so Milkdown's MDAST output agrees byte-for-byte with the canonical pipeline ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §2.1, "the remark plugin set in Milkdown must match the canonical parse/serialize pipeline exactly"). Repoint Phase 1's persistence write path to serialize via `serialize()` so a no-op edit produces no byte change (no spurious diff / sync write — [`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §5).

### WS-2 — Raw Markdown mode (CodeMirror 6)

- **WS-2.1** Add a CM6 editor component bound to a document, loading `@codemirror/lang-markdown` for highlighting ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §3.1). The CM6 document text **is** the serialized canonical Markdown string (`documents.markdown`) ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §3.2).
- **WS-2.2** React integration per gotchas **G4/G5**: create the `EditorView` once (stable ref / effect keyed to pane+document identity), never recreate per render; sync external content via dispatched transactions, never as a controlled `value` prop ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §4.3). *(In Phase 2 the only "external content" is hydrate-on-mount and switch handoff; there is no live cross-pane bridge yet.)*
- **WS-2.3** Wire CM6 edits back to the canonical model and to debounced persistence (reuse Phase 1's debounced mutation path, **D10**/**D11**; the throttle/debounce mechanics are in [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §6 and [`../blueprint/README.md`](../blueprint/README.md) §7). On a CM6 doc change, `parse()` the text to refresh the canonical MDAST for word count and persistence; **do not** rebuild any other view (no second pane exists yet).

### WS-3 — Vim mode (CodeMirror 6 + `@replit/codemirror-vim`)

- **WS-3.1** Layer `@replit/codemirror-vim` onto the *same* CM6 component as raw ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §4.1). Vim mode = raw mode + the Vim keybinding layer + modal cursor; it edits the same serialized string.
- **WS-3.2** **G1 — extension order:** `vim()` is added **BEFORE** other keymaps in the CM6 `extensions` array, so Vim sees keys first ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §4.3; [`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §7.2).
- **WS-3.3** **G2 — selection rendering:** include `drawSelection` in the extensions so visual-mode selection actually renders ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §4.3 G2).
- **WS-3.4** **G3 — indicator from events:** subscribe to `@replit/codemirror-vim` **mode-change events** and feed the per-pane mode indicator (WS-5.4); never infer sub-mode from keystrokes ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §4.3 G3; [`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §6.4).
- **WS-3.5** **G4 — do not recreate the view:** confirm WS-2.2's stable `EditorView` holds with Vim — re-mounting drops Vim state (mode, registers, marks, pending operator) ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §4.3 G4).
- **WS-3.6** **G5 — sync via transactions:** external updates (hydrate, switch handoff) are dispatched transactions, never a full controlled replace, preserving selection and Vim state ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §4.3 G5).
- **WS-3.7** Confirm Vim owns `u` / `Ctrl-r` (undo/redo) and `Esc` (→ normal); Recto does **not** impose `Cmd/Ctrl+Z` over a Vim pane and `Esc` does not switch app mode ([`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §6.2–§6.3).

### WS-4 — Preview mode

- **WS-4.1** Create `preview/render.ts`: MDAST → `remark-rehype` (with `allowDangerousHtml: true` so raw `html` nodes reach rehype) → `rehype-sanitize` → `rehype-stringify` ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §5.1; [`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §4.6). Sanitization is **non-negotiable** even single-user.
- **WS-4.2** Render the resulting HTML read-only (no cursor, no toolbar, no slash) styled with the **reading typography** from the design system ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §5.2; [`../blueprint/README.md`](../blueprint/README.md) §6, **D13**). Preview consumes the **same** canonical MDAST every other mode shares — no second parser ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §5.1).
- **WS-4.3** Allow the sanctioned in-cell `<br>` through sanitization (the only allowed `<br>`, table-cell breaks — [`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §4.1, §4.6) by configuring the `rehype-sanitize` schema accordingly.

### WS-5 — Single-pane switch-on-mode + shortcuts + indicator

- **WS-5.1** Define the `Mode` type (`"rich" | "raw" | "vim" | "preview"`) and per-pane client mode state ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §1.1). *(Persistence of this into `workspaces.perPaneViewState` is Phase 3.)*
- **WS-5.2** Implement `switchPaneMode(pane, to)` per the handoff sketch ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §8.2): (1) **flush any pending throttle/debounce synchronously** so the canonical model reflects the outgoing engine; (2) export the caret to a model-space logical position; (3) tear down the outgoing engine; (4) mount the incoming engine **from the canonical model** (rich mounts the MDAST directly; raw/Vim mount `serialize(mdast)`; preview renders); (5) import the caret at the same logical position where the projection allows ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §6.3). A switch is **reproject-the-same-tree**, never a conversion (**D2**).
- **WS-5.3** Register the mode-switch chords via the **single capture-phase application keydown handler** ([`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §7.3): `Ctrl+Shift+R` → rich, `Ctrl+Shift+M` → raw, `Ctrl+Shift+V` → vim, `Ctrl+Shift+P` → preview; `Ctrl+Shift+]` cycle next, `Ctrl+Shift+[` cycle prev over the ring **rich → raw → vim → preview → rich** (both wrap) ([`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §2.1). The handler matches **only** the reserved `Ctrl+Shift+*` namespace, `preventDefault`s, and acts on the active pane; **every other key falls through** to Vim → engine → browser ([`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §7.1–§7.3, §7.3.2). This is what makes `Ctrl+Shift+R` switch modes while a Vim/Milkdown editor has focus without the editor seeing the keys.
- **WS-5.4** Build the **always-visible per-pane mode indicator** ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §7): non-Vim shows the mode name (Rich text / Raw Markdown / Vim / Preview); Vim shows `Vim · normal|insert|visual` driven by the WS-3.4 mode-change subscription. Minimal, quiet chrome ([`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) referenced from §7).

### WS-6 — Rich-text slash command palette

- **WS-6.1** Add the Milkdown slash/insert-menu plugin ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §2.3). Trigger: typing `/` at the start of an empty block or after whitespace opens the palette inline at the cursor; it exists **only** in Rich text mode ([`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §5, §3).
- **WS-6.2** Keyboard interaction: `↓`/`↑` move highlight, `Enter` insert (removing the `/` query), `Esc` close (leaving the literal `/query`), `Tab` continue/accept-and-advance, typing filters live (fuzzy over labels + aliases) ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §2.3; [`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §5.2). Fully keyboard-navigable — no mouse required.
- **WS-6.3** Implement the **17 authoritative entries** in order ([`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §5.1): Heading 1/2/3, Bold, Italic, Strikethrough, Inline code, Bullet list, Numbered list, Task list, Blockquote, Code block, Divider, Table, Link, Image, Footnote — each with its aliases and each inserting the named dialect construct into the canonical MDAST ([`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §5.3). Link/Image open a small inline field for the URL/`src`; Footnote inserts reference + definition.

### WS-7 — The round-trip corpus (the phase gate)

- **WS-7.1** Author the corpus fixtures: all **25 cases** of [`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §6 (headings H1–H6, Setext→ATX, nested unordered/ordered/mixed lists, task lists, tables with all three alignments + null column, tables with escaped pipes, table cell with `<br>`, multiple footnotes out-of-order, orphan/unresolved footnotes, nested-YAML frontmatter, hard breaks (backslash + trailing-spaces input), soft breaks, fenced code with lang + inner backticks, nested blockquotes, links/images with titles, reference-style link + definition, strikethrough, autolinks (angle + bare), inline mix, emphasis/strong delimiter normalization, thematic-break variants, inline raw HTML, idempotence sweep).
- **WS-7.2** Implement the five assertions per case ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §6): (1) idempotence `normalize(md) === normalize(normalize(md))`; (2) round-trip equality `serialize(parse(md)) === normalize(md)`; (3) second-pass stability `serialize(parse(serialize(parse(md)))) === serialize(parse(md))`; (4) for frontmatter cases, the `yaml.value` substring is byte-identical input↔output; (5) cross-surface convergence — feeding the normalized form to both Milkdown (parse → ProseMirror → serialize) and CM6 (raw text → parse → serialize) yields the **same** bytes ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §11.1, §11.3).
- **WS-7.3** Wire the corpus into `bun run test`; it lives next to the dialect code ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §6). A new supported construct requires a new corpus row **before** it is wired into any editor — the corpus is the contract's executable form.

---

## Technical approach & key decisions

### 1. One pipeline, frozen serializer, everywhere

The single most important Phase-2 decision is structural and inherited from canon: **there is one parser config and one serializer config in the whole app** ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §2). Every mode, the switch handoff, persistence, and the corpus import the *same* `parse` / `serialize` / `normalize` / `CANONICAL_STRINGIFY`. Two configs reintroduce drift. Never stringify with a different option set "just for preview" or "just for export" — preview renders HTML from the MDAST and does not re-serialize Markdown at all ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §2.4). Determinism (a pure function from MDAST to one byte-form) is the precondition for both the lossless switch and the corpus ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §2.4).

### 2. A switch is a handoff through the canonical model, not a conversion

Mode switching is **reproject-the-same-tree-through-a-different-engine** ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §8.2, §8 "Critical"). The outgoing engine has kept the canonical MDAST current (rich *is* the MDAST; raw/Vim text was parsed into it on its last tick — flush pending throttles synchronously first). The incoming engine mounts **from the canonical model**, not from the old engine's DOM/state. This is precisely why a switch is lossless where convert-on-switch is not — there is no chain of converters to accumulate drift ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §10.1, the anti-TipTap-#7147 property).

### 3. CM6 is one component for both raw and Vim

Raw and Vim are the **same CodeMirror 6 editor**; Vim is raw + the `@replit/codemirror-vim` extension + modal cursor ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §4.1). Switching raw↔Vim need not even tear down the view — it can reconfigure the Vim extension on the existing `EditorView` (preferred, since recreating drops state per G4). The five Vim gotchas are *normative*, not optional ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §4.3): order (`vim()` first, G1), render (`drawSelection`, G2), indicator from events (G3), stable view (G4), transactions-not-controlled (G5). G4+G5 are the CM6 form of the **D11** performance contract.

### 4. Disjoint key namespaces, capture-phase handler

App chords occupy `Ctrl+Shift+*` *specifically* so they never collide with Vim normal-mode keys ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §8; [`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §7). The single capture-phase keydown handler at the studio shell recognizes a reserved chord *before* the focused editor sees it ([`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §7.3.1), matches **only** the reserved namespace, `preventDefault`s, and falls everything else through ([`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §7.3.2). This is a precedence **partition**, not a fight. `Ctrl+Shift+P` is the **Preview** mnemonic — the `cmdk` palette is therefore **not** bound to `Ctrl+Shift+P` ([`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §2.1 note); Phase 2 does not need the palette at all.

### 5. Preview sanitizes at render only; the source keeps the author's bytes

Raw HTML is preserved verbatim in the canonical Markdown as `html` nodes ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §4.6); it is sanitized **only** on the HAST at preview render (`allowDangerousHtml` into `remark-rehype`, then `rehype-sanitize`). Stripping or sanitizing at the source would be lossy and would violate **D7**. The sole content-level `<br>` exception (in-cell table breaks) is allowed through sanitization ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §4.1).

### 6. Switch/hydrate updates must not pollute native undo

Phase 2 keeps each engine's native undo (CM6 history; Milkdown/ProseMirror history; Vim `u`/`Ctrl-r`); the branching undo tree is Phase 4. Programmatic content set into an engine during hydrate or switch must not register as a separate user undo step (the bridge sets `addToHistory: false` for ProseMirror; CM6 transactions are dispatched without adding spurious history) ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §4 comment, §5). Undo/redo stay with the focused engine ([`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §7.3.3).

### 7. Bridge protocol primitives, scoped to switching

Phase 2 introduces the bridge-protocol primitives ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §5: origin annotation `bridgeOrigin`, `BRIDGE_META`, the `applying` guard, the version counter) **only as far as switch-on-mode needs them** — i.e. to tag programmatic hydrate/switch transactions so engines don't treat them as human edits. The full bidirectional throttled propagation (§3–§6) and `recreateTransform` raw→rich diffing (§4) are **Phase 3**. Building the primitives now keeps the Phase-3 live bridge a drop-in over the same partition.

### 8. Frontmatter is opaque (verbatim)

`yaml.value` is treated as an opaque string at the canonical-model level — Recto does **not** parse, re-key, re-quote, re-indent, or re-order it ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §4.3). In Phase 2 frontmatter is edited as a raw YAML block (open decision O1 deferred). Corpus case 12 (nested YAML) and assertion 4 (byte-exact `yaml.value`) guard against the "frontmatter collapse" failure ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §4.3).

---

## Libraries introduced

All are battle-tested and already named in the blueprint stack ([`../blueprint/README.md`](../blueprint/README.md) §6); install with bun ([`../plan/README.md`](./README.md) Conventions). Versions are pinned at install; ESM only.

| Package | Used for | Blueprint ref |
|---|---|---|
| `unified` | Pipeline host for parse/serialize/preview | §6, [`06`](../blueprint/06-markdown-dialect.md) §2 |
| `remark-parse` | Markdown string → MDAST (CommonMark) | §6, [`06`](../blueprint/06-markdown-dialect.md) §2.1 |
| `remark-stringify` | MDAST → Markdown string (deterministic, frozen options) | §6, [`06`](../blueprint/06-markdown-dialect.md) §2.2 |
| `remark-gfm` | Tables, task lists, strikethrough, autolinks, **GFM footnotes** (parse **and** serialize) | §6, [`06`](../blueprint/06-markdown-dialect.md) §1.2, §2 |
| `remark-frontmatter` | YAML frontmatter (`["yaml"]`, parse **and** serialize) | §6, [`06`](../blueprint/06-markdown-dialect.md) §1.3, §4.3 |
| `@codemirror/lang-markdown` | Raw/Vim Markdown syntax highlighting | §6, [`04`](../blueprint/04-editor-modes.md) §3.1 |
| `@codemirror/state`, `@codemirror/view` | CM6 core (transactions, `EditorView`, `drawSelection`, `Annotation`) | [`05`](../blueprint/05-lossless-bridge.md) §3, §5; [`04`](../blueprint/04-editor-modes.md) §4.3 |
| `@replit/codemirror-vim` | Vim normal/insert/visual + mode-change events | §6, **D4**, [`04`](../blueprint/04-editor-modes.md) §4 |
| `remark-rehype` | MDAST → HAST for preview (`allowDangerousHtml`) | §6, [`04`](../blueprint/04-editor-modes.md) §5.1; [`06`](../blueprint/06-markdown-dialect.md) §4.6 |
| `rehype-sanitize` | Sanitize HAST at preview render (incl. allowing in-cell `<br>`) | §6, **D5**, [`06`](../blueprint/06-markdown-dialect.md) §4.6 |
| `rehype-stringify` | HAST → HTML string for display | §6, [`04`](../blueprint/04-editor-modes.md) §5.1 |
| Milkdown slash/insert-menu plugin | Rich-text slash palette (17 dialect blocks) | [`04`](../blueprint/04-editor-modes.md) §2.3; [`13`](../blueprint/13-keyboard-commands.md) §5 |

> **Already present from Phase 1 (not re-introduced):** Milkdown + `@milkdown/preset-commonmark` + `@milkdown/preset-gfm` and its remark plugin set (must match this pipeline — [`04`](../blueprint/04-editor-modes.md) §2.1), Next.js, Convex, Better Auth, Tailwind v4, Biome.
>
> **Deferred to Phase 3 (do NOT install now):** `prosemirror-recreate-steps` / `recreateTransform` (live raw→rich diffing — pinned in Phase 0, used by the bridge in [`05`](../blueprint/05-lossless-bridge.md) §4), `react-resizable-panels` (split layout). Phase 2 needs neither for switch-on-mode.

---

## Data-model changes

**None.** Phase 2 introduces **no Convex schema changes** ([`../blueprint/README.md`](../blueprint/README.md) §7). It operates entirely on the existing `documents.markdown` canonical string (read on hydrate, written on debounced persistence — both already present from Phase 1) and on the in-memory MDAST.

- `documents.markdown` remains the persisted canonical serialized Markdown ([`../blueprint/README.md`](../blueprint/README.md) §7, **D1**). Phase 2 only changes that the write path now serializes through the **frozen** `serialize()` so an unedited document does not churn the stored string ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §5).
- **Per-pane mode** (`"rich"|"raw"|"vim"|"preview"`) lives in **client state only** in Phase 2. It is *not* yet persisted to `workspaces.perPaneViewState` — that JSON field, the `workspaces` row, the `paneTree`, and `openDocumentIds` are **Phase 3** ([`../blueprint/README.md`](../blueprint/README.md) §7; out of scope above).
- `docNodes` / `versions` (the append-only DAG and tagged versions) are untouched — **Phase 4**.

---

## Acceptance / exit criteria (testable)

A reviewer can check each of these. Phase 2 is **done** only when **all** pass, in addition to the global Definition of Done ([`../plan/README.md`](./README.md) §Definition of Done).

**Losslessness (the core promise):**

- [x] A document containing **GFM tables + footnotes + YAML frontmatter** survives **rich → raw → rich byte-stable** (the persisted/serialized Markdown is byte-identical after the round-trip, within the dialect; YAML body verbatim). *(Exit criterion; ties to corpus cases 7–12 and assertions 2–4.)*
- [x] A document survives **raw → rich → raw** byte-stable for the same content.
- [x] Re-saving an unedited document produces **no byte change** to `documents.markdown` (no spurious diff, no sync write) ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §5).

**The round-trip corpus (the phase gate):**

- [x] **All 25 corpus cases** of [`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §6 pass **all five assertions** (idempotence; round-trip equality; second-pass stability; frontmatter `yaml.value` byte-exact; cross-surface Milkdown↔CM6 convergence) under `bun run test`.
- [x] The corpus runs as **property/automated tests**, not manual spot checks, and is wired into `bun run test`.

**Modes & switching:**

- [x] **All four modes** (Rich text, Raw Markdown, Vim, Preview) render and switch **instantly** (no perceptible latency; mode switch feels instant per principle 4).
- [x] `⌘K` / `Ctrl+K` opens a command palette to switch modes; `Alt+1–4` jumps directly to rich/raw/vim/preview without conflicting with OS or editor shortcuts.
- [x] A switch preserves **content** (byte-stable) and the **caret/selection** where the projection allows ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §6.3).
- [x] Preview is **read-only** (no cursor, toolbar, or slash) and renders **sanitized** HTML; a `<script>` in source does **not** execute in preview, but the `<script>` text **survives verbatim in the source** ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §4.6; corpus case 24).

**Vim:**

- [x] Vim **normal / insert / visual** all work; visual-mode selection is **visible** (G2 `drawSelection`).
- [x] The per-pane indicator shows the correct **`Vim · normal|insert|visual`** sub-mode, driven by mode-change events (G3), updating synchronously.
- [x] `vim()` precedes other CM6 keymaps (G1); the `EditorView` is **not** recreated per render (G4 — Vim state survives re-renders); external updates apply as **transactions** (G5 — cursor/Vim state preserved).
- [x] In a Vim pane, `u`/`Ctrl-r` drive undo/redo and `Esc` returns to normal (does **not** switch app mode) ([`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §6.2–§6.3).

**Mode indicator:**

- [x] Every pane shows an **always-visible** indicator with the current mode name (and Vim sub-mode), styled as quiet chrome ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §7).

**Slash palette (Rich text only):**

- [x] Typing `/` at the start of an empty block (or after whitespace) opens the inline palette; it exists **only** in Rich text mode.
- [x] `↑/↓` move, `Enter` inserts (removing the `/` query), `Esc` closes (leaving literal `/query`), `Tab` continues, typing filters (fuzzy over labels + aliases) — **fully keyboard-navigable, no mouse**.
- [x] All **17** slash entries ([`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §5.1) insert their dialect block into the canonical MDAST; the inserted construct serializes to the expected Markdown.

**Dialect coverage:**

- [x] GFM **tables** (with alignment + escaped pipes), **task lists**, **strikethrough**, **autolinks**, **footnotes**, and **YAML frontmatter** are authorable/editable in every applicable mode and round-trip.

**Build hygiene (global DoD):**

- [x] `bun run typecheck` passes with no errors (TypeScript strict, ESM).
- [x] `bun run biome check` passes with no errors.
- [x] No data-loss regression: refresh / navigate away / switch device does not lose content (Phase 1 promise still holds with the new modes).

---

## Risks & mitigations

| # | Risk | Likelihood / impact | Mitigation | Fallback |
|---|---|---|---|---|
| R1 | **Footnotes / tables don't round-trip** (the classic lossy spots). | Med / high — this is a named blueprint risk ([`../plan/README.md`](./README.md) risk register). | remark-native AST + explicit per-construct serialize rules ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §4.1–§4.2); the corpus is the gate (cases 7–11). | Narrow the dialect *documentably* ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §1.4, §8); **never silently drop** content. |
| R2 | **Milkdown's serializer disagrees with the canonical pipeline** at the byte level (rich emits a construct or form CM6/`remark-stringify` produce differently). | Med / high — breaks losslessness at the seam ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §2.1). | Cross-surface convergence assertion (corpus §6 assertion 5) compares Milkdown↔CM6 bytes; treat "serializer has no handler for node X" as a build/test failure, not a runtime fallback ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §7). | Constrain Milkdown's schema to the dialect (no rich-only nodes); degrade out-of-dialect paste to text ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §7). |
| R3 | **Frontmatter collapse** — `remark-frontmatter` not attached to *both* parser and serializer → leading `---` parsed as `thematicBreak`, YAML destroyed. | Low / high. | `.use(remarkFrontmatter, ["yaml"])` mandatory in **both** configs (WS-1.1, WS-1.3); corpus case 12 + assertion 4 guard it ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §4.3). | — (treat as a build failure). |
| R4 | **Hard/soft break drift** — soft break collapses to a space, or hard break lost (the prosemirror-markdown trap). | Med / med. | Pin hard breaks to backslash-newline in `CANONICAL_STRINGIFY`; serialize via `remark-stringify`, **not** prosemirror-markdown's serializer; preserve soft breaks as newlines ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §4.5). Corpus cases 13–14. | — (corpus-gated). |
| R5 | **Vim integration regressions** (G1–G5): keys swallowed, invisible visual selection, lost Vim state on re-render, cursor clobbered. | Med / med. | Implement and test each gotcha explicitly (WS-3.2–WS-3.6); indicator driven by events (G3). | Document any unsupported Vim feature; do not ship a jank Vim mode. |
| R6 | **Switch handoff loses caret or content** (pending throttle not flushed; mounting from old engine instead of the model). | Low / high. | `switchPaneMode` flushes throttles synchronously, mounts from the canonical model, maps caret to model space ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §8.2); content covered by the round-trip exit criteria. | — (switch is the simplest case of the bridge; if it janks, the live bridge can't ship either — escalate to Phase 0 decision). |
| R7 | **Programmatic hydrate/switch pollutes undo or echoes as a human edit.** | Low / med. | Tag programmatic transactions (origin annotation / `BRIDGE_META`), set `addToHistory:false` for PM; CM6 transactions dispatched without spurious history ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §4–§5). | — |
| R8 | **App chord collides with a Vim key or browser default.** | Low / med. | `Ctrl+Shift+*` namespace is disjoint from Vim normal-mode keys ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §8); single capture-phase handler intercepts only the reserved namespace ([`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §7.3.2). | — (partition, not a fight). |
| R9 | **Preview becomes an injection surface** via raw/pasted HTML. | Low / high. | `rehype-sanitize` on the HAST is non-negotiable; source bytes kept, sanitize only at render ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §5.1; [`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) §4.6). Corpus case 24. | — |
| R10 | **Scope creep into Phase 3/4/5** (building the live two-pane bridge, splits, palette, export). | Med / med. | Honor the Out-of-scope list; build only switch-on-mode + bridge-protocol primitives ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §5) scoped to switching. | — |

---

## References

**Blueprint (canon — read alongside this file):**

- [`../blueprint/README.md`](../blueprint/README.md) — locked decisions **D1–D15**, stack (§6), Convex schema (§7), dialect summary (§8), the three hard parts (§9), glossary (§11).
- [`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) — the four modes, Milkdown/CM6/preview engines, the slash palette behavior (§2.3), the Vim gotchas G1–G5 (§4.3), mode switching (§6), the per-pane mode indicator (§7), the `Ctrl+Shift+*` rationale (§8).
- [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) — the canonical bus (§2), `CANONICAL_STRINGIFY` (§2.1), feedback-loop guards (§5), throttling (§6), cursor preservation (§7), **mode switch vs live sync (§8.2 — the switch-on-mode this phase builds)**, lossless guarantees (§9), known degradation cases (§10), test strategy (§11), the Phase-0-decided fallback (§12).
- [`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) — the supported feature set (§1), the unified pipeline + frozen `remark-stringify` options (§2), normalization (§3), per-construct serialize notes (§4), the round-trip contract (§5), **the round-trip corpus — the Phase 2 gate (§6)**, how the rich editor is constrained to the dialect (§7), open decisions (§8).
- [`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) — mode-switch chords + cycle ring (§2.1), the two keyboard surfaces (§3), the slash command list (§5.1) and its navigation (§5.2), Vim interplay (§6), conflict resolution + the capture-phase handler (§7).

**Plan:**

- [`../plan/README.md`](./README.md) — phase map, Definition of Done, conventions (bun, scripts, commits), the carried risk register.

**External (from the blueprint's external references):**

- remark-gfm (tables, task lists, strikethrough, autolinks, footnotes): <https://github.com/remarkjs/remark-gfm>
- remark-frontmatter (YAML frontmatter): <https://github.com/remarkjs/remark-frontmatter>
- remark-stringify (deterministic serialization + options): <https://github.com/remarkjs/remark/tree/main/packages/remark-stringify>
- GitHub Flavored Markdown spec: <https://github.github.com/gfm/>
- `@replit/codemirror-vim` (maintained CM6 Vim, normal/insert/visual): <https://github.com/replit/codemirror-vim>
- TipTap issue #7147 (markdown round-trip drift — the failure Recto avoids structurally): <https://github.com/ueberdosis/tiptap/issues/7147>
- Quarto visual editor "canonical Markdown" (visual + source edits produce identical output): <https://quarto.org/docs/visual-editor/markdown.html>
