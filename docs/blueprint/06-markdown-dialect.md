# 06 — Markdown Dialect (the losslessness contract)

> **Scope.** This file is the canonical, self-contained specification of the exact Markdown dialect Recto supports, the `unified` parse/serialize pipeline that backs it, the normalization rules that make rich-edited and raw-edited text converge, the per-construct serialization notes for the lossy-prone constructs, the formal round-trip contract, and the Phase 2 round-trip test corpus that gates the dialect.
>
> This file **expands [`README.md`](./README.md) §8 (Markdown dialect)** in full and never contradicts the locked decisions **D1–D15**. Where this file and the blueprint `README.md` ever disagree, the `README.md` wins — open an issue and reconcile.
>
> **Siblings to read alongside this file:** [`05-lossless-bridge.md`](./05-lossless-bridge.md) (the live two-mode sync that depends on deterministic serialization), [`04-editor-modes.md`](./04-editor-modes.md) (how each lens edits the canonical model), and the execution companion [`../plan/phase-2-modes-and-losslessness.md`](../plan/phase-2-modes-and-losslessness.md) (where this dialect and its corpus are built and gated).

---

## 0. Where this fits in the canon

The single architectural rule (blueprint `README.md` §2, **D2**) is: **there is one canonical document, and every mode is a view of it.** The canonical document model is a **remark MDAST** held in memory, persisted to Convex as a **Markdown string** (**D1**). The dialect (**D7**) is the precise grammar of that Markdown string and of the MDAST it parses to.

Two distinct surfaces must produce **byte-identical** Markdown for the same logical document:

- **Milkdown** (rich text, **D3**) — its ProseMirror document *is* a remark MDAST; serializing the rich doc is serializing the canonical tree.
- **CodeMirror 6** (raw + Vim, **D4**) — edits the serialized Markdown string directly.

If these two surfaces could disagree on the byte-level form of the same document, then a mode switch or the live bridge ([`05-lossless-bridge.md`](./05-lossless-bridge.md)) would manufacture spurious diffs, jump the cursor, or — worst — drop content. **The losslessness contract exists to forbid that.** It has two halves:

1. **A bounded feature set** (§1): the dialect is closed. No mode may emit a construct outside it.
2. **A single deterministic serializer** (§2–§3): one and only one byte-form per MDAST.

Product principle 3 (blueprint `README.md` §4) states it plainly: *"Lossless or it doesn't ship. A document that round-trips rich → raw → rich must come back byte-stable within the supported dialect."*

---

## 1. The supported feature set (per D7)

The dialect is **CommonMark + GFM + footnotes + YAML frontmatter**, and nothing else. The table below enumerates every supported construct, its Markdown syntax, the MDAST node type it parses to (from the [mdast](https://github.com/syntax-tree/mdast) spec used by `remark`), and notes. **A construct that is not in this table is not in the dialect** (see §7 for how the rich editor is constrained, and §1.4 for what is explicitly excluded).

### 1.1 CommonMark

| Construct | Markdown syntax | MDAST node type | Notes |
|---|---|---|---|
| Heading H1–H6 | `# … ###### …` | `heading` (`depth: 1–6`) | ATX only after normalization; Setext (`===` / `---` underline) is parsed but **re-serialized as ATX** (see §2, `setext: false`). |
| Paragraph | plain text block | `paragraph` | Container of `phrasingContent`. |
| Bold / strong | `**text**` → `__text__` parsed, `**text**` emitted | `strong` | Emitted with `*` (see §2, `strong: '*'`). |
| Italic / emphasis | `_text_` (emitted) / `*text*` (parsed) | `emphasis` | Emitted with `_` (see §2, `emphasis: '_'`). |
| Inline code | `` `code` `` | `inlineCode` | Backtick count auto-grows if the content contains backticks. |
| Link | `[label](url "title")` | `link` (`url`, optional `title`) | Title preserved verbatim; quote char normalized to `"`. |
| Image | `![alt](url "title")` | `image` (`url`, `alt`, optional `title`) | Same title rules as links. |
| Blockquote | `> text` | `blockquote` | Nests; each level adds one `> ` prefix (see §4.7). |
| Unordered list | `- item` | `list` (`ordered: false`) + `listItem` | Bullet normalized to `-` (see §2, `bullet: '-'`). |
| Ordered list | `1. item` | `list` (`ordered: true`, `start`) | Marker normalized; renumbering controlled by `incrementListMarker`. |
| Nested list | indented sub-list | nested `list` in `listItem` | Indent normalized to one space after marker (`listItemIndent: 'one'`). |
| Fenced code block | ```` ```lang … ``` ```` | `code` (`lang`, `meta`, `value`) | Always fenced, never indented (`fences: true`). Fence char `` ` `` (see §2). |
| Thematic break / divider | `---` | `thematicBreak` | Rule normalized to `---` (`rule: '-'`, three repetitions). |
| Hard line break | `\␣␣` (backslash) or two trailing spaces | `break` | Emitted as backslash-newline; see §4.5 — this is the silent-loss hotspot. |
| Soft line break | single newline inside a paragraph | (newline between phrasing nodes) | Preserved as a newline; **never collapsed to a space** — see §4.5. |

### 1.2 GFM (via `remark-gfm`)

| Construct | Markdown syntax | MDAST node type | Notes |
|---|---|---|---|
| Table | `\| a \| b \|` + `\| --- \| :-: \|` | `table` (`align[]`) + `tableRow` + `tableCell` | Alignment array preserved; pipes in cells escaped; cells re-padded deterministically — see §4.1. |
| Task list item | `- [ ] todo` / `- [x] done` | `listItem` (`checked: false \| true`) | A `listItem` with a non-null `checked` is a task item. |
| Strikethrough | `~~text~~` | `delete` | GFM tilde syntax; emitted as `~~…~~`. |
| Autolink | `<https://example.com>` and bare `https://example.com` | `link` | GFM literal autolinks (bare URLs) and angle autolinks both parse to `link`; see §4.8. |

### 1.3 Extensions

| Construct | Markdown syntax | MDAST node type | Notes |
|---|---|---|---|
| Footnote reference | `text[^id]` | `footnoteReference` (`identifier`, `label`) | Inline; points at a definition by `identifier` — see §4.2. |
| Footnote definition | `[^id]: definition text` | `footnoteDefinition` (`identifier`, `label`, children) | Block; can contain multiple block children. Ordering on serialize is defined in §4.2. |
| YAML frontmatter | `---\n…\n---` at document head | `yaml` (`value`) | Parsed by `remark-frontmatter`; **the `value` is the raw YAML string and must survive verbatim** — see §4.3. |

> Footnotes and frontmatter are **enabled by explicit plugins** (`remark-gfm` provides GFM footnotes; `remark-frontmatter` provides YAML). They are not in plain CommonMark and would be invisible to a bare `remark-parse`. See §2.

### 1.4 Explicitly excluded (out of dialect)

These are **not** supported and the rich editor must not be able to emit them (§7). If they appear in pasted/raw text, they are handled per the inline-HTML policy (§4.6) or degrade to plain text — never silently corrupted, never crashing the parser.

| Excluded | Why |
|---|---|
| Definition lists | Not CommonMark/GFM; no portable Markdown form. |
| Block-level raw HTML as structured content | Out of dialect; preserved verbatim as `html` text nodes, sanitized only at preview (§4.6). |
| Math (`$…$`, `$$…$$`) | Not in D7; would require `remark-math` — a scope change, not a tweak. |
| Wikilinks / `[[…]]` | Not in D7. |
| Directives / custom containers (`:::`) | Not in D7. |
| Front-matter formats other than YAML (TOML `+++`, JSON) | D7 specifies YAML only; `remark-frontmatter` is configured for `['yaml']`. |
| Setext headings (as output) | Parsed for tolerance, **never emitted** (normalized to ATX). |

---

## 2. The unified pipeline (parse + serialize)

There is exactly **one** parser configuration and **one** serializer configuration in the whole app. They are created once and shared by every mode (rich, raw, vim, preview) and by the bridge. Two configs would reintroduce drift.

### 2.1 Parse: Markdown string → MDAST

```ts
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";

// Markdown string -> MDAST (canonical in-memory tree, per D1)
const parser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ["yaml"]);

export function parse(md: string) {
  return parser.parse(md); // returns an mdast `root`
}
```

- `remarkParse` → CommonMark.
- `remarkGfm` → tables, task lists, strikethrough, autolinks, **and GFM footnotes**. (See https://github.com/remarkjs/remark-gfm.)
- `remarkFrontmatter` with `["yaml"]` → recognizes the leading `---` … `---` block as a `yaml` node instead of a thematic break + paragraph. (See https://github.com/remarkjs/remark-frontmatter.) Without this plugin, frontmatter is **misparsed** — the opening `---` becomes a `thematicBreak` and the metadata becomes a paragraph; this is exactly the "frontmatter collapse" failure called out in §4.3.

> **Plugin order matters for nothing functional here** (these three are independent micro-syntax extensions), but we fix the order above as the canonical order so the config reads identically everywhere.

### 2.2 Serialize: MDAST → Markdown string (deterministic)

```ts
import remarkStringify from "remark-stringify";

// Shared serializer. The options below are load-bearing: they pin
// exactly ONE byte-form per MDAST. Do not change without re-running
// the full round-trip corpus (§6).
const serializer = unified()
  .use(remarkStringify, {
    bullet: "-",            // unordered list marker: always "-"
    emphasis: "_",          // *emphasis* -> _emphasis_
    strong: "*",            // strong delimiter: "**"
    fences: true,           // ALWAYS fence code blocks; never indent
    fence: "`",             // fenced code uses backticks
    listItemIndent: "one",  // one space between marker and content
    rule: "-",              // thematic break uses "-"  => "---"
    ruleRepetition: 3,      // exactly three -> "---"
    ruleSpaces: false,      // no spaces between rule chars
    setext: false,          // ATX headings ("# H1"), never Setext underline
    incrementListMarker: true, // ordered lists count 1. 2. 3.
    tightDefinitions: true, // no blank line between adjacent definitions
    resourceLink: true,     // links as [text](url), not autolink shorthand, where ambiguous
  })
  .use(remarkGfm)           // table/strikethrough/task/footnote serializers
  .use(remarkFrontmatter, ["yaml"]); // yaml node -> --- ... --- block

export function serialize(tree: import("mdast").Root): string {
  return serializer.stringify(tree);
}
```

> `remark-gfm` and `remark-frontmatter` must be attached to the **serializer** too, not just the parser. They register the to-markdown handlers for `table`, `delete`, `footnoteReference`, `footnoteDefinition`, task-list `checked`, and `yaml`. Without them, those node types either throw on stringify or fall back to escaped text — a silent loss. (Serializer reference: https://github.com/remarkjs/remark/tree/main/packages/remark-stringify ; GFM target spec: https://github.github.com/gfm/.)

### 2.3 The fixed `remark-stringify` options, justified

| Option | Value | Why this exact value |
|---|---|---|
| `bullet` | `'-'` | One bullet char everywhere. (Milkdown might prefer `-`, a hand-typed doc might use `*` or `+`; normalization forces `-`.) |
| `emphasis` | `'_'` | Single emphasis delimiter. `*foo*` and `_foo_` are semantically identical → pick one. |
| `strong` | `'*'` | Strong becomes `**`. Distinct delimiter from emphasis avoids `___`/`***` adjacency ambiguity. |
| `fences` | `true` | Code blocks are **always** fenced. Indented code blocks are forbidden output — they're whitespace-fragile and indistinguishable from list-nested code. |
| `fence` | `` '`' `` | Backtick fences. Backtick count auto-grows if content contains backticks. |
| `listItemIndent` | `'one'` | Exactly one space after the marker (`- x`, not `-   x`). Stable nested-list indentation (§4.4). |
| `rule` | `'-'` | Thematic break char. |
| `ruleRepetition` | `3` | `---` (three), not a variable run. |
| `ruleSpaces` | `false` | `---`, not `- - -`. |
| `setext` | `false` | ATX headings only (`## H2`), so heading depth never depends on a following underline line — Setext can't express H3–H6 anyway. |
| `incrementListMarker` | `true` | Ordered lists serialize as `1.` `2.` `3.`; deterministic and human-readable. |
| `tightDefinitions` | `true` | No blank line inserted between adjacent link/footnote definitions. |
| `resourceLink` | `true` | Prefer explicit `[text](url)` form where an autolink/shortcut would otherwise be chosen, avoiding form ambiguity. |

**Escape policy.** `remark-stringify` escapes the minimal set of characters needed so that re-parsing yields the same tree (e.g. a literal leading `#` in a paragraph, a literal `|` inside a table cell (§4.1), a literal `*`/`_` that would otherwise start emphasis). We **rely on remark's built-in, parse-aware escaping** and do **not** add a custom escape pass — custom escaping is the classic source of double-escaping (`\\|`) drift. The rule: *the only acceptable escapes are the ones remark inserts to preserve the tree.* This is verified by the round-trip corpus (§6): if an escape changed meaning, `serialize(parse(serialize(tree)))` would differ from `serialize(tree)`.

### 2.4 Why determinism matters

Determinism is not an aesthetic preference; it is the precondition for two core promises:

1. **The bridge** ([`05-lossless-bridge.md`](./05-lossless-bridge.md)). When the rich editor changes, the bridge serializes its MDAST and diffs against the raw editor's text to compute a minimal CodeMirror change set (and vice-versa, parsing raw text and diffing the tree into ProseMirror via `prosemirror-recreate-steps`). **If serialization were non-deterministic, every keystroke on one side would produce a phantom whole-document diff on the other** — the cursor would jump, selections would collapse, and the throttled diff loop could oscillate. Deterministic output means: *no logical change ⇒ no byte change ⇒ no diff ⇒ no cursor disturbance.*

2. **The round-trip contract** (§5). `serialize(parse(md)) === normalize(md)` is only a meaningful, testable invariant if `serialize` is a pure function of the tree. Non-determinism (e.g. random marker choice, timestamp, locale-dependent ordering) would make the property test flaky and the byte-stability promise false.

> Practical consequence for implementers: never introduce a code path that stringifies with a different option set "just for export" or "just for preview". Export (`11-clipboard-export.md` territory) and preview both start from the **same** canonical MDAST; preview uses `remark-rehype` → HTML and does not re-serialize Markdown at all.

---

## 3. Normalization — what canonical output always looks like

`normalize` is **defined as a function**, not a vibe:

```ts
// normalize(md) = serialize(parse(md))
export const normalize = (md: string): string => serialize(parse(md));
```

`normalize` is **idempotent**: `normalize(normalize(md)) === normalize(md)`. (If it weren't, the serializer options in §2.3 would be wrong; this is itself a corpus assertion — §6.)

Because both editing surfaces emit through the **same** serializer, a document that was authored in rich text and a document that was hand-typed in raw Markdown **converge to the same bytes** once normalized. The visible, guaranteed shape of canonical output:

| Aspect | Canonical form |
|---|---|
| Headings | ATX: `# H1` … `###### H6`; one space after `#`; no trailing `#`. |
| Emphasis / strong | `_emphasis_`, `**strong**`. |
| Unordered lists | `- ` markers; one space after marker. |
| Ordered lists | `1.` `2.` `3.`, incrementing; one space after marker. |
| Nested lists | child indented to align under parent content (one-space item indent → predictable 2/3-space steps). |
| Task items | `- [ ] ` / `- [x] ` (lowercase `x`). |
| Code blocks | fenced with ```` ``` ````; language tag preserved; fence grown past inner backticks. |
| Thematic break | `---` on its own line. |
| Blockquote | `> ` prefix per nesting level. |
| Tables | leading/trailing `|`; cells padded to the column width; delimiter row reflects `align`. |
| Links / images | `[text](url)` / `![alt](url)`; titles in `"…"`. |
| Strikethrough | `~~text~~`. |
| Footnote definitions | collected at end of document in first-reference order (§4.2). |
| Frontmatter | `---` fenced YAML at the very top, raw `value` byte-preserved (§4.3). |
| Block separation | exactly one blank line between sibling block nodes. |
| Trailing newline | the document ends with a single `\n`. |
| Hard break | backslash + newline (`\␣\n` is normalized to `\\\n`). |

This convergence is the whole point: a user can switch a paragraph between rich and raw all day and the persisted `documents.markdown` string (blueprint `README.md` §7) does not churn.

---

## 4. Per-construct serialize/parse notes (the lossy-prone constructs)

The constructs below are where naive Markdown tooling loses data. Each gets explicit rules.

### 4.1 Tables (GFM)

MDAST shape: `table { align: Array<'left'|'right'|'center'|null>, children: tableRow[] }`, each `tableRow` has `tableCell[]`, each `tableCell` holds phrasing content.

Rules:

- **Alignment is carried on `table.align`**, one entry per column. The delimiter row encodes it: `:---` left, `---:` right, `:---:` center, `---` none (`null`). `remark-gfm` reads and writes this faithfully — **do not reconstruct alignment from cell padding.**
- **Pipes inside cells are escaped** as `\|`. A literal `|` in cell text must never be emitted unescaped (it would split the cell). remark's table serializer does this; we rely on it (no custom escaping — §2.3).
- **Cells are padded** to the column's maximum content width on serialize, producing aligned, diff-stable tables. Because padding is a deterministic function of content widths, two trees with the same cell contents pad identically.
- **Line breaks inside a cell**: GFM tables cannot contain a literal newline in a cell. A hard break inside a cell is represented as the literal text `<br>` (an inline `html` node). Preview renders it as a break; the bridge treats it as content (sanitized at render, §4.6). This is the only sanctioned `<br>` in the dialect, and it is **content**, not a `break` node.

Example (input with ragged spacing and a literal pipe) and its normalized output:

```md
| Name | Role | Note |
|:-|-:|:-:|
| Ada | Eng | a \| b |
| Bo | PM | x |
```

normalizes to (cells padded, alignment preserved, pipe still escaped):

```md
| Name | Role | Note  |
| :--- | ---: | :---: |
| Ada  |  Eng | a \| b |
| Bo   |   PM |   x   |
```

### 4.2 Footnotes

MDAST shapes: inline `footnoteReference { identifier, label }`; block `footnoteDefinition { identifier, label, children }`.

Rules:

- **Pairing is by `identifier`**, not by position. `text[^a]` references the `footnoteDefinition` whose `identifier` is `a`. The visible `label` (what the user typed after `^`) is preserved separately from the normalized `identifier`.
- **Definitions are serialized as a block at the end of the document**, regardless of where the user wrote them in raw mode. This is GFM/remark behavior and is deterministic.
- **Ordering of definitions on serialize follows first-reference order** in the document (the order references first appear), which is stable for a given tree. A definition that is never referenced is still preserved (orphan definitions are not dropped) and ordered after all referenced ones.
- **A reference with no matching definition** is preserved as a `footnoteReference` (it round-trips as `[^id]` text); it is not invented or deleted. Preview renders an unresolved marker rather than crashing.

Example:

```md
A claim.[^src] Another.[^note]

[^src]: Smith 2019.
[^note]: See appendix.
```

The two references and two definitions pair by `src` / `note`; definitions emit at the end in first-reference order (`src`, then `note`).

### 4.3 YAML frontmatter — must survive verbatim

MDAST shape: `yaml { value: string }` where `value` is the **raw text between the fences**, with the surrounding `---` lines stripped by the parser.

Rules — **this is the single highest frontmatter risk and the rule is strict:**

- **Recto does not parse, re-key, re-quote, re-indent, or re-order the YAML.** The `yaml.value` is treated as an **opaque string** at the canonical-model level. On serialize, `remark-frontmatter` wraps the exact `value` back in `---` … `---`. Round-trip is therefore byte-exact *for the YAML body* by construction, because we never touch its internals.
- **The frontmatter collapse failure mode:** if `remark-frontmatter` is *not* attached (or not configured for `['yaml']`), the leading `---` is parsed as a `thematicBreak`, the YAML lines as a `paragraph`, and the closing `---` as another `thematicBreak`. Serializing that tree produces a divider, a mangled paragraph (YAML colons/indentation Markdown-escaped), and another divider — **the metadata block is destroyed.** This is why `.use(remarkFrontmatter, ['yaml'])` is mandatory in **both** the parser and serializer (§2). The corpus (§6) includes a nested-YAML frontmatter case specifically to catch a regression here.
- **Only the leading block is frontmatter.** A `---` that is not at the very top of the document is a `thematicBreak`, not frontmatter — `remark-frontmatter` only treats the document-leading fence as `yaml`.
- **Editing UX (open decision):** in v1 the frontmatter block is edited **as a raw text block** (the YAML is shown and edited literally; we do not introduce a structured metadata panel). A structured panel that reads/writes individual keys is a **later option** and is flagged as an open decision in §8. Even a future panel must round-trip through `yaml.value` and must not reformat untouched keys.

Example — nested YAML survives byte-for-byte:

```md
---
title: Untitled
tags:
  - draft
  - longform
meta:
  author: B. Khumalo
  revised: 2026-06-15
---

# Body starts here
```

### 4.4 Nested lists (indent + marker consistency)

MDAST shape: `list` → `listItem` → (`paragraph` | nested `list`).

Rules:

- **Markers are consistent**: every unordered item is `- ` (`bullet: '-'`); ordered items are `1.` `2.` … (`incrementListMarker: true`).
- **Indentation is `listItemIndent: 'one'`**: one space between marker and content, so child blocks indent to a predictable column (under the first content character of the parent item). This avoids the wandering 2-vs-4-space indentation that makes hand-edited nested lists diff noisily.
- **Loose vs tight lists** are determined by the tree (presence of blank lines between items in the source becomes `spread: true` on the `list`/`listItem`), and serialized consistently. The corpus checks both.
- **Mixed nesting** (ordered inside unordered and vice-versa, and task items nested under regular items) is supported and must round-trip.

Example normalized nested list:

```md
- Top
  - Child
    1. Deep ordered
    2. Second
  - [ ] Nested task
- Sibling
```

### 4.5 Hard vs soft line breaks — the silent-loss hotspot

This is the most notorious lossy spot in rich↔Markdown bridges and gets the most explicit handling.

- **Soft break** = a single newline inside a paragraph. In CommonMark it renders as a space (or a line break, per renderer), but **at the source/MDAST level it is a newline between phrasing nodes** and we **preserve it as a newline on serialize**. We do **not** collapse soft breaks to spaces.
- **Hard break** = `break` node, written by the author as a trailing backslash (`\`) or two trailing spaces. We **serialize hard breaks as backslash-newline (`\` then `\n`)** — the trailing-spaces form is normalized to the backslash form because trailing spaces are invisible and get stripped by editors and formatters (a classic silent loss). Backslash hard breaks are visible and stable.
- **The prosemirror-markdown trap:** historically, `prosemirror-markdown` (the serializer family ProseMirror-based editors descend from) treated a soft line break by emitting a **single space**, silently destroying intentional in-paragraph newlines on a rich→Markdown round-trip. Recto avoids this in two ways: (1) Milkdown is **remark-MDAST-backed** (**D3**), so soft breaks live in the tree as newlines, and (2) we serialize with `remark-stringify` (§2), not with `prosemirror-markdown`'s serializer. The corpus (§6) includes a soft-break case and a hard-break case explicitly to lock this behavior and detect any regression toward space-collapsing.

Example:

```md
Line one with a soft break
still the same paragraph.

Line A with a hard break\
Line B in the same paragraph.
```

### 4.6 Inline (and raw) HTML policy

MDAST shape: `html { value }` for raw HTML spans/blocks.

Decision:

- **Raw HTML is preserved verbatim in the canonical Markdown** as `html` nodes (it round-trips as the exact text the author wrote). We do **not** strip it from the document and do **not** rewrite it.
- **HTML is sanitized only at preview render time**, never in the stored document. The preview path (**D5**) is MDAST → `remark-rehype` (with `allowDangerousHtml` so the raw HTML reaches rehype) → **`rehype-sanitize`** → `rehype-stringify`. Sanitization happens on the HAST, so dangerous tags/attributes (`<script>`, `on*=`, `javascript:` URLs, etc.) are removed **from the rendered view only**. The Markdown source keeps the author's bytes.
- **Rationale:** stripping HTML at the source would be lossy (violates D7's contract); sanitizing at the source would also be lossy and surprising (the author's text would change under them). Sanitizing only at render keeps the document honest *and* the preview safe. This matches the stack table in blueprint `README.md` §6 (`remark-rehype`, `rehype-sanitize`, `rehype-stringify`).
- **The one exception that is content, not HTML structure:** `<br>` inside a table cell (§4.1) is the sanctioned in-cell break representation and is allowed through sanitization.
- **The rich editor does not author arbitrary HTML** (§7). Raw HTML enters only via the raw/Vim editors or paste; it is preserved and only ever sanitized at preview.

### 4.7 Blockquotes (nesting)

`blockquote` nests; each nesting level prepends one `> `. A nested quote is `> > `. Blank lines within a quote are preserved as `>` lines so the quote stays one block. The corpus checks a two-level nested blockquote.

### 4.8 Links, images, and autolinks

- **Titles** (`[t](u "title")`, `![a](u "title")`) are preserved; the title quote is normalized to `"`.
- **Autolinks**: angle autolinks (`<https://example.com>`) and GFM literal/bare autolinks (`https://example.com` typed inline) both parse to `link`. With `resourceLink: true` and remark-gfm's serializer, a bare URL that GFM recognizes as an autolink is preserved as a literal autolink; an explicitly-titled or labeled link stays in resource form. The corpus pins one of each so the chosen form is locked.
- **Reference-style links/definitions** (`[t][id]` + `[id]: url`) are parsed to `link` + `definition`; `tightDefinitions: true` keeps definitions compact. (Reference links collapse to inline resource links only if the tree no longer carries a `definition` — we do not rewrite author-chosen reference links into inline ones.)

---

## 5. The round-trip contract

> **The contract.** For every document expressible in the supported dialect (§1):
>
> ```ts
> serialize(parse(md)) === normalize(md)
> ```
>
> where `normalize(md) := serialize(parse(md))` (§3). Equivalently, **`normalize` is idempotent** and **`parse`/`serialize` round-trips the tree**:
>
> ```ts
> normalize(normalize(md)) === normalize(md)               // idempotence
> serialize(parse(serialize(tree))) === serialize(tree)    // tree-level stability
> ```

What the contract guarantees, in product terms (blueprint `README.md` §4, principle 3):

- Edit a document in **rich** text, switch to **raw**, switch back to **rich** → the bytes are stable. (Both sides go through the same serializer; §2.)
- Hand-edit raw Markdown, then open it in **rich** → no content is lost or reshaped beyond normalization.
- Re-saving an unedited document does **not** churn `documents.markdown` (no spurious diff, no undo-tree noise, no sync write — see [`05-lossless-bridge.md`](./05-lossless-bridge.md) and `10-sync-persistence.md`).

What it does **not** promise: that *cosmetic* input (a `*` bullet, a Setext heading, ragged table spacing, trailing-space hard breaks) survives **verbatim**. Those are normalized to the canonical form (§3). The contract is **byte-stability of the canonical form**, which is what "lossless within the supported dialect" means. The one place we promise *verbatim* survival is **YAML frontmatter body** (§4.3) — and we achieve it by never touching the YAML internals.

Anything that would violate the contract is, by definition, **out of dialect** and is the rich editor's responsibility not to produce (§7) and the parser's responsibility to degrade gracefully (preserve as text, never crash).

---

## 6. The round-trip test corpus (Phase 2 gate)

This corpus is **the Phase 2 gate** — see [`../plan/phase-2-modes-and-losslessness.md`](../plan/phase-2-modes-and-losslessness.md) and the blueprint risk register (`README.md` §9.3, plan risk register row "Footnotes / tables don't round-trip"). Phase 2 is **not done** until every case below passes the assertions, and these are **property tests**, not optional (plan `README.md` "Testing").

**Assertions applied to every case (`md`):**

1. `normalize(md) === normalize(normalize(md))` — idempotence.
2. `serialize(parse(md)) === normalize(md)` — round-trip equality.
3. `serialize(parse(serialize(parse(md)))) === serialize(parse(md))` — second-pass stability (catches escape oscillation, table re-padding drift).
4. For frontmatter cases: the `yaml.value` substring of the output equals the `yaml.value` of the input **byte-for-byte** (§4.3 verbatim guarantee).
5. For the bridge: feeding the normalized form to both Milkdown (parse → ProseMirror) and CodeMirror (raw) and re-serializing yields the **same** bytes from both surfaces (cross-surface convergence; ties this file to [`05-lossless-bridge.md`](./05-lossless-bridge.md)).

**The explicit checklist of cases** (each is a distinct corpus fixture):

| # | Case | What it locks |
|---|---|---|
| 1 | Each heading level H1–H6 (ATX) | depth preserved; no Setext leakage; one space after `#`. |
| 2 | Heading written as Setext (`Title\n=====`) | normalized to ATX (`# Title`). |
| 3 | Nested **unordered** list (3 levels) | `-` markers; one-space indent stability. |
| 4 | Nested **ordered** list (with restart `start`) | `incrementListMarker`; `start` preserved. |
| 5 | Mixed nesting: ordered-in-unordered and vice-versa | marker + indent consistency across kinds. |
| 6 | **Task list** (checked + unchecked, nested under a regular item) | `checked` boolean; `- [ ]`/`- [x]`. |
| 7 | Table with **all three alignments** + a `null` (default) column | `align[]` preserved; delimiter row correct. |
| 8 | Table with **escaped pipes** (`a \| b`) in cells | `\|` escaping; cell never split. |
| 9 | Table cell with a `<br>` | in-cell break preserved as content (§4.1) and survives sanitize at preview. |
| 10 | **Multiple footnotes** (2+ refs, 2+ defs, out-of-order in source) | pairing by `identifier`; defs emitted at end in first-reference order. |
| 11 | Footnote **reference with no definition** + **orphan definition** | both preserved; nothing invented or dropped. |
| 12 | **Frontmatter with nested YAML** (lists + nested maps + dates) | `yaml.value` byte-exact; no collapse to thematic break (§4.3). |
| 13 | **Hard break** (backslash and trailing-spaces input) | both normalize to `\`-newline; not lost. |
| 14 | **Soft break** inside a paragraph | preserved as newline; **not** collapsed to a space (§4.5). |
| 15 | **Fenced code block with a language tag** (and one whose body contains backticks) | `lang` preserved; fence grows past inner backticks; never indented. |
| 16 | **Blockquote nesting** (two levels, with an inner blank line) | `> > ` prefixes; quote stays one block. |
| 17 | **Links and images with titles** | title preserved; quote normalized to `"`. |
| 18 | **Reference-style** link + definition | reference form preserved; `tightDefinitions`. |
| 19 | **Strikethrough** (`~~…~~`) | `delete` node round-trips. |
| 20 | **Autolink** — both angle (`<url>`) and bare GFM literal | each form's canonical output locked. |
| 21 | **Inline mix**: bold + italic + inline code + strikethrough + link + footnote ref in one paragraph | nesting/adjacency of phrasing nodes; emphasis/strong delimiters. |
| 22 | **Emphasis/strong delimiter normalization** (`*foo*`, `__bar__` input) | → `_foo_`, `**bar**`. |
| 23 | **Thematic break** variants (`***`, `___`, `- - -`) | all normalize to `---`. |
| 24 | **Inline raw HTML** (e.g. `<span>` / `<script>`) | preserved verbatim in source; sanitized only at preview (§4.6). |
| 25 | **Idempotence sweep** — run every case above through `normalize` twice | global assertion 1. |

> The corpus lives next to the dialect code and runs in `bun run test` (plan `README.md` Conventions). New supported constructs require a new corpus row **before** the construct is wired into any editor — the corpus is the contract's executable form.

---

## 7. How the rich editor is constrained to the dialect

This section is what makes "lossless" *honest* rather than aspirational (blueprint `README.md` §8: *"The rich editor may only produce constructs expressible in this dialect — there are no rich-only features that have no Markdown representation."*).

- **Milkdown's schema is bounded to the dialect.** Recto loads `@milkdown/preset-commonmark` + `@milkdown/preset-gfm` and the footnote/frontmatter support — and **no node or mark that lacks a Markdown serialization** (per `README.md` §6 stack). There is no rich-only node (no "callout box", no "colored text", no arbitrary HTML embed, no math node) because such a node could not be serialized into the dialect (§1.4) and would therefore break the round-trip contract (§5).
- **The serializer is the gatekeeper.** Because Milkdown's document is an MDAST and we serialize with the one shared `remark-stringify` config (§2.2), any construct that *did* sneak in with no `to-markdown` handler would **fail loudly at serialize time** — caught by the corpus (§6) and by the bridge, not silently dropped. We treat "serializer has no handler for node type X" as a build/test failure, not a runtime fallback.
- **Paste and import are filtered to the dialect.** Pasted rich content is converted to MDAST and any out-of-dialect construct is degraded (to text or to the nearest in-dialect node), so the canonical model never holds something it cannot emit. Raw HTML is the deliberate, preserved-as-text exception (§4.6).
- **Net effect:** the set of states the rich editor can reach is a **subset** of the set the dialect can represent. The raw editor can type anything (it edits text), but on parse it lands in the same bounded MDAST. Both surfaces are therefore closed under the round-trip contract.

This closure is the structural reason the bridge ([`05-lossless-bridge.md`](./05-lossless-bridge.md)) and mode switching ([`04-editor-modes.md`](./04-editor-modes.md)) can be lossless: neither surface can introduce a construct the other (or the serializer) can't represent.

---

## 8. Open decisions

| # | Decision | Status | Notes |
|---|---|---|---|
| O1 | Frontmatter editing UX | **Open** | v1 edits frontmatter as a **raw YAML block** (§4.3). A **structured metadata panel** (read/write individual keys, with the rest of the YAML untouched) is a later option. Any panel must round-trip through `yaml.value` and must not reformat untouched keys. Decide in/after Phase 2. |
| O2 | Autolink canonical form | **Provisional** | We lock bare-vs-angle output via corpus cases 20; if a chosen form proves surprising in practice, revisit (still must stay deterministic). |
| O3 | Reference-link preservation vs inlining | **Provisional** | Current rule: preserve author-chosen reference links (§4.8). Revisit only if it causes diff noise in real documents. |

> Open decisions are tracked here so they don't silently calcify. Resolving one updates this file (the blueprint is the source of truth — plan `README.md` Definition of Done §5).

---

## 9. Cross-references

- **[`05-lossless-bridge.md`](./05-lossless-bridge.md)** — the live two-mode sync that consumes this serializer; deterministic output (§2.4) is its precondition.
- **[`04-editor-modes.md`](./04-editor-modes.md)** — how rich / raw / Vim / preview each view the canonical model; mode switching relies on the round-trip contract (§5).
- **[`../plan/phase-2-modes-and-losslessness.md`](../plan/phase-2-modes-and-losslessness.md)** — the phase that implements this dialect and where the corpus (§6) is the gate.
- **[`README.md`](./README.md)** — blueprint canon (D1–D15, §7 data model, §8 dialect summary, §9 the three hard parts, §11 glossary).
- **[`03-data-model.md`](./03-data-model.md)** — `documents.markdown` is the persisted canonical string this dialect defines; ~1 MiB ceiling.

### External references

- remark-gfm (tables, task lists, strikethrough, autolinks, footnotes): https://github.com/remarkjs/remark-gfm
- remark-frontmatter (YAML frontmatter): https://github.com/remarkjs/remark-frontmatter
- remark-stringify (deterministic serialization + options): https://github.com/remarkjs/remark/tree/main/packages/remark-stringify
- GitHub Flavored Markdown spec (the GFM target grammar): https://github.github.com/gfm/
