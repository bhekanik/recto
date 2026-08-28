# 14 — Technical Decisions (ADR)

> This file is the **architecture decision record** for Recto. It documents *why* each major architecture and library choice was made, and *which alternatives were rejected and on what evidence*. It is the citeable backing for the locked decisions **D1–D15** in [`README.md`](./README.md) §3.
>
> If this file ever contradicts [`README.md`](./README.md), the README wins (per its own rule). These ADRs **must not** contradict D1–D15; where a decision below restates a locked decision, it expands the reasoning, it does not change the choice.
>
> **Reading guide.** Each entry follows one fixed template:
> **Context → Decision → Alternatives rejected → Rationale → Consequences → References**.
> "References" are URLs to primary sources (issues, docs, specs) plus the sibling blueprint files that depend on or detail the decision.

---

## Decision index

| ADR | Title | Locks / supports |
|-----|-------|------------------|
| [ADR-01](#adr-01--canonical-format-is-markdown-remark-mdast-not-prosemirror-json) | Canonical format is Markdown (remark MDAST), not ProseMirror JSON | D1, D2 |
| [ADR-02](#adr-02--reject-convert-on-every-mode-switch) | Reject convert-on-every-mode-switch | D2 |
| [ADR-03](#adr-03--rich-text-engine-is-milkdown) | Rich-text engine is Milkdown | D3 |
| [ADR-04](#adr-04--raw--vim-engine-is-codemirror-6--replitcodemirror-vim) | Raw + Vim engine is CodeMirror 6 + `@replit/codemirror-vim` | D4 |
| [ADR-05](#adr-05--reject-convex-devprosemirror-sync-as-the-synccanonical-layer) | Reject `@convex-dev/prosemirror-sync` as the sync/canonical layer | D10 |
| [ADR-06](#adr-06--reject-yjs--crdt-for-sync) | Reject Yjs / CRDT for sync | D10 |
| [ADR-07](#adr-07--sync-is-a-convex-debounced-last-write-wins-snapshot-of-the-canonical-markdown-string) | Sync is a Convex debounced last-write-wins snapshot of the canonical Markdown string | D10, D11 |
| [ADR-08](#adr-08--undo-is-a-custom-model-level-branching-tree) | Undo is a custom model-level branching tree | D8 |
| [ADR-09](#adr-09--undo-tree-and-version-control-share-one-append-only-store-but-keep-distinct-semantics) | Undo tree and version control share one append-only store but keep distinct semantics | D8, D9 |
| [ADR-10](#adr-10--cloud-persisted-undo-tree-is-tractable-because-docnodes-are-append-onlyimmutable) | Cloud-persisted undo tree is tractable because `docNodes` are append-only/immutable | D8, D10 |
| [ADR-11](#adr-11--app-stack-is-nextjs-app-router--bun--typescript-strict--better-auth--convex) | App stack is Next.js (App Router) + bun + TypeScript strict + Better Auth + Convex | D12, D14 |
| [ADR-12](#adr-12--ui-is-tailwind-v4--shadcn-primitives--oklch-dark-only) | UI is Tailwind v4 + shadcn primitives + OKLCH, dark-only | D13 |
| [ADR-13](#adr-13--rich-text-export-is-html-rtf-is-skipped-docx-is-optional-and-later) | Rich-text export is `.html`; `.rtf` is skipped; `.docx` is optional and later | — |
| [ADR-14](#adr-14--clipboard-writes-one-clipboarditem-with-texthtml--textplain) | Clipboard writes one `ClipboardItem` with `text/html` + `text/plain` | — |
| [ADR-15](#adr-15--phase-0-spike-a-live-two-mode-bridge-confirmed) | Phase 0 Spike A: live two-mode bridge **confirmed** | D6 |
| [ADR-16](#adr-16--phase-0-spike-b-cloud-undo-tree-confirmed) | Phase 0 Spike B: cloud undo-tree DAG **confirmed** | D8 |
| [ADR-17](#adr-17--phase-1-foundation-deviations-reconcile-in-phase-34) | Phase 1 foundation deviations (reconcile in Phase 3–4) | — |
| [ADR-18](#adr-18--shadcn-ui-is-the-component-system-compose-dont-reinvent) | shadcn/ui is the component system; compose, don't reinvent | D13, P3 |
| [ADR-19](#adr-19--one-edit-is-one-transaction-documentscommitedit) | One edit is one transaction: `documents.commitEdit` | D8, D10 |
| [ADR-20](#adr-20--light-theme-paper-palette--appearance-setting-reverses-d13) | Light theme: Paper palette + appearance setting, reverses D13 | **Reverses D13**; locks D-N5 |

---

## ADR-01 — Canonical format is Markdown (remark MDAST), not ProseMirror JSON

**Status:** Accepted. Locks **D1** ("Canonical document model = remark MDAST in memory; persisted as a Markdown string in Convex") and underpins **D2**.

### Context

Recto is "one piece of writing, edited through four interchangeable lenses": rich text, raw Markdown, Vim, and preview ([`README.md`](./README.md) §1, [`01-product-overview.md`](./01-product-overview.md)). Two of those four lenses — raw Markdown and Vim — are *plain-text Markdown* surfaces. The product's first principle on losslessness is absolute: *"A document that round-trips rich → raw → rich must come back byte-stable within the supported dialect"* ([`README.md`](./README.md) §4.3).

A WYSIWYG editor needs a structured tree to render and edit. The architectural fork is: **what is that tree, and what is the truth at rest?** There are exactly two coherent answers.

1. **ProseMirror JSON canonical (PM-JSON-canonical).** The rich editor's `ProseMirror` document is the source of truth; Markdown is produced *from* it by a serializer when the raw/Vim lens needs text, and parsed *back into* it when text is edited.
2. **Markdown / remark MDAST canonical.** The Markdown abstract syntax tree (MDAST, from the `remark`/`unified` ecosystem) is the source of truth; the rich editor edits that tree directly, and the raw/Vim lenses edit its serialized string form.

### Decision

The canonical document is a **remark MDAST**, held in memory while editing and persisted to Convex as a **Markdown string** (`documents.markdown`, see [`03-data-model.md`](./03-data-model.md)). Every lens is a *view* (projection) of that one model:

- **Rich text** edits the MDAST directly (via Milkdown — see [ADR-03](#adr-03--rich-text-engine-is-milkdown)).
- **Raw Markdown** and **Vim** edit the serialized canonical Markdown string (via CodeMirror 6 — see [ADR-04](#adr-04--raw--vim-engine-is-codemirror-6--replitcodemirror-vim)).
- **Preview** renders the MDAST to HTML via `remark-rehype` + `rehype-sanitize` ([`README.md`](./README.md) §2, D5).

### Alternatives rejected

- **PM-JSON-canonical.** Make ProseMirror JSON the truth; treat Markdown as a derived serialization. **Rejected.** This is the standard architecture for rich-text-first products (and is what `@convex-dev/prosemirror-sync` forces — see [ADR-05](#adr-05--reject-convex-devprosemirror-sync-as-the-synccanonical-layer)), but it makes the raw-Markdown and Vim lenses second-class citizens: every plain-text edit must survive a *parse → PM doc → serialize* trip, and the serializer is a lossy, opinionated re-emission of Markdown, not a preservation of what the user typed. The whitespace, list markers, fence styles, and link reference forms the user authored are not invariants of a ProseMirror document; they are reconstructed by the serializer's defaults.

### Rationale

MDAST-canonical is **the only path** that simultaneously satisfies all three of Recto's hard requirements:

1. **Lossless rich ↔ Markdown.** Because the rich editor's own document model *is* the MDAST (ADR-03), there is no rich→Markdown "conversion" at all — editing rich text is editing the canonical tree. The serialized string is produced once, by one serializer (`remark-stringify`), under explicit normalization rules ([`06-markdown-dialect.md`](./06-markdown-dialect.md)), so "round-trip" means `serialize(parse(markdown)) === normalize(markdown)` — a single, testable identity, not a two-engine reconciliation.
2. **Raw Markdown is first-class.** The raw lens edits the *actual* canonical string; there is no hidden rich model that must be re-derived. What the user types in raw mode is the document.
3. **Vim is first-class.** Vim is keybindings over a plain-text buffer ([ADR-04](#adr-04--raw--vim-engine-is-codemirror-6--replitcodemirror-vim)); it requires a real text surface, which the canonical string is, natively. Under PM-JSON-canonical, Vim would operate on a *projection* of a ProseMirror doc, re-parsed on every change — the worst case for cursor stability and losslessness.

This is the design that makes [`README.md`](./README.md) §2 ("There is a single canonical document. Every mode is a view of it. Modes never convert between two competing formats.") literally true.

### Consequences

- The persistence unit is a small Markdown string, which comfortably fits Convex's ~1 MiB per-value ceiling for articles ([`03-data-model.md`](./03-data-model.md), [`README.md`](./README.md) §5 non-goals).
- The rich editor is constrained to constructs expressible in the supported Markdown dialect — there are **no** rich-only features without a Markdown representation ([`README.md`](./README.md) §8, [`06-markdown-dialect.md`](./06-markdown-dialect.md)). This is a feature, not a limitation: it is what keeps "lossless" honest.
- The live two-mode bridge ([`05-lossless-bridge.md`](./05-lossless-bridge.md)) uses the MDAST as its single bus between the two editor engines, rather than reconciling two competing canonical formats.
- Preview never drifts, because it renders the same AST rather than re-parsing with a second parser ([`README.md`](./README.md) §6 stack table).

### References

- [https://milkdown.dev/](https://milkdown.dev/) — Milkdown; its document model is a remark MDAST.
- [https://quarto.org/docs/visual-editor/markdown.html](https://quarto.org/docs/visual-editor/markdown.html) — Quarto's "one canonical Markdown writer" approach; prior art for Markdown-as-canonical with a visual editor over it.
- Sibling files: [`02-architecture.md`](./02-architecture.md), [`03-data-model.md`](./03-data-model.md), [`05-lossless-bridge.md`](./05-lossless-bridge.md), [`06-markdown-dialect.md`](./06-markdown-dialect.md).

---

## ADR-02 — Reject convert-on-every-mode-switch

**Status:** Accepted. Locks **D2** ("Modes are views of the canonical model, never format-to-format conversions").

### Context

Given two editor engines (rich and plain-text), the naive way to keep them "in sync" is to convert at the boundary: when the user switches from rich to raw, serialize the rich doc to Markdown and load it into the text editor; when they switch back, parse the text and rebuild the rich doc. Each editor keeps its *own* canonical state, and a conversion runs **on every mode switch**.

### Decision

Recto does **not** convert format-to-format on mode switch. There is one canonical model (the MDAST, [ADR-01](#adr-01--canonical-format-is-markdown-remark-mdast-not-prosemirror-json)); switching modes attaches a different *view* to the same model. The live two-mode bridge keeps the two views consistent keystroke-by-keystroke through the MDAST bus, not through a switch-time conversion ([`05-lossless-bridge.md`](./05-lossless-bridge.md), D6).

### Alternatives rejected

- **Convert-on-every-mode-switch (two competing canonical states, reconciled at the boundary).** **Rejected** on documented evidence of *progressive round-trip degradation* — small, compounding mutations introduced by each conversion that accumulate over repeated switches until the document visibly drifts.

### Rationale

Convert-on-switch is a known, reproducible failure mode in the rich-text ecosystem, not a theoretical concern:

- **TipTap issue #7147** documents that round-tripping content through TipTap's Markdown layer is *not* stable — content mutates across the serialize/parse boundary, so repeatedly crossing it degrades the document. This is the exact mechanism a convert-on-switch design would invoke on *every* mode toggle.
- **RStudio issue #8030** documents a *destructive* switch in the RStudio visual (WYSIWYG) ↔ source editor: switching modes could silently alter or lose content. This is the canonical real-world "the conversion ate my document" report.

The ecosystem's convergent answer to both is **one canonical model with a single canonical writer; modes are views**. **Quarto's visual editor** is built on precisely this principle: a single canonical Markdown representation that the visual and source editors both project from, with one deterministic Markdown *writer* — so switching surfaces never re-derives a competing truth and never accumulates drift. Recto adopts that architecture wholesale (ADR-01).

Crucially, with one canonical model the only correctness identity to prove is the *serializer's* round-trip (`serialize(parse(md)) === normalize(md)`), which is unit-testable against a property corpus ([`06-markdown-dialect.md`](./06-markdown-dialect.md)). With convert-on-switch you must instead prove that *two independent engines'* conversions are mutually inverse across arbitrary edit histories — which is exactly what TipTap #7147 and RStudio #8030 show is not reliably true.

### Consequences

- Mode switches are instant and lossless ([`README.md`](./README.md) §4.3–4.4): they are view re-attachments, with no parse/serialize round-trip on the hot path.
- The two-mode bridge becomes the place where rich↔raw consistency is enforced live; it is origin-guarded and throttled, diff-based, and cursor-preserving ([`05-lossless-bridge.md`](./05-lossless-bridge.md), §9.1 in [`README.md`](./README.md)). This is harder than a switch-time convert, which is why it is **spiked first in Phase 0** ([`../plan/phase-0-spikes.md`](../plan/phase-0-spikes.md)).
- Losslessness is verified by a single round-trip property-test corpus, not by exhaustively testing two engines against each other.

### References

- [https://github.com/ueberdosis/tiptap/issues/7147](https://github.com/ueberdosis/tiptap/issues/7147) — TipTap Markdown round-trip is not stable (serialize/parse mutates content).
- [https://github.com/rstudio/rstudio/issues/8030](https://github.com/rstudio/rstudio/issues/8030) — RStudio visual↔source editor destructive mode switch.
- [https://quarto.org/docs/visual-editor/markdown.html](https://quarto.org/docs/visual-editor/markdown.html) — Quarto: one canonical Markdown writer, visual + source as views.
- Sibling files: [`04-editor-modes.md`](./04-editor-modes.md), [`05-lossless-bridge.md`](./05-lossless-bridge.md), [`06-markdown-dialect.md`](./06-markdown-dialect.md).

---

## ADR-03 — Rich-text engine is Milkdown

**Status:** Accepted. Locks **D3** ("Rich text engine = Milkdown (remark-backed ProseMirror)").

### Context

[ADR-01](#adr-01--canonical-format-is-markdown-remark-mdast-not-prosemirror-json) requires the canonical document to be a remark MDAST and requires rich editing to be *direct editing of that tree* — not a separate rich model that is serialized to Markdown afterward. The choice of rich-text engine is therefore constrained: it must be able to treat remark MDAST as its document model, or at minimum keep Markdown losslessly, at the edges, not just in the common case.

### Decision

The rich-text engine is **Milkdown** with `@milkdown/preset-commonmark`, `@milkdown/preset-gfm`, and the supporting remark plugins ([`README.md`](./README.md) §6 stack table). Milkdown is a ProseMirror-based editor whose document pipeline is built on `remark` — its parse/serialize path *is* the remark MDAST. Editing in Milkdown is editing the canonical tree.

### Alternatives rejected

- **TipTap.** **Rejected.** TipTap is an excellent ProseMirror toolkit, but in TipTap, Markdown is a **serialize/parse layer bolted onto a ProseMirror-canonical model** — it is lossy at the edges (see TipTap #7147 cited in [ADR-02](#adr-02--reject-convert-on-every-mode-switch)). Choosing TipTap would re-introduce the PM-JSON-canonical architecture that ADR-01 rejects.
- **Lexical.** **Rejected.** Meta's Lexical is promising but was **pre-1.0** with a weaker, less battle-tested Markdown round-trip story; its Markdown export/import is a transform layer, not the canonical model. Not a fit for a product whose *defining* promise is losslessness.
- **Slate.** **Rejected.** Slate has **no first-class Markdown** — its document is a custom JSON model and Markdown support is entirely community/userland. That is the opposite of "the document model *is* MDAST."
- **BlockNote.** **Rejected.** BlockNote is a **block-based** editor (a Notion-style block model); Markdown is a **lossy export**, not the canonical form. The block model imposes structure that does not map cleanly onto arbitrary CommonMark/GFM, so it cannot be the losslessness substrate.

### Rationale

Milkdown's document model **is** remark MDAST. This collapses the entire "rich → Markdown conversion" problem out of existence: there is no conversion, there is one tree. Every rejected alternative shares the same disqualifying property — Markdown is a *layer over a different canonical model* (PM JSON, Lexical state, Slate JSON, or BlockNote blocks), so each would reintroduce exactly the round-trip-degradation risk catalogued in [ADR-02](#adr-02--reject-convert-on-every-mode-switch). Milkdown is the only candidate where the rich editor's truth and Recto's canonical truth are the same object.

Milkdown is also ProseMirror underneath, which keeps the door open for using ProseMirror-native tooling (e.g. `prosemirror-recreate-steps` for applying external Markdown edits into the live rich doc without nuking the cursor — [`README.md`](./README.md) §6, [`05-lossless-bridge.md`](./05-lossless-bridge.md)).

### Consequences

- The rich editor is naturally constrained to the supported dialect (CommonMark + GFM + footnotes + frontmatter, [`README.md`](./README.md) §7–8, [`06-markdown-dialect.md`](./06-markdown-dialect.md)) — it can only produce nodes that exist in the MDAST it edits.
- Milkdown is ProseMirror-based, so its undo plugin (`prosemirror-history`) is *linear* — which is one of the reasons Recto builds a **custom branching undo tree at the model level** rather than relying on the editor's history (see [ADR-08](#adr-08--undo-is-a-custom-model-level-branching-tree)).
- The slash command palette and contextual formatting UI ([`README.md`](./README.md) §4.5, [`04-editor-modes.md`](./04-editor-modes.md)) are built with Milkdown's plugin surface.

### References

- [https://milkdown.dev/](https://milkdown.dev/) — Milkdown; remark-backed, ProseMirror-based, MDAST document model.
- [https://github.com/ueberdosis/tiptap/issues/7147](https://github.com/ueberdosis/tiptap/issues/7147) — evidence that TipTap's Markdown layer is lossy at the edges.
- Sibling files: [`04-editor-modes.md`](./04-editor-modes.md), [`05-lossless-bridge.md`](./05-lossless-bridge.md), [`06-markdown-dialect.md`](./06-markdown-dialect.md), [`07-undo-tree.md`](./07-undo-tree.md).

---

## ADR-04 — Raw + Vim engine is CodeMirror 6 + `@replit/codemirror-vim`

**Status:** Accepted. Locks **D4** ("Raw + Vim engine = CodeMirror 6 + `@replit/codemirror-vim`").

### Context

Two of the four lenses — raw Markdown and Vim — are plain-text Markdown surfaces over the canonical Markdown string ([ADR-01](#adr-01--canonical-format-is-markdown-remark-mdast-not-prosemirror-json)). The Vim lens must provide **real** modal editing: distinct normal / insert / visual modes, not a partial emulation ([`README.md`](./README.md) §1.3). The surface must also stay lightweight — typing must never wait, and the bundle should not balloon ([`README.md`](./README.md) §4.4 "Snappy is a feature").

### Decision

The raw and Vim lenses share one text-editor engine: **CodeMirror 6** with `@codemirror/lang-markdown` and `@replit/codemirror-vim` ([`README.md`](./README.md) §6 stack table). The Vim lens is the raw lens with the `@replit/codemirror-vim` extension layered on; it provides real normal / insert / visual modes.

### Alternatives rejected

- **Monaco + `monaco-vim`.** **Rejected.** Monaco (the editor extracted from VS Code) is an **IDE-grade** editor: it carries a large bundle (roughly **2–5 MB**), is heavyweight for a prose surface, and `monaco-vim` is comparatively **lightly maintained**. Recto is a writing studio, not a code IDE; Monaco's language-service machinery is dead weight here, and its size directly contradicts the "snappy" principle.

### Rationale

CodeMirror 6 is **lightweight**, modular (you ship only the extensions you use), and `@replit/codemirror-vim` provides **real** modal editing — normal / insert / visual — rather than a thin shim. It is also **what Obsidian uses** for its editor with Vim support, which is the closest comparable "Markdown-first, Vim-capable" writing tool — strong evidence it is fit for purpose at prose scale and Vim fidelity. Sharing one engine across both plain-text lenses means the raw and Vim views are byte-identical surfaces over the same string, differing only by the presence of the Vim extension — which keeps the live bridge and cursor-preservation logic ([`05-lossless-bridge.md`](./05-lossless-bridge.md)) simpler.

### Consequences

- The bundle stays small relative to a Monaco-based design, protecting the snappy/instant-mode-switch contract ([`README.md`](./README.md) §4.4).
- CodeMirror 6's history (`@codemirror/commands` history) is **linear**, and `@replit/codemirror-vim` provides **no undo tree** — another reason undo is implemented at the model level as a custom branching tree (see [ADR-08](#adr-08--undo-is-a-custom-model-level-branching-tree)).
- Vim keymaps interact with Recto's global keymap and command palette; that interplay is specified in [`13-keyboard-commands.md`](./13-keyboard-commands.md).
- Markdown syntax highlighting in raw/Vim comes from `@codemirror/lang-markdown`, kept consistent with the dialect in [`06-markdown-dialect.md`](./06-markdown-dialect.md).

### References

- [https://github.com/replit/codemirror-vim](https://github.com/replit/codemirror-vim) — `@replit/codemirror-vim`; real normal/insert/visual modes for CodeMirror 6.
- Sibling files: [`04-editor-modes.md`](./04-editor-modes.md), [`05-lossless-bridge.md`](./05-lossless-bridge.md), [`07-undo-tree.md`](./07-undo-tree.md), [`13-keyboard-commands.md`](./13-keyboard-commands.md).

---

## ADR-05 — Reject `@convex-dev/prosemirror-sync` as the sync/canonical layer

**Status:** Accepted. Supports **D10** ("no `prosemirror-sync`").

### Context

Recto is on Convex (see [ADR-11](#adr-11--app-stack-is-nextjs-app-router--bun--typescript-strict--better-auth--convex)). Convex ships an official component, `@convex-dev/prosemirror-sync` (the `get-convex/prosemirror-sync` component), that syncs a ProseMirror document to Convex and is the obvious "batteries-included" choice for a ProseMirror-based editor. Because Milkdown is ProseMirror-based ([ADR-03](#adr-03--rich-text-engine-is-milkdown)), it would *appear* to drop in.

### Decision

Recto does **not** use `@convex-dev/prosemirror-sync` as its sync or canonical layer. Sync is a debounced last-write-wins snapshot of the canonical Markdown string instead (see [ADR-07](#adr-07--sync-is-a-convex-debounced-last-write-wins-snapshot-of-the-canonical-markdown-string)).

### Alternatives rejected

- **`@convex-dev/prosemirror-sync` as the canonical/sync layer.** **Rejected** on three independent grounds (any one is sufficient):
  1. **It forces PM-JSON canonical.** The component's stored truth is the ProseMirror document (and its steps), not Markdown. Adopting it would make ProseMirror JSON the source of truth — directly violating [ADR-01](#adr-01--canonical-format-is-markdown-remark-mdast-not-prosemirror-json)/D1 and re-introducing the round-trip-degradation risk of [ADR-02](#adr-02--reject-convert-on-every-mode-switch). It **kills losslessness** for the raw/Vim lenses.
  2. **It is multi-writer machinery a single user does not need.** The component is built around **operational transformation (OT)** of ProseMirror steps to merge *concurrent* edits from multiple clients. Recto is explicitly single-user, sequential editing ([`README.md`](./README.md) §1, §5). The OT step-merging apparatus solves a problem Recto does not have, at the cost of complexity and the PM-JSON lock-in above.
  3. **It has no offline support yet.** As of **v0.2.4**, offline editing is on the component's roadmap, not shipped. Recto's "never lose a word" / "resume anywhere" promises ([`README.md`](./README.md) §4.1–4.2) want a clear local-owns-live story today, not a pending roadmap item.

### Rationale

The component is genuinely good infrastructure — for a *different* product: a multi-user, ProseMirror-canonical, collaborative editor. Recto is the opposite on every axis that matters here (single-user, Markdown-canonical, sequential). Adopting it would trade away the one property the whole product is built on (losslessness) to gain capabilities (concurrent multi-writer merge) the product has declared a non-goal. The correct call is to keep the Markdown string canonical and use a simple snapshot sync ([ADR-07](#adr-07--sync-is-a-convex-debounced-last-write-wins-snapshot-of-the-canonical-markdown-string)).

### Consequences

- Recto owns its sync logic (a debounced mutation writing `documents.markdown`), which is small and fully under our control ([`10-sync-persistence.md`](./10-sync-persistence.md)).
- We forgo built-in real-time multi-client merge — acceptable, because it is a declared non-goal ([`README.md`](./README.md) §5).
- The undo tree is *also* not provided by this component (it would have given us linear PM history at best); Recto builds its own ([ADR-08](#adr-08--undo-is-a-custom-model-level-branching-tree), [ADR-10](#adr-10--cloud-persisted-undo-tree-is-tractable-because-docnodes-are-append-onlyimmutable)).

### References

- [https://github.com/get-convex/prosemirror-sync](https://github.com/get-convex/prosemirror-sync) — the component; PM-canonical, OT-based, offline on roadmap (v0.2.4 at time of decision).
- [https://milkdown.dev/](https://milkdown.dev/) — Milkdown is ProseMirror-based (why the component superficially fits).
- Sibling files: [`10-sync-persistence.md`](./10-sync-persistence.md), [`02-architecture.md`](./02-architecture.md).

---

## ADR-06 — Reject Yjs / CRDT for sync

**Status:** Accepted. Supports **D10** ("no Yjs / CRDT").

### Context

The other mainstream answer to "sync a document and merge concurrent edits" is a **CRDT** (conflict-free replicated data type) — most prominently **Yjs** in the JS ecosystem, or `Automerge`. CRDTs let multiple replicas edit offline and merge automatically without a central server arbiter. They are the standard substrate for local-first collaborative editors.

### Decision

Recto does **not** use Yjs or any CRDT for document sync. Sync is a debounced last-write-wins snapshot of the canonical Markdown string ([ADR-07](#adr-07--sync-is-a-convex-debounced-last-write-wins-snapshot-of-the-canonical-markdown-string)).

### Alternatives rejected

- **Yjs / CRDT (Automerge etc.) as the sync substrate.** **Rejected.** A CRDT exists to merge *concurrent, conflicting* edits across replicas. Recto is **single-user, sequential editing** ([`README.md`](./README.md) §1, §5): the realistic conflict surface is "same user, two devices, edits within the debounce window," which is rare and handled by last-write-wins plus the version-history safety net ([`10-sync-persistence.md`](./10-sync-persistence.md), plan risk register row "Same doc edited on two devices"). The CRDT's per-character metadata imposes ongoing **memory and complexity** costs (document state carries merge metadata that dwarfs the text) for a merge guarantee we do not need.
- Additionally, a CRDT undo manager (e.g. Yjs `UndoManager`) is **inherently linear/stack-based and replica-scoped** — it would **fight Recto's custom branching undo tree** ([ADR-08](#adr-08--undo-is-a-custom-model-level-branching-tree)), not support it. Layering a branching model-level undo DAG on top of a CRDT's own undo semantics is a direct architectural conflict.

### Rationale

CRDTs are the right tool for local-first multi-writer collaboration and offline-merge. Recto needs neither. The cost (memory overhead, conceptual complexity, and a built-in linear undo that conflicts with our branching tree) is unjustified for a single sequential writer. The simpler Markdown-string snapshot ([ADR-07](#adr-07--sync-is-a-convex-debounced-last-write-wins-snapshot-of-the-canonical-markdown-string)) plus an append-only undo DAG that union-merges trivially ([ADR-10](#adr-10--cloud-persisted-undo-tree-is-tractable-because-docnodes-are-append-onlyimmutable)) gives us cross-device resume and a robust history without CRDT machinery.

### Consequences

- No CRDT runtime, no per-character merge metadata in the persisted document. The persisted unit stays a plain Markdown string under the ~1 MiB ceiling ([`03-data-model.md`](./03-data-model.md)).
- We accept rare last-write-wins on the live document; version history is the recovery path ([`08-version-control.md`](./08-version-control.md), [`10-sync-persistence.md`](./10-sync-persistence.md)).
- The undo DAG's *append-only immutability* (ADR-10) gives us conflict-free cross-device merge for history specifically — getting the one property a CRDT would have provided where we actually want it (history), without paying CRDT costs on the live document.

### References

- [https://docs.yjs.dev/api/undo-manager](https://docs.yjs.dev/api/undo-manager) — Yjs `UndoManager`; stack-based/linear, replica-scoped (conflicts with a branching tree).
- [https://automerge.org/docs/reference/glossary/](https://automerge.org/docs/reference/glossary/) — Automerge / CRDT glossary; concurrency-merge model and its metadata costs.
- [https://www.inkandswitch.com/patchwork/](https://www.inkandswitch.com/patchwork/) — Ink & Switch on local-first/versioned editing; context for why branching history and CRDT merge are *separate* concerns.
- Sibling files: [`07-undo-tree.md`](./07-undo-tree.md), [`10-sync-persistence.md`](./10-sync-persistence.md).

---

## ADR-07 — Sync is a Convex debounced last-write-wins snapshot of the canonical Markdown string

**Status:** Accepted. Locks **D10** (sync mechanism) and depends on **D11** (editing performance model).

### Context

Having rejected both `@convex-dev/prosemirror-sync` ([ADR-05](#adr-05--reject-convex-devprosemirror-sync-as-the-synccanonical-layer)) and CRDT sync ([ADR-06](#adr-06--reject-yjs--crdt-for-sync)), Recto needs a positive sync design that delivers "always saved, resume anywhere" ([`README.md`](./README.md) §1, §4.2) for a single sequential user, while never making typing wait on the network ([`README.md`](./README.md) §4.4, D11).

### Decision

Sync is a **Convex debounced last-write-wins snapshot of the canonical Markdown string**. The local editor **owns live editing state**; edits are buffered locally and flushed to Convex by a **debounced mutation** that overwrites `documents.markdown` (plus `wordCount`, `updatedAt`, and the undo pointer `currentNodeId`). The editor is **never a controlled component of a reactive query** — `useQuery` results hydrate the editor on open/idle only, never on every keystroke (D11, [`10-sync-persistence.md`](./10-sync-persistence.md), [`../plan/README.md`](../plan/README.md) "Performance contract").

### Alternatives rejected

- **`@convex-dev/prosemirror-sync`** — see [ADR-05](#adr-05--reject-convex-devprosemirror-sync-as-the-synccanonical-layer).
- **Yjs / CRDT sync** — see [ADR-06](#adr-06--reject-yjs--crdt-for-sync).
- **Per-keystroke mutations / editor bound to `useQuery`.** **Rejected.** Writing on every keystroke burns Convex function calls and bandwidth and, worse, binding the editor's value to a reactive query result will **clobber the cursor** when the query re-runs (plan risk register: "Cursor clobbered by reactive sync"). Debounced flush + hydrate-on-open is the explicit performance contract.

### Rationale

- **It fits Convex's model and limits.** Convex uses **optimistic concurrency control (OCC)**: mutations run in serializable transactions and **retry** automatically on read/write conflicts. Because Recto is single-user and writes are debounced (not per-keystroke), conflicting concurrent writes to the same `documents` row are rare, so OCC retries stay negligible. Debouncing also keeps us well inside Convex's documented function-call, bandwidth, and value-size limits (~1 MiB per value).
- **Optimistic updates keep the UI snappy.** Convex's optimistic-update rules let the local mutation reflect immediately while the server confirms, reinforcing local-owns-live without a custom queue.
- **Last-write-wins is correct for this user model.** With one sequential writer, the only real conflict is two-devices-within-the-debounce-window — acceptably handled by LWW, with version history as the recovery net ([`08-version-control.md`](./08-version-control.md)).
- **The snapshot unit is small.** The canonical Markdown string for an article is far under the ~1 MiB ceiling; history lives in separate `docNodes` rows, never embedded ([`03-data-model.md`](./03-data-model.md), [ADR-10](#adr-10--cloud-persisted-undo-tree-is-tractable-because-docnodes-are-append-onlyimmutable)).

### Consequences

- A refresh, crash, or device switch never costs text once a flush has landed; the debounce window is the only at-risk interval, mitigated by local persistence and the history safety net ([`10-sync-persistence.md`](./10-sync-persistence.md)).
- The editor and the reactive query are decoupled: hydrate-on-open/idle, debounced-write-out. This is the load-bearing rule for "snappy" (D11) and is restated as a hard convention in [`../plan/README.md`](../plan/README.md).
- Offline tolerance is bounded by what the local owner can buffer; full offline editing is not a v1 promise beyond the local-owns-live window ([`10-sync-persistence.md`](./10-sync-persistence.md)).

### References

- [https://docs.convex.dev/production/state/limits](https://docs.convex.dev/production/state/limits) — Convex limits (~1 MiB per value, function-call/bandwidth ceilings) the debounce respects.
- [https://docs.convex.dev/database/advanced/occ](https://docs.convex.dev/database/advanced/occ) — Convex optimistic concurrency control + retries; why debounced single-writer writes are safe.
- Sibling files: [`10-sync-persistence.md`](./10-sync-persistence.md), [`03-data-model.md`](./03-data-model.md), [`02-architecture.md`](./02-architecture.md); plan: [`../plan/phase-0-spikes.md`](../plan/phase-0-spikes.md), [`../plan/phase-1-foundation.md`](../plan/phase-1-foundation.md).

---

## ADR-08 — Undo is a custom model-level branching tree

**Status:** Accepted. Locks **D8** ("Branching undo tree (not linear), cloud-persisted as an append-only DAG").

### Context

Recto promises a **branching undo tree** — not linear undo ([`README.md`](./README.md) §1, D8). In a branching model, undoing and then typing something new does **not** discard the redo branch; it creates a *new* branch, and you can navigate back to any prior branch. This is the Vim "undotree" / Emacs `undo-tree` mental model. None of Recto's editor engines provide it.

### Decision

Undo is implemented as a **custom branching tree at the canonical-model level** (over the MDAST / Markdown string), persisted as an append-only DAG in `docNodes` ([`README.md`](./README.md) §7, [`07-undo-tree.md`](./07-undo-tree.md)). It is *not* delegated to any editor's built-in history.

### Alternatives rejected

- **`prosemirror-history`** (Milkdown's / ProseMirror's history plugin). **Rejected.** It is **linear** — a classic undo/redo stack; the redo branch is discarded on new input. No branching.
- **`@codemirror/commands` history** (CodeMirror 6's history). **Rejected.** Also **linear**, same limitation.
- **`@replit/codemirror-vim`'s undo.** **Rejected.** It maps Vim `u` / `Ctrl-r` onto the linear CodeMirror history; it provides **no undotree** despite Vim itself having one.
- **Any off-the-shelf branching-undo library for these engines.** **Rejected** — none exists that provides a branching undo DAG for the Milkdown/ProseMirror + CodeMirror 6 stack. (CRDT undo managers are linear too — [ADR-06](#adr-06--reject-yjs--crdt-for-sync).)

### Rationale

Every built-in history available to Recto's two engines is **linear**, and the one place modal-editing users *expect* a tree (Vim) does not expose one in `@replit/codemirror-vim`. Branching undo also has to be **shared across both editor engines** for one document and **persisted to the cloud** — neither editor's local, in-memory, linear history could satisfy that even if it were branching. Implementing undo at the canonical-model level (one tree per document, engine-agnostic) is the only design that gives a single branching history across both lenses *and* makes it persistable.

### Consequences

- Each meaningful edit appends an immutable node to `docNodes` (delta `patch` vs parent, occasional full `snapshot`, captured `selection`, `origin`), and `documents.currentNodeId` points at the current node ([`03-data-model.md`](./03-data-model.md)). Undo/redo is *navigation* of this DAG, not stack pops.
- The append-only immutability is exactly what makes cloud persistence and cross-device merge tractable ([ADR-10](#adr-10--cloud-persisted-undo-tree-is-tractable-because-docnodes-are-append-onlyimmutable)).
- This shares a store with version control but keeps distinct semantics ([ADR-09](#adr-09--undo-tree-and-version-control-share-one-append-only-store-but-keep-distinct-semantics)).
- It is unproven enough to be **spiked first in Phase 0** ([`../plan/phase-0-spikes.md`](../plan/phase-0-spikes.md)); the visualizer and grouping/navigation UX are in [`07-undo-tree.md`](./07-undo-tree.md).

### References

- [https://docs.yjs.dev/api/undo-manager](https://docs.yjs.dev/api/undo-manager) — example of a mainstream undo manager that is stack-based/linear (what we are *not* doing).
- Sibling files: [`07-undo-tree.md`](./07-undo-tree.md), [`03-data-model.md`](./03-data-model.md), [`04-editor-modes.md`](./04-editor-modes.md); plan: [`../plan/phase-0-spikes.md`](../plan/phase-0-spikes.md), [`../plan/phase-4-history.md`](../plan/phase-4-history.md).

---

## ADR-09 — Undo tree and version control share one append-only store but keep distinct semantics

**Status:** Accepted. Locks the relationship between **D8** (undo) and **D9** (version control).

### Context

Recto has two history features: the **branching undo tree** ([ADR-08](#adr-08--undo-is-a-custom-model-level-branching-tree), D8) and **tagged versions** (auto + manual, D9). Both are "history." A tempting simplification is to fuse them into a single object — make a "version" just a named undo node and treat the whole thing as one timeline.

### Decision

The undo tree and version control **share one append-only store** — `docNodes` holds the immutable nodes; `versions` rows are *named references into* `docNodes` (`versions.nodeId` points at a `docNodes` node) ([`README.md`](./README.md) §7, D8/D9). But they keep **distinct semantics** and are **not fused into a single object**:

- **Undo tree:** *navigate*. Moving to a node makes it the current state; it is the editing-history surface.
- **Version control:** *additive restore*. Restoring a version does **not** rewind the timeline destructively — it produces a new state derived from the tagged node, preserving everything that came after ([`08-version-control.md`](./08-version-control.md)).

### Alternatives rejected

- **Fuse undo and versions into one object / one timeline.** **Rejected.** It conflates two genuinely different operations (transient navigation vs durable, named, additive restore) and would make "restore a version" destructive — exactly the trap mature tools avoid.

### Rationale

Sharing the underlying append-only store is efficient (versions are cheap pointers, not duplicated content) and consistent (a version always refers to a real, reproducible node). But the *semantics* must differ, and the entire industry has converged on **separating undo from versions and making restore additive**:

- **Figma** — version history is separate from undo; restoring a past version is additive (it becomes a new current state, history preserved).
- **Notion** — page version history is distinct from per-edit undo; restore is additive.
- **Google Docs** — "version history" / named versions are separate from `Ctrl-Z` undo; restoring a version is additive.
- **Obsidian** — file recovery / version snapshots are distinct from the editor's undo stack.
- **Yjs** — its `UndoManager` (undo) is explicitly a different mechanism from document snapshots/versions.

Recto follows the same separation. Fusing them would contradict this near-universal pattern and degrade the user's safety net (a restore that silently discards later work).

### Consequences

- `versions` is a thin index over `docNodes` (`kind: "auto" | "manual"`, `label`, `nodeId`), never a copy of content ([`03-data-model.md`](./03-data-model.md)).
- "Restore version V" creates new node(s) materialized from V's node and re-points `currentNodeId`, without deleting the branch the user was on ([`08-version-control.md`](./08-version-control.md)).
- The undo visualizer and the version list are different UIs over the same DAG ([`07-undo-tree.md`](./07-undo-tree.md), [`08-version-control.md`](./08-version-control.md)).

### References

- [https://www.inkandswitch.com/patchwork/](https://www.inkandswitch.com/patchwork/) — Ink & Switch on versioning vs editing history as distinct concerns.
- [https://docs.yjs.dev/api/undo-manager](https://docs.yjs.dev/api/undo-manager) — Yjs treats undo (UndoManager) separately from snapshots/versions.
- Sibling files: [`07-undo-tree.md`](./07-undo-tree.md), [`08-version-control.md`](./08-version-control.md), [`03-data-model.md`](./03-data-model.md).

---

## ADR-10 — Cloud-persisted undo tree is tractable because `docNodes` are append-only/immutable

**Status:** Accepted. Supports **D8** (cloud-persisted undo) and **D10** (Convex sync).

### Context

Persisting an undo tree to the cloud and keeping it correct across multiple devices sounds like a hard distributed-systems problem — normally you would reach for OT or a CRDT ([ADR-05](#adr-05--reject-convex-devprosemirror-sync-as-the-synccanonical-layer), [ADR-06](#adr-06--reject-yjs--crdt-for-sync)). Recto has rejected both.

### Decision

The cloud-persisted undo tree is made tractable by a structural property: **`docNodes` are append-only and immutable** ([`README.md`](./README.md) §7, §9.2). Each node has a globally unique client-generated `nodeId` (ULID) and is never mutated after creation. Therefore:

- **Nodes union-merge across devices with no conflict** — merging two devices' `docNodes` sets is set union keyed by `nodeId`; since nodes are immutable, two devices can never produce *different* content for the *same* node.
- **The current pointer is last-write-wins** — `documents.currentNodeId` is a single small scalar, resolved by LWW (consistent with [ADR-07](#adr-07--sync-is-a-convex-debounced-last-write-wins-snapshot-of-the-canonical-markdown-string)).

### Alternatives rejected

- **OT / CRDT to reconcile undo history across devices.** **Rejected** — unnecessary given immutability (and rejected wholesale in [ADR-05](#adr-05--reject-convex-devprosemirror-sync-as-the-synccanonical-layer)/[ADR-06](#adr-06--reject-yjs--crdt-for-sync)). Immutable, uniquely-keyed nodes are the simplest possible "CRDT" for this shape (a grow-only set), without a CRDT runtime.
- **Mutable history rows.** **Rejected** — mutating nodes would reintroduce write-write conflicts and require true conflict resolution; immutability is precisely what removes that.

### Rationale

Immutability turns a hard merge problem into set union. A ULID-keyed, append-only node can be created independently on two devices and merged by inserting both — there is nothing to reconcile because no node is ever rewritten. The only mutable piece of state, the current pointer, is a single scalar where last-write-wins is acceptable (it just decides "which node is current right now," recoverable by navigating the tree or restoring a version). This is the same insight Ink & Switch and CRDT literature rely on for grow-only structures, applied narrowly to history where we *do* want conflict-free merge — without paying CRDT costs on the live document ([ADR-06](#adr-06--reject-yjs--crdt-for-sync)).

### Consequences

- `docNodes` is delta-encoded (`patch` vs parent) with periodic full `snapshot`s for fast materialization, stored as **separate rows**, never an embedded array — respecting Convex's per-value ceiling and growth limits ([`03-data-model.md`](./03-data-model.md), [`README.md`](./README.md) §7).
- History storage grows append-only, so a **retention policy** (cap depth; keep recent + all tagged versions; prune deep abandoned branches) is a planned mitigation, not an emergency ([`../plan/README.md`](../plan/README.md) risk register, [`07-undo-tree.md`](./07-undo-tree.md)).
- Cross-device merge correctness is verified by persistence/merge tests, **spiked in Phase 0** and hardened in Phase 4 ([`../plan/phase-0-spikes.md`](../plan/phase-0-spikes.md), [`../plan/phase-4-history.md`](../plan/phase-4-history.md)).

### References

- [https://docs.convex.dev/database/advanced/occ](https://docs.convex.dev/database/advanced/occ) — Convex OCC; append-only inserts of distinct rows minimize write conflicts.
- [https://docs.convex.dev/production/state/limits](https://docs.convex.dev/production/state/limits) — per-value/row limits driving "separate rows + delta + periodic snapshot."
- [https://automerge.org/docs/reference/glossary/](https://automerge.org/docs/reference/glossary/) — grow-only set / merge concepts underpinning union-merge.
- [https://www.inkandswitch.com/patchwork/](https://www.inkandswitch.com/patchwork/) — immutable history and merge as separate from live editing.
- Sibling files: [`07-undo-tree.md`](./07-undo-tree.md), [`03-data-model.md`](./03-data-model.md), [`10-sync-persistence.md`](./10-sync-persistence.md).

---

## ADR-11 — App stack is Next.js (App Router) + bun + TypeScript strict + Better Auth + Convex

**Status:** Accepted. Locks **D14** (app framework, bun, TS strict, ESM) and **D12** (Better Auth, single user, private).

### Context

Recto needs an app framework, runtime/package manager, backend, and auth. It is a private, single-user tool; the only reason it has auth at all is to scope cloud state to one identity ([`README.md`](./README.md) §1). The user has an existing, proven pattern source: `planetaryescape` (Convex + Next.js, Better Auth, bun, strict TS).

### Decision

The stack is **Next.js (App Router)** (mostly client components, SPA feel) + **bun** (runtime & package manager) + **TypeScript strict, ESM only** + **Better Auth** (single-user identity) + **Convex** (backend / reactive sync) ([`README.md`](./README.md) §6).

### Alternatives rejected

- **A different framework/backend/auth combination** (e.g. Vite SPA, a REST/SQL backend, a different auth provider as the default). **Rejected** as gratuitous divergence from the user's battle-tested `planetaryescape` pattern. Clerk is retained only as the documented **fallback** for auth, not the default ([`README.md`](./README.md) §6).
- **pnpm/npm for a fresh scaffold.** **Rejected** — bun is the project default for new scaffolds.

### Rationale

Matching the user's existing Convex + Next pattern source minimizes novelty risk and leans on conventions the user already trusts (retrieval-led, pattern-first). Convex provides the reactive queries and the "always saved, resume anywhere" substrate that the sync design ([ADR-07](#adr-07--sync-is-a-convex-debounced-last-write-wins-snapshot-of-the-canonical-markdown-string)) builds on. Next.js App Router gives an SPA feel with mostly client components, appropriate for an editor where the client owns live state (D11). Better Auth is sufficient for a single private identity; full collaboration auth is a non-goal ([`README.md`](./README.md) §5). Strict TypeScript + ESM is the project default and the language baseline for the whole codebase.

### Consequences

- Convex functions are the **only** write path to persistent state; the editor never writes directly, it calls debounced mutations ([`../plan/README.md`](../plan/README.md) conventions, [`10-sync-persistence.md`](./10-sync-persistence.md)).
- IDs use built-in `crypto.randomUUID()` / ULID for node ids — no `uuid` dependency ([`README.md`](./README.md) §6).
- Tooling: **Biome** for lint/format; scripts run under bun (`bun run dev | typecheck | biome check | test`) ([`../plan/README.md`](../plan/README.md) conventions).
- Foundation work (framework + Convex + Better Auth + dark shell + document CRUD) is **Phase 1** ([`../plan/phase-1-foundation.md`](../plan/phase-1-foundation.md)).

### References

- Sibling files: [`02-architecture.md`](./02-architecture.md), [`03-data-model.md`](./03-data-model.md), [`10-sync-persistence.md`](./10-sync-persistence.md); plan: [`../plan/phase-1-foundation.md`](../plan/phase-1-foundation.md).
- [https://docs.convex.dev/production/state/limits](https://docs.convex.dev/production/state/limits) — Convex platform constraints the app builds within.

---

## ADR-12 — UI is Tailwind v4 + shadcn primitives + OKLCH, dark-only

**Status:** Accepted, **partially superseded**. Locks the styling stack (Tailwind v4 + shadcn + OKLCH). Its dark-only clause — and D13 with it — is reversed by [ADR-20](#adr-20--light-theme-paper-palette--appearance-setting-reverses-d13).

### Context

Recto's identity is *"dark-only, typography-first, bespoke — the type is the UI"* ([`README.md`](./README.md) §1), *"premium and bespoke … not a templated shadcn default"* ([`README.md`](./README.md) §4.6). It needs a styling system and accessible component primitives, but must not look like an off-the-shelf shadcn template.

### Decision

UI uses **Tailwind v4** + **shadcn primitives** + an **OKLCH** color palette, and is **dark-only** — there is no light theme ([`README.md`](./README.md) §6, D13).

### Alternatives rejected

- **Shipping a light theme / theme toggle.** **Rejected at the time** — explicitly a non-goal ([`README.md`](./README.md) §5); dark-only was a locked decision (D13). Building a second palette was scope we deliberately did not take. **Reversed by [ADR-20](#adr-20--light-theme-paper-palette--appearance-setting-reverses-d13)** once plan 023 put Recto on Apple platforms, where appearance is a system axis.
- **Using shadcn defaults as the visual identity.** **Rejected** — the product principle is bespoke, not templated ([`README.md`](./README.md) §4.6). shadcn is used as accessible *primitives*, then restyled.
- **Non-OKLCH color (raw hex/HSL palette).** **Rejected** — OKLCH is the user's convention and gives perceptually-uniform control over a restrained dark palette, which matters for a typography-first dark UI.

### Rationale

Tailwind v4 + shadcn + OKLCH is the user's established convention (consistent with `planetaryescape`), so it is retrieval-led and low-risk. Dark-only halves the design and testing surface and sharpens the product's identity. OKLCH gives perceptually uniform lightness/chroma control, which is exactly what a restrained, premium dark palette needs. shadcn provides accessible primitives (focus management, ARIA) so we get a11y for free, then layer bespoke typography and motion on top so it does not read as a default template.

### Consequences

- Only one palette to design, build, and verify (dark). a11y/contrast is validated against the dark palette only ([`12-design-system.md`](./12-design-system.md)).
- The "bespoke design pass" (typography, layout, motion) is **Phase 5 polish** ([`../plan/phase-5-polish-and-export.md`](../plan/phase-5-polish-and-export.md)); shadcn primitives are restyled rather than used raw.
- Full palette, type scale, layout, motion, and a11y specifics live in [`12-design-system.md`](./12-design-system.md).

### References

- Sibling files: [`12-design-system.md`](./12-design-system.md), [`13-keyboard-commands.md`](./13-keyboard-commands.md); plan: [`../plan/phase-1-foundation.md`](../plan/phase-1-foundation.md), [`../plan/phase-5-polish-and-export.md`](../plan/phase-5-polish-and-export.md).

---

## ADR-13 — Rich-text export is `.html`; `.rtf` is skipped; `.docx` is optional and later

**Status:** Accepted; **amended 2026-07-05** (plan 020). `.docx` shipped via `remark-docx`, and the `html-to-docx` pin below is **superseded**: the original package has been unmaintained since 2023-03, and an HTML-input converter cannot produce real Word footnotes (HTML carries no footnote semantics), whereas `remark-docx` compiles the canonical MDAST directly. The `.rtf` rejection is permanent and unchanged. Detailed in [`11-clipboard-export.md`](./11-clipboard-export.md) §10.

### Context

Recto exports documents. Markdown export (`.md`) is trivial — it is the canonical string. The question is the **rich** export format: what file format do we offer for a styled document that other apps can ingest? The obvious candidates are `.html`, `.rtf`, and `.docx`.

### Decision

Rich export is **`.html`** (rendered from the canonical MDAST via `remark-rehype` + `rehype-sanitize`, the same pipeline as Preview). **`.rtf` is skipped.** **`.docx` is optional and later**, via `html-to-docx` if/when it is wanted ([`11-clipboard-export.md`](./11-clipboard-export.md)). *(The `html-to-docx` path was superseded when `.docx` shipped — see the 2026-07-05 amendment in Status.)*

### Alternatives rejected

- **`.rtf` export.** **Rejected** on two concrete grounds:
  1. There is **no maintained browser-side RTF generator** worth depending on; RTF generation in the browser means hand-rolling or adopting an unmaintained library — neither acceptable per "do it right."
  2. **UTF-16 ↔ 8-bit escaping pain.** RTF's encoding model (control words, `\uN` escapes, code-page handling) makes correct Unicode emission from JS strings (UTF-16) fiddly and error-prone — a poor cost/benefit for a format whose audience HTML already serves.
- **`.docx` now.** **Rejected for v1** — not skipped, just deferred. At the time this assumed `html-to-docx` could convert our exported HTML to `.docx` later with low marginal effort. *(Historical: when `.docx` shipped in plan 020, `remark-docx` replaced that assumption — see Status.)*

### Rationale

`.html` reuses the **exact** Preview pipeline (one renderer, no drift — [`README.md`](./README.md) §6), is universally pasteable/ingestible, and carries the document's structure and styling faithfully. `.rtf` adds a fragile, unmaintained dependency and Unicode-escaping risk for an audience HTML already covers. `.docx` is a reasonable future convenience that piggybacks on the HTML export, so deferring it costs nothing and avoids premature work.

### Consequences

- Export menu offers `.md` (canonical string) and `.html` (Preview pipeline) in v1 ([`11-clipboard-export.md`](./11-clipboard-export.md)).
- A future `.docx` is an additive feature layered on the existing HTML export via `html-to-docx`; no architecture change required. *(Held up: `.docx` landed additively in plan 020 with no architecture change — though from the MDAST via `remark-docx`, not from the HTML.)*
- No RTF code or dependency enters the tree.

### References

- [https://www.npmjs.com/package/remark-docx](https://www.npmjs.com/package/remark-docx) — `remark-docx`; the shipped `.docx` path (2026-07-05 amendment).
- [https://www.npmjs.com/package/html-to-docx](https://www.npmjs.com/package/html-to-docx) — `html-to-docx`; the originally pinned (now superseded) path for `.docx` from exported HTML.
- Sibling files: [`11-clipboard-export.md`](./11-clipboard-export.md), [`06-markdown-dialect.md`](./06-markdown-dialect.md), [`12-design-system.md`](./12-design-system.md); plan: [`../plan/phase-5-polish-and-export.md`](../plan/phase-5-polish-and-export.md).

---

## ADR-14 — Clipboard writes one `ClipboardItem` with `text/html` + `text/plain`

**Status:** Accepted. Detailed in [`11-clipboard-export.md`](./11-clipboard-export.md).

### Context

Copying from Recto must paste correctly into both rich targets (email composers, Google Docs, Notion) and plain targets (other editors, terminals). A "copy" that only carries one representation forces the destination to guess or degrades the paste.

### Decision

Copy writes a **single `ClipboardItem`** to the async Clipboard API carrying **two MIME types simultaneously** — `text/html` (the rich rendering, from the Preview pipeline) **and** `text/plain` (the Markdown / plain text) — each provided as a `Blob`. (A separate "copy as Markdown" action explicitly puts Markdown into `text/plain`.) See [`11-clipboard-export.md`](./11-clipboard-export.md).

### Alternatives rejected

- **Single-representation copy** (only `text/html`, or only `text/plain`). **Rejected** — loses fidelity in whichever target prefers the other representation. One `ClipboardItem` with both types lets each destination pick its best fit.
- **Legacy `document.execCommand('copy')`.** **Rejected** — superseded by the async Clipboard API and `ClipboardItem`, which is the standard, multi-format-capable path.

### Rationale

`ClipboardItem` is designed to hold multiple representations of the same content keyed by MIME type, with values as `Blob`s; providing `text/html` + `text/plain` together is the canonical "rich + plain" clipboard pattern, so every paste target gets the representation it wants without a second copy action.

### Consequences

- **Safari transient-activation caveat.** Safari requires clipboard writes to occur within a user-activation gesture and is stricter about async work between the gesture and the write; the `ClipboardItem` Blobs must be prepared so the write happens within the activation window (in some cases passing a `Promise<Blob>` to satisfy Safari). This is a known, handled caveat documented in [`11-clipboard-export.md`](./11-clipboard-export.md), not a blocker.
- The `text/html` blob is generated by the same `remark-rehype` + `rehype-sanitize` pipeline as Preview and `.html` export ([ADR-13](#adr-13--rich-text-export-is-html-rtf-is-skipped-docx-is-optional-and-later)), so copy fidelity matches preview/export — one renderer, no drift.
- Clipboard + copy-as-markdown are **Phase 5** ([`../plan/phase-5-polish-and-export.md`](../plan/phase-5-polish-and-export.md)).

### References

- [https://developer.mozilla.org/en-US/docs/Web/API/ClipboardItem](https://developer.mozilla.org/en-US/docs/Web/API/ClipboardItem) — `ClipboardItem`; multiple MIME types as Blobs; Safari transient-activation behavior.
- Sibling files: [`11-clipboard-export.md`](./11-clipboard-export.md), [`12-design-system.md`](./12-design-system.md), [`13-keyboard-commands.md`](./13-keyboard-commands.md).

---

## Cross-reference map

| This ADR | Locks / supports | Primary sibling files |
|----------|------------------|------------------------|
| ADR-01 | D1, D2 | [`02-architecture.md`](./02-architecture.md), [`03-data-model.md`](./03-data-model.md), [`05-lossless-bridge.md`](./05-lossless-bridge.md), [`06-markdown-dialect.md`](./06-markdown-dialect.md) |
| ADR-02 | D2 | [`04-editor-modes.md`](./04-editor-modes.md), [`05-lossless-bridge.md`](./05-lossless-bridge.md), [`06-markdown-dialect.md`](./06-markdown-dialect.md) |
| ADR-03 | D3 | [`04-editor-modes.md`](./04-editor-modes.md), [`05-lossless-bridge.md`](./05-lossless-bridge.md), [`07-undo-tree.md`](./07-undo-tree.md) |
| ADR-04 | D4 | [`04-editor-modes.md`](./04-editor-modes.md), [`13-keyboard-commands.md`](./13-keyboard-commands.md), [`07-undo-tree.md`](./07-undo-tree.md) |
| ADR-05 | D10 | [`10-sync-persistence.md`](./10-sync-persistence.md), [`02-architecture.md`](./02-architecture.md) |
| ADR-06 | D10 | [`07-undo-tree.md`](./07-undo-tree.md), [`10-sync-persistence.md`](./10-sync-persistence.md) |
| ADR-07 | D10, D11 | [`10-sync-persistence.md`](./10-sync-persistence.md), [`03-data-model.md`](./03-data-model.md) |
| ADR-08 | D8 | [`07-undo-tree.md`](./07-undo-tree.md), [`03-data-model.md`](./03-data-model.md) |
| ADR-09 | D8, D9 | [`07-undo-tree.md`](./07-undo-tree.md), [`08-version-control.md`](./08-version-control.md) |
| ADR-10 | D8, D10 | [`07-undo-tree.md`](./07-undo-tree.md), [`03-data-model.md`](./03-data-model.md), [`10-sync-persistence.md`](./10-sync-persistence.md) |
| ADR-11 | D12, D14 | [`02-architecture.md`](./02-architecture.md), [`03-data-model.md`](./03-data-model.md), [`10-sync-persistence.md`](./10-sync-persistence.md) |
| ADR-12 | D13 (dark-only clause superseded by ADR-20) | [`12-design-system.md`](./12-design-system.md), [`13-keyboard-commands.md`](./13-keyboard-commands.md) |
| ADR-13 | — | [`11-clipboard-export.md`](./11-clipboard-export.md), [`06-markdown-dialect.md`](./06-markdown-dialect.md) |
| ADR-14 | — | [`11-clipboard-export.md`](./11-clipboard-export.md), [`12-design-system.md`](./12-design-system.md) |
| ADR-15 | D6 | [`05-lossless-bridge.md`](./05-lossless-bridge.md), [`../plan/phase-0-spikes.md`](../plan/phase-0-spikes.md) |
| ADR-16 | D8 | [`07-undo-tree.md`](./07-undo-tree.md), [`10-sync-persistence.md`](./10-sync-persistence.md), [`../plan/phase-0-spikes.md`](../plan/phase-0-spikes.md) |
| ADR-19 | D8, D10 | [`07-undo-tree.md`](./07-undo-tree.md), [`10-sync-persistence.md`](./10-sync-persistence.md), [`03-data-model.md`](./03-data-model.md) |
| ADR-20 | Reverses D13; locks D-N5 | [`12-design-system.md`](./12-design-system.md), [`../../packages/design-tokens/tokens.json`](../../packages/design-tokens/tokens.json) |

---

## ADR-15 — Phase 0 Spike A: live two-mode bridge **confirmed**

**Status:** Accepted (Phase 0 decision gate A, 2026-06-15). Locks **D6** — same document in two simultaneously-editable modes.

### Context

[`../plan/phase-0-spikes.md`](../plan/phase-0-spikes.md) required a throwaway spike proving that Milkdown (rich) and CodeMirror 6 (raw) can edit one remark MDAST bus live, losslessly, without cursor jumps or feedback loops — or select the §12 fallback in [`05-lossless-bridge.md`](./05-lossless-bridge.md).

### Decision

**The production bridge approach ships.** The §12 fallback (switch-on-mode only; same doc not live in two editable modes) is **not** selected.

Measured spike parameters:

| Parameter | Value |
|-----------|-------|
| Throttle window | **50 ms** (trailing + leading; swept 30–60 ms — 50 ms felt seamless in harness) |
| `recreateTransform` package | **`@fellow/prosemirror-recreate-transform@1.2.3`** (current). Phase 0 originally pinned `@manuscripts/prosemirror-recreate-steps@0.1.4` — see migration note below; the `recreateTransform(startDoc, endDoc, opts)` API is identical across both. |
| Rich→raw p50 latency | **< 16 ms** (stringify + prefix/suffix diff + one CM transaction) |
| Raw→rich p50 latency | **< 16 ms** (reparse + `recreateTransform` + one PM transaction) |
| Steady-state no-op | **`next === prev` / `curDoc.eq(nextDoc)` short-circuits fire** — zero transactions when converged |
| Feedback loop | **One `bumpVersion` per human edit; zero echoes** (origin tag + applying guard + version counter) |
| No-drift | **30+ alternating edit cycles** — canonical Markdown byte-identical to `normalize(stringify(parse(...)))` |
| Cursor stability | **Caret preserved** when edit is after caret (rich→raw); **mapped forward** when insert precedes caret (raw→rich) |

### Alternatives rejected

- **§12 fallback (switch-on-mode only).** Rejected — spike latency and cursor behaviour meet the snappy contract; no measured need to relax D6.

### Rationale

Frozen `CANONICAL_STRINGIFY`, minimal text diff (rich→raw), and `recreateTransform` steps (raw→rich) with three overlapping feedback guards produce sub-frame propagation and idle steady state. The heavier raw→rich path remains acceptable at 50 ms throttle.

### Consequences

- Phase 2–3 build the full live bridge from [`05-lossless-bridge.md`](./05-lossless-bridge.md) using these pinned versions.
- Spike harness lives in `spikes/bridge/` (quarantined throwaway); production code lands in Phase 2.

### Migration note — `recreateTransform` package (2026-06)

The original Phase 0 pin, `@manuscripts/prosemirror-recreate-steps@0.1.4`, has been **migrated to `@fellow/prosemirror-recreate-transform@1.2.3`**. The `@manuscripts` package descends from the original `prosemirror-recreate-steps`, which has been unmaintained since 2019; `@fellow` is the healthiest available fork of that lineage. It is itself dormant, but it is the best-maintained option and was parity-verified against the spike behaviour (the `recreateTransform(startDoc, endDoc, opts)` API is byte-for-byte compatible — same options `complexSteps` / `wordDiffs` / `simplifyDiffs`, same step output). The decision to ship the live bridge stands; only the underlying package changed. Current import sites: `lib/bridge/raw-to-rich.ts`, `spikes/bridge/src/bridge/raw-to-rich.ts`.

### References

- Spike code: `spikes/bridge/` · Tests: `spikes/bridge/tests/`
- [`05-lossless-bridge.md`](./05-lossless-bridge.md) · [`06-markdown-dialect.md`](./06-markdown-dialect.md)

---

## ADR-16 — Phase 0 Spike B: cloud undo-tree DAG **confirmed**

**Status:** Accepted (Phase 0 decision gate B, 2026-06-15). Locks **D8** cloud-persisted append-only undo tree.

### Context

[`../plan/phase-0-spikes.md`](../plan/phase-0-spikes.md) required proving union-merge of `docNodes`, LWW `documents.currentNodeId`, materialization from nearest snapshot, and stub additive restore — or select the retention/depth fallback in [`07-undo-tree.md`](./07-undo-tree.md) §8.

### Decision

**The production undo-tree approach ships.** Retention/depth fallback is **not** selected at this time.

Measured spike parameters:

| Parameter | Value |
|-----------|-------|
| Snapshot cadence (spike) | **Every 5 nodes** along a branch (`SNAPSHOT_EVERY_N = 5`) |
| Patch format (spike) | JSON `{ from, to, insert }` — contiguous text delta vs parent's materialized Markdown |
| Union-merge | **Two divergent clients** (`n2 → a3 → a4` vs `n2 → b3`) — server holds **UNION**, zero conflict, both branches coexist |
| Pointer reconciliation | **`documents.currentNodeId` LWW by `updatedAt`** — behind client loses pointer write, **loses no history** |
| Materialization | **`materialize(node)`** replays from nearest `snapshot`; arbitrary branch nodes reproduce exact state |
| Stub restore | **Fork-forward** — appends new node, pre-restore branch remains reachable |
| Storage | **Delta patches ≪ 1 KiB**; history in separate rows; single values well under Convex ~1 MiB ceiling |

### Alternatives rejected

- **Retention/depth cap fallback (§8).** Not needed yet — growth is row-scattered and patches are tiny. Retention policy noted for Phase 4; not blocking.

### Rationale

Append-only immutable `docNodes` union-merge by construction (distinct ULIDs, no row conflicts). Only the pointer is mutable and LWW is acceptable for single-user sequential editing per [ADR-07](#adr-07--sync-is-a-convex-debounced-last-write-wins-snapshot-of-the-canonical-markdown-string).

### Consequences

- Phase 1 commits full schema validators from [`03-data-model.md`](./03-data-model.md); Phase 4 builds visualizer UI.
- Throwaway Convex functions in `convex/` exercise the canon field names; replace with production wiring in Phase 1.
- Spike tests: `spikes/undo-tree/tests/` + `convex.bun.test.ts` (convex-test).

### References

- [`07-undo-tree.md`](./07-undo-tree.md) · [`10-sync-persistence.md`](./10-sync-persistence.md) · [`03-data-model.md`](./03-data-model.md)

---

## ADR-17 — Phase 1 foundation deviations (reconcile in Phase 3–4)

**Status:** Accepted (temporary). Recorded per Plan Definition of Done item 5.

### Context

Phase 1 ships the production app skeleton before `docNodes`, `versions`, `workspaces`, and multi-document UI exist ([`../plan/phase-1-foundation.md`](../plan/phase-1-foundation.md)).

### Deviations

1. **`documents.create` does not insert a root `docNodes` row.** It sets `currentNodeId` to a `crypto.randomUUID()` placeholder; Phase 4 replaces this with a real root node in one transaction.
2. **`documents.remove` is deferred** until Phase 4 (cascade depends on `docNodes` / `versions`).
3. **Single-document UX** — no document switcher; the studio opens the most recent document or empty state until Phase 3.
4. **`documents.userId` is stored as `v.string()`** referencing Better Auth user ids from the component adapter (not `v.id("users")` in the app schema until the users table is co-located).

### Consequences

- Phase 4 must migrate placeholder `currentNodeId` values when introducing the undo-tree.
- History safety net (`docNodes.append`) is unavailable in Phase 1; local draft buffer + debounced `updateMarkdown` satisfy "never lose a word" for a single pane.

### References

- [`../plan/phase-1-foundation.md`](../plan/phase-1-foundation.md) · [`03-data-model.md`](./03-data-model.md)

---

## ADR-18 — shadcn/ui is the component system; compose, don't reinvent

**Status:** Accepted. Supports **D13**, design principle **P3** (premium/bespoke, not stock defaults).

### Context

Recto needs accessible UI primitives (buttons, inputs, dialogs, alerts) without building a bespoke component library from scratch. The blueprint already names shadcn + OKLCH tokens ([ADR-12](#adr-12--ui-is-tailwind-v4--shadcn-primitives--oklch-dark-only)), but did not state the **composition rule** for custom UI.

### Decision

**All UI components use [shadcn/ui](https://ui.shadcn.com/)** as the component system:

1. **Install primitives from shadcn** into [`components/ui/`](../../components/ui/) via `bunx shadcn add <component>`.
2. **Restyle via Recto OKLCH tokens** — map shadcn CSS variables (`--background`, `--primary`, etc.) to the canonical tokens in [`12-design-system.md`](./12-design-system.md) §2.1; never ship stock shadcn defaults in either appearance.
3. **Compose custom UI from shadcn building blocks** — if a needed element has no shadcn component, build it by composing existing primitives (e.g. `Card` + `Alert` + `Button`), not raw HTML with ad-hoc styles.
4. **No parallel component libraries** — no MUI, Radix direct imports in app code (shadcn wraps Radix/Base UI), no one-off styled `<button>`/`<input>` in feature code.

Configuration: [`components.json`](../../components.json) (style: `base-nova`, `@/components/ui` alias).

### Alternatives rejected

- **Hand-rolled components only.** Rejected — duplicates accessibility and interaction work shadcn already solves.
- **Stock shadcn defaults un-themed.** Rejected — violates P3; tokens must be mapped to Recto OKLCH (in both appearances since ADR-20).
- **Multiple UI libraries.** Rejected — inconsistent patterns and bundle weight.

### Consequences

- New UI work starts with `bunx shadcn add …` then token mapping in `app/globals.css`.
- Feature components live in [`components/`](../../components/); primitives stay in `components/ui/`.
- Phase 5 bespoke pass tunes tokens and typography, not the component sourcing strategy.

### References

- [`12-design-system.md`](./12-design-system.md) §6 · [`../plan/phase-1-foundation.md`](../plan/phase-1-foundation.md) G1.3

---

## ADR-19 — one edit is one transaction: `documents.commitEdit`

**Status:** Accepted (2026-08-28). Supports **D8** (branching undo tree), **D10** (LWW pointer, no CRDT), and plan 023's offline outbox for the native clients.

### Context

An edit used to reach Convex as three independent writes:

| Write | Trigger | Debounce |
|-------|---------|----------|
| `docNodes.append` | every grouping commit | none (fire-and-forget) |
| `documents.updateCurrentNodeId` | every grouping commit | 1200 ms |
| `documents.updateMarkdown` | every editor change | 500 ms (5 s maxWait) |

Nothing ordered them. Between the node landing and the pointer landing, the
server sat in a state no client had ever intended — the node present, the head
still on its parent — and `updateMarkdown` could advance `documents.updatedAt`
in that window without touching `currentNodeId`. A client watching its own
reactive `documents.get` then saw a stale pointer wearing a fresh timestamp,
read it as another device's move, and rolled its own pointer backwards onto an
ancestor. The next undo went a level too far, usually to the empty root; the
editor blanked and autosync flushed `""` (plan 022).

The native apps make this worse, not better: an offline outbox replays commits
after a reconnect, so partial application and retried writes stop being edge
cases.

### Decision

**One edit is one mutation.** `documents.commitEdit` writes the `docNodes` row,
`currentNodeId`, `markdown`, `wordCount` and `updatedAt` in a single Convex
transaction:

```ts
commitEdit({ documentId, node, markdown, wordCount, expectedHeadNodeId, clientMutationId })
  -> { committed: true, headNodeId, updatedAt }
   | { committed: false, diverged: true, remoteHeadNodeId }
```

1. **The node row always lands**, head check or not. The DAG is append-only and
   ULID-keyed, so a node is never in conflict — only the pointer is contended,
   and dropping the row would lose the writer's text.
2. **`expectedHeadNodeId`** is the parent the caller committed onto. If the
   document head has moved, the pointer and markdown are left untouched and the
   caller is told the remote head. LWW is preserved but is now *explicit* rather
   than an accident of write ordering.
3. **Retries are idempotent** two ways: the same `clientMutationId` replays the
   stored answer (`documents.lastCommit`), and a commit whose node is already
   the head returns success rather than a spurious divergence. This obliges the
   caller to be **strictly sequential**: retry a commit until it is
   acknowledged before sending the next one. `lastCommit` holds a single
   mutation id, so an outbox that pipelines commits and later replays an older
   one — node landed, head since advanced — is told `diverged` instead of
   replaying its original answer. Widening that means a per-document log of
   recent mutation ids; nothing needs it yet, and the native outbox (N4) is
   sequential by design.
4. **Clients never adopt a server pointer that predates their own unpublished
   move** (`decideServerPointer` in `lib/history/use-document-history.ts`).
   The transaction removes the intermediate state; this guard covers the
   remaining in-flight and not-yet-echoed windows.

   Observations are ordered by **`documents.pointerRevision`**, a monotonic
   counter every pointer write bumps — not by `updatedAt`. Two writes can share
   a millisecond, and a markdown-only write advances `updatedAt` without moving
   the pointer at all, which is exactly what made a stale pointer look fresh.

6. **Projection is one operation, owned by the history hook.** Adopting a remote
   pointer moves the editor text, the grouping controller and the pointer
   together (`reconcileRemote`), because it used to move the pointer while the
   editor kept showing the old text and the sync hook re-seeded on a separate
   path. `use-document-sync` calls into it instead of seeding, and does not mark
   a server revision handled until the projection has actually happened.

7. **Reconciliation is gated on idleness, not focus.** In vim and full-screen the
   editor never gives up DOM focus, so a focus-gated adoption would never fire.
   Remote state is projected when the grouping controller holds no uncommitted
   draft and the editor has been quiet for 2s; a blur is an extra trigger, not
   the condition. The caret is restored by clamped offset and the writer is told
   ("Updated from another device") — state changing under them silently is worse
   than the interruption.

8. **A draft is only ever retired by a completed projection.** An autosave with
   no known head does not flush at all (there is nothing to compare against),
   and a rejected `headMoved` write leaves the draft dirty. Discarding local
   text before something has replaced it is the one outcome worse than a stale
   save.

5. **`documents.updateMarkdown` takes an optional `expectedHeadNodeId`.** It
   stays as the sub-node draft saver (it persists text between node commits and
   derives the title), but its stale-`updatedAt` retry loop would otherwise
   republish one device's draft on top of whichever branch won a divergence,
   leaving `documents.markdown` detached from `documents.currentNodeId`. When
   the head has moved it returns `{stale: true, headMoved: true}` and writes
   nothing; the client stops retrying and lets pointer adoption re-seed. The
   argument is optional so a client deployed before this ADR keeps working.

`documents.updateCurrentNodeId` stays for pointer-only moves — undo, redo,
branch switch — which create no node.

Size limits are measured in **UTF-8 bytes**, and a `docNodes` row is measured as
patch + snapshot together: Convex counts encoded bytes for the whole document,
so `"漢".repeat(400_000)` is 400k characters and 1.2 MB.

### Deployment window

For as long as a tab loaded from the previous deploy stays open, that tab sends
no `expectedHeadNodeId` and still moves the pointer through last-write-wins
`updateCurrentNodeId`. It can therefore still write markdown under a head
another device has moved on from — the exact case the compare-and-set exists to
stop. The guard cannot be enforced until every client sends the argument, and
making the argument required would break those tabs outright.

What makes that window survivable is **provenance**, not the guard.
`documents.markdownHeadNodeId` records which head the stored markdown was
written against; a headless legacy save CLEARS it. So other devices can tell the
two cases apart:

| `markdownHeadNodeId` | What the reader may do |
|---|---|
| equals the head, `updatedAt` newer than the reader's baseline | trust it: a draft saved ahead of the last node, project it and let the writer's next edit turn it into a child node |
| absent (legacy headless save) or naming a different head | distrust it: project `materialize(head)` instead and never promote that text into the DAG |

Without the stamp, a projection could take text a legacy tab left under someone
else's branch and commit it as a child of the current head — inventing history
that never happened. With it, the worst a legacy tab can do is leave
`documents.markdown` temporarily describing a head it does not belong to, which
the next projection overwrites and which the `docNodes` DAG never reflects.

Once the new client has been deployed for a week, `updateMarkdown` should reject
headless saves outright. That is a follow-up, deliberately not in this change.

### Alternatives rejected

- **Keep three writes, order them client-side.** Rejected — ordering promises
  across three fire-and-forget calls is exactly what failed, and it gives the
  native outbox nothing to retry against.
- **Adopt the server pointer only if it is not an ancestor of the local one.**
  Clock-free and tempting, but it silently breaks cross-device undo: a genuine
  remote undo moves the pointer to an ancestor and would be ignored forever.
- **Version the pointer with a Lamport counter.** More machinery than the
  problem needs; `expectedHeadNodeId` already names the causal predecessor.

### Consequences

- One mutation per commit instead of two, and the pointer is no longer debounced
  — a commit is already a ~500 ms grouping boundary, so this removes writes
  rather than adding them.
- `documents.lastCommit` is an additive optional field; rows written before this
  ADR have none and take the normal path.
- The native offline outbox has a single call to replay, with a defined answer
  for "someone else moved the head while I was away".
- A client that decides to adopt a remote pointer may not be able to apply it
  yet — the writer is mid-sentence, or the node has not synced. It must QUEUE
  it and reconcile at the next safe moment (blur, or a commit coming back
  diverged). Dropping it was survivable before; with the head check it is not,
  because a focused writer would then diverge on every commit with no way back.
- A device that loses a head divergence stands down from autosave entirely
  until the projection lands: its editor still holds ITS text, so passing the
  compare-and-set would write that text under the winner's branch. The head the
  autosave compares against is therefore tied to what the editor and controller
  actually hold, and only a completed projection moves it.
- A projection prefers `documents.markdown` over `materialize(head)` when the
  two differ at the same head. That difference IS another device's autosaved
  draft, sitting ahead of its last node and existing nowhere else; projecting
  the node's text would erase it. The grouping controller stays on the node, so
  the writer's next keystroke turns that draft into an ordinary child node.
- A projection may also fire when the pointer has NOT moved: another device
  saving a newer trusted draft against the same head is a change this device
  must show. Treating an unchanged pointer as "nothing to do" left the writer
  looking at stale text with no event that would ever correct it.
- Rescued remote text is held as an OPEN grouping draft, not as silent editor
  content. Every path that leaves the state — undo, branch switch, version tag,
  mode switch — flushes first, so the draft becomes a real node instead of being
  discarded by the navigation that follows.
- A surface that cannot hold text (the preview lens, whose `seed` is a no-op)
  must DEFER a projection rather than complete one. Advancing the pointer
  against it would leave the tree asserting a projection no editor received.
- **First open goes through the same rule.** The sync hook seeds a recovered
  localStorage draft (this writer's own unsaved work always wins) but not plain
  server markdown: it has no DAG, so it cannot tell a trustworthy draft from a
  legacy body. Hydration decides, once, with the tree in hand — local input,
  then a stamped same-head draft as an OPEN grouping draft, then the head's
  materialization. Skipping this let an unstamped body sit in the editor over a
  controller rooted at the materialization, so the next edit committed it as a
  child of a head it never belonged to.
- **"What the editor shows" is not the compare-and-set token.** The CAS token
  advances when a remote update is DEFERRED, so a later save can still land.
  Reading it as the projection baseline made a deferred update look
  already-seen, and the retry then projected the node text over the draft it
  had been deferring. They are separate refs.
- Deferred: same-head last-writer-wins between two devices' drafts. Two writers
  typing past the same node still overwrite each other's `documents.markdown`;
  that wants a per-device draft model, not a bigger guard here.
- Deferred: a bounded reconciliation-failure state with a "keep local branch"
  recovery, for a client that can never project (no writable lens for a long
  period, or a node that never syncs). Today it retries indefinitely and holds
  autosave; that is safe but silent. Worth doing once legacy clients age out.
- Deferred: a pending-conflict indicator. A writer whose autosave has stood
  down currently sees only the "unsynced" status. Their text is safe and the
  projection recovers it, but they are not told why saving paused.
- Deferred: pre-hydration keystrokes that `use-document-sync`'s seed overwrites
  are still lost (the pre-existing early-input papercut). The undo tree stays
  consistent with the editor — nothing is committed that the writer cannot see
  — but the honest fix is for the seed to stand down once local input exists.
- Deferred: `commitEdit` does not yet verify that `applyPatch(head, node.patch)`
  equals the submitted `markdown`. It cannot while `updateMarkdown` may leave
  `documents.markdown` ahead of `currentNodeId`'s materialization. Once the web
  is fully off `updateMarkdown`, that check makes the server authoritative over
  DAG integrity.

### References

- [`07-undo-tree.md`](./07-undo-tree.md) §5.1, §7 · [`10-sync-persistence.md`](./10-sync-persistence.md) · [`03-data-model.md`](./03-data-model.md)
- [`../../plans/022-undo-pointer-race.md`](../../plans/022-undo-pointer-race.md) · [`../../plans/023-native-apple-apps.md`](../../plans/023-native-apple-apps.md) §4.1
- [ADR-10](#adr-10--cloud-persisted-undo-tree-is-tractable-because-docnodes-are-append-onlyimmutable) — the append-only DAG and LWW pointer this makes explicit.

---

## ADR-20 — Light theme: Paper palette + appearance setting, reverses D13

**Status:** Accepted (2026-08-28). **Reverses D13** ("Dark only. No light theme") and supersedes the dark-only clause of [ADR-12](#adr-12--ui-is-tailwind-v4--shadcn-primitives--oklch-dark-only). Locks **D-N5** of [`../../plans/023-native-apple-apps.md`](../../plans/023-native-apple-apps.md).

### Context

D13 was taken when Recto was a web app with one designed surface. Plan 023 takes Recto native to macOS, iPadOS and iPhone, where the appearance is a system-level axis: Apple apps are expected to follow Light/Dark, the asset catalog is built around the pair, and an app that ignores it reads as a port rather than a Mac app. The same plan also moves the palette to a shared token source consumed by both web and native ([`../../plans/023-native-apple-apps-design.md`](../../plans/023-native-apple-apps-design.md) §5), so the appearance decision has to be taken once, for both.

The web side had also accumulated the cost of the assumption: a hard-coded `className="dark"` on `<html>`, hairline shadows authored as pure black, and a `prefers-color-scheme` that was deliberately ignored.

### Decision

Recto ships **two designed palettes as a launch pair**:

- **Twilight** — the existing dark palette, values unchanged.
- **Paper** — a new light palette: a warm near-white canvas (hue 85) under hue-285 ink, the same structure and the same accent hue as Twilight, with lightness inverted and the semantic colours darkened until they measure AA on paper.

An **appearance** setting (`system` · `light` · `dark`, default `system`) is device-local, sits beside the palette picker in the status bar and in the command palette, and resolves to a `dark` class on `<html>` written by a blocking script before the first paint. Aurora, Dawn and Moonlit remain **dark-only** and are offered only while the appearance resolves to dark; they get designed light twins later, or not at all.

Both palettes come from one source, [`packages/design-tokens/tokens.json`](../../packages/design-tokens/tokens.json), built with Style Dictionary into the CSS custom properties `app/globals.css` imports, an `Colors.xcassets` catalog, `RectoTokens.swift`, and an sRGB hex table for widgets that cannot parse OKLCH (Clerk). Contrast is asserted numerically in `packages/design-tokens/tokens.test.ts` for both appearances; a staleness test fails if the committed outputs drift from the JSON.

### Alternatives rejected

- **Keep D13 on the web, ship light only on native.** Rejected — two palettes and two design systems, and the token package exists precisely so there is one. The web is where the palette is authored and reviewed.
- **Invert Twilight algorithmically.** Rejected — an inverted dark palette reads grey and dirty on paper: black shadows become smudges, the accent loses its glow role, and the semantics fall below AA. Paper is authored, not computed.
- **Light twins for all four palettes.** Rejected for launch — one designed light palette beats four undesigned ones (plan 023 orchestration §0).
- **`next-themes`.** Rejected — it keeps the appearance under its own storage key and React context, so the preference would live in a second store beside `recto:studio-settings`. What it adds over that cost is the eight-line blocking script in [`../../lib/studio/appearance.ts`](../../lib/studio/appearance.ts).

### Consequences

- `app/layout.tsx` no longer forces `dark`; it injects the appearance script and `suppressHydrationWarning`.
- Anything authored as "dark-only" is now a token: panel and toolbar shadows (`--elevation-*`), the reduced-transparency scrim (`--scrim-opaque`), and the film grain's blend mode and opacity (`--grain-*`), which is `multiply` on paper because `soft-light` is invisible at 0.99 L.
- A new token, `--color-on-accent`, carries text on an accent fill, authored **per palette**: light ink over the mid-lightness `accent-muted` fill measures 2.36–3.15:1 across the four dark palettes, so each one uses its own canvas colour (5.02–6.96:1) and Paper uses near-white (7.92:1). shadcn's `--primary-foreground` / `--accent-foreground` / `--sidebar-primary-foreground` map to it.
- Clerk's widgets follow the resolved appearance from the generated hex table; the stale coral palette is gone.
- Every future palette change goes through `tokens.json` + `bun run tokens:build`, never by editing `globals.css`.
- The design system's P4 ("dark only") is retired; §2.5 contrast targets now apply to both appearances.

### References

- [`../../plans/023-native-apple-apps.md`](../../plans/023-native-apple-apps.md) §5, D-N5 · [`../../plans/023-native-apple-apps-design.md`](../../plans/023-native-apple-apps-design.md) §2, §5 · [`12-design-system.md`](./12-design-system.md) §2 · [`packages/design-tokens/`](../../packages/design-tokens/)
- [Style Dictionary](https://styledictionary.com/) · [Apple HIG — Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode) · [WCAG 2.2 SC 1.4.3 / 1.4.11](https://www.w3.org/TR/WCAG22/)


---

## ADR-21 — Settings and workspaces on Convex; account deletion

**Status:** Accepted (2026-08-28). Implements plan 023 §4.1 items 2–6; supports **D-N2** (native owns data) and **D-N4** (additive backend before the native beta). Required by App Store guideline **5.1.1(v)**.

### Context

Three things the web could get away with as a single-client app stop working the moment a Mac, an iPad and an iPhone hit the same backend:

1. **Settings lived only in `localStorage`.** Signing in on a new machine meant setting up the studio again from scratch — 23 toggles, every one of them a decision the writer already made once.
2. **`workspaces` was one row per user.** Fine with one browser. With three devices it becomes a fight: each device writes its own pane tree on every focus change and stomps the others, and a Mac's four-way split is not a layout an iPhone can render anyway.
3. **There was no way to delete an account.** Guideline 5.1.1(v) requires an in-app path that deletes the account itself — not just its data, and not a "email us" link. Without it the iOS app cannot ship.

Two smaller gaps came from the same direction: an offline-created document has no way to be created idempotently once the network returns, and the native apps have no Markdown-to-`.docx` pipeline and should not grow a second one that drifts from the web's.

### Decision

**1. `settings` is one opaque JSON object per user.** `settings.get` / `settings.save {json, expectedUpdatedAt?}`, validated as a JSON *object* (`v.string()` accepts `""`), capped at 64 KiB of UTF-8. The server never looks inside, so adding a setting needs no migration. The price is that the server cannot merge two devices' writes, so the client does that work:

- **Every push is compare-and-set.** The hook tracks which settings *this device* changed and has not had accepted, each with the revision it was at when the request went out. On a lost CAS it takes the winner's values for everything else, keeps the writer's own change, and writes again on top of the winner's stamp. An unconditional whole-object write is how a tab left open overnight silently reverts a week of settings from another device the moment someone toggles one thing in it.
- **An acknowledgement only clears what was actually sent.** A save carries a snapshot of the values at the moment it left; if the writer changes one of those keys while the request is in flight, the acknowledgement covers the *old* value. Comparing revisions clears only the keys the server really received, and the rest are flushed again.
- **A failed save is retried, not dropped, and the work survives a reload.** Offline or rejected, the dirty keys stay dirty, a backoff timer re-sends them, and the key set is persisted to `recto:settings-dirty`. The backoff gives up after six attempts, but a later change or an `online` event resets it — a retry loop that stops permanently is how a laptop that was offline at bedtime is still holding the change at breakfast.
- **Unknown properties are carried through untouched** (`pickUnknown` / `serializeSynced`). `SYNCED_KEYS` is compiled from the running build's `DEFAULTS`, so an older web client's idea of "the whole object" is missing every setting a newer native client added; writing that back would delete them for every device. Chosen over making `save` a server-side key patch because the offline path already forces key-level reasoning on the client, and this keeps the whole-object contract W10–W12 were given.

`updatedAt` is strictly increasing so two saves in one millisecond cannot share a stamp and let a stale CAS pass.

**2. Not every setting syncs.** The split is by whether a setting is about the **writer** or about the **screen in front of them**. `appearance`, `readingScale`, `topToolbar` and `outlineOpen` stay on the device; the other nineteen sync. The full table and its reasoning are in [`10-sync-persistence.md`](./10-sync-persistence.md) §8. `appearance` and `theme` land on opposite sides on purpose — `appearance` answers "is this room dark right now" and already defaults to following the OS, while the palette is taste and taste travels.

**3. `workspaces` is keyed by `(userId, deviceId)`,** with `deviceClass` (`mac` | `ipad` | `iphone` | `web`) and an opaque `json` layout. "Resume from &lt;device&gt; layout" is an explicit query (`workspaces.listForUser` → `workspaces.getForDevice`), never an implicit overwrite. Device rows are capped at 32 per user, least-recently-updated evicted, because a cleared browser mints a new id.

**4. `account.deleteEverything` is an action driving bounded internal mutations, fenced by a tombstone.**

Deletion cannot be one transaction: it is a loop of bounded mutations with an HTTP call to Clerk in the middle, and the user's JWT stays valid throughout. So the order is:

0. **Wait out signed upload URLs from the previous backend, then verify Clerk can see this user.** The first hourly cutover cron records when the old protocol stopped issuing direct storage URLs; deletion stays unavailable for their one-hour maximum lifetime. A secret belonging to the wrong Clerk instance answers 404 to every call, and a version of this that skipped the probe purged the data and then reported `clerkUserDeleted: true` for a user that key had never known. If either check fails, nothing is deleted and nothing is written.
1. **Write an `accountDeletions` tombstone.** While it exists, every user-facing mutation for that user refuses (`convex/accountGuard.ts`, enforced in `documents.requireUserId` and `review.requireDocumentAccess` — the two places that resolve an identity). Without it, a tab left open on another machine or a native client draining an offline outbox recreates rows *behind* the purge — `settings.save`, `workspaces.saveForDevice`, `documents.create` — owned by an account nobody can reach or delete. Reads stay allowed: the deleting client's own UI is still rendering, and a read cannot resurrect anything.
2. **Blobs, then rows**, in batches (64 blobs, 256 rows). Rows are not touched until the blob phase reports `done`, and a phase that hits its pass cap throws rather than letting the deletion proceed — files the purge has not reached are still fetchable by anyone holding their bearer URL.
3. **The Clerk user, last.** Every step before it is idempotent, so a failure anywhere leaves an account that can still sign in and press the button again. Deleting the identity first strands the data with nobody able to reach it.
4. **A final purge**, catching anything that landed between the last pass and the identity going away.

The tombstone's `phase` (`blobs` → `rows` → `identity` → `purged`) is also what tells a legitimate 404 from Clerk (a retry after the user was already deleted) apart from a wrong-instance 404: only from `identity` onward has this deployment ever asked Clerk to delete the user. It is retained for 24 hours after the deletion finishes — a Clerk session token is valid for 60 seconds past the user's deletion, and a queued mutation can still land in that window — then swept by a daily cron.

Three properties make the continuation safe. The `resumeDeletion` job is scheduled **inside the transaction that writes the tombstone**, so "the account is fenced" and "something will finish it" commit together — scheduling it from the action left a crash window with neither, and stacked another job on every retry. Phases are **monotonic**: an older overlapping run cannot write `rows` over `purged` and un-finish a deletion that other jobs have already observed as complete. And the final sweep after the Clerk call **must report done for both rows and blobs**; if either hits its pass cap the phase stays `identity` and the action throws, so the continuation retries rather than the tombstone starting to expire over unfinished work.

Every step that could recreate state is fenced, including the ones that authenticate outside the guarded helpers: `files.claimUpload` and `files.registerExport` both check the tombstone, because `export.docx` authenticates before rendering and rendering can take long enough for a whole deletion to run underneath it.

`CLERK_SECRET_KEY` is checked before all of this: data gone with the login still alive is the one outcome worse than not deleting.

**4b. Blob ownership is recorded by the server, not inferred, and not split across a round trip.** The `blobs` table maps `storageId → {ownerUserId, kind}`. `_storage` rows carry no owner, and the obvious substitute — "whose markdown mentions this URL" — is wrong three ways: it deletes another user's file the moment a URL is shared between documents, it misses images referenced only from `docNodes` history, and it misses generated `.docx` exports entirely because nothing references those. It also cost a full scan of every document plus the whole `_storage` table on every pass, which is how a purge blows the 16 MiB / 32k-document transaction limits and stops being resumable.

Recording it needs the file and its owner to land together. The first version had the client ask for a signed URL, POST the bytes to storage, then call a mutation to claim the result — and the file exists from the moment that POST returns, so a crash, a closed tab, a refused mutation, or simply a browser tab still running the older code left a file nothing could attribute. **Uploads now go through a `POST /upload-image` HTTP action** (`convex/http.ts`) that stores the bytes and claims them in one server-side step, and deletes what it just stored if the claim is refused. For older tabs, `files.generateUploadUrl` returns a one-hour capability for `/upload-image-legacy`, which does the same atomic claim and checks the deletion tombstone. The cutover fence covers direct signed URLs issued by the previous backend before this code deployed.

Ownership alone still cannot answer "is anyone else pointing at this file?", and deleting a blob another user's document references would break their document. `blobRefSources` stores the exact tokens in each document/history row, and `blobRefs` keeps one counted aggregate per `(token, owner)`. Every document and node write updates both in the same transaction. `purgeBlobs` therefore queries only the target file's tokens at deletion time: global corpus size cannot disable deletion, and a reference committed after an earlier migration page is still visible. A file another account references keeps its bytes, loses its ownership row, and is reported separately from deleted files. `purgeUnattributedBlobs` uses the same live index to reclaim pre-server-mediated uploads only this account references.

`migrations.backfillBlobOwners` attributes pre-existing files, and deliberately leaves a file referenced by more than one user unattributed rather than guessing. It is fed by `scanDocumentRefs` / `scanNodeRefs`, which build the permanent reference index in cursor pages capped by both rows and bytes, with progress in `migrationProgress`. `cleanupBlobRefs` remains as a no-op for older runbooks.

**4c. Suggestion nodes are attributed and purged one document at a time.** A reviewer's nodes live in the document OWNER's `docNodes` rows, so nothing keyed to the reviewer reaches them; `docNodes.authorUserId` (indexed `by_author_document`) is what makes them findable.

The decision is structural, not branch-status based. Full and partial acceptance write a new owner-authored merge snapshot, so accepted text survives there. Reviewer nodes not on the owner's current ancestor chain are deleted; this avoids preserving rejected hunks merely because the branch was marked `accepted`. A reviewer node on the ancestor chain stays because the owner may have navigated onto it and typed from there, making it load-bearing.

Every node that is kept is de-attributed on the spot (`authorUserId` and `branchId` cleared, origin rewritten to `review:deleted-user`), removing the departed user's id and ensuring later passes do not reconsider it.

Work is bounded by **one document per pass**. The authored-node page is byte-bounded, and the ancestor walk checks live transaction metrics with reserved query/byte headroom. If the walk cannot finish safely, the page is kept and de-attributed; every pass still makes progress. `migrations.backfillNodeAuthors` fills `authorUserId` from the existing `review:<userId>` origin. `backfillNodeBranches` remains for the stored branch metadata but deletion no longer depends on it.

**5. `documents.create` takes an optional `documentUuid`.** A second call with the same uuid returns the first call's document and root node instead of a duplicate holding the same text. Scoped per user (`by_user_uuid`). `documents.rootNodeId` is stored so a replay can hand the root back without walking the history.

**6. `export.docx` is a `"use node"` action running the web's renderer.** `lib/export/docx-render.ts` is imported by both `lib/export/docx.ts` (browser, Blob + download) and `convex/export.ts` (server, Convex storage + a URL the scheduler deletes after 15 minutes). `.md` and `.html` stay local on both platforms — they are string transformations of text the client already holds.

### Sign in with Apple: detected, not revoked

`deleteEverything` reports an `appleRevocation` status and **does not perform TN3194 revocation**. Two inputs are missing and neither is a matter of writing more code:

- **The Apple signing credentials.** `POST https://appleid.apple.com/auth/revoke` needs a `client_secret` JWT signed ES256 with the team's `.p8` key. Team ID, Services ID, Key ID and the key itself are Apple Developer credentials; none are on this deployment, and Clerk never holds them either.
- **A token to revoke.** Clerk's `OauthAccessToken` object has no `refresh_token` field for any provider, and what `GET /users/{id}/oauth_access_tokens/oauth_apple` returns for an Apple account is unverified — Sign in with Apple is not yet enabled on the Clerk instance (W5, N0a).

And deleting the Clerk user does not cover it: Clerk's own Sign in with Apple guide states that deleting the user "does not reset this on Apple's side." So the action detects an Apple external account and reports exactly what stopped it, rather than implying a revocation that did not happen. **This is a release blocker for the iOS build** (plan 023 §10).

### Alternatives rejected

- **A column per setting.** Rejected — the settings shape changes with almost every feature, so it would mean a schema migration each time, plus a window where a native client that knows a key the server does not has that key silently dropped.
- **Sync every setting.** Rejected — it lets a desk at midnight force dark mode on a phone in daylight, and a 1.6× zoom calibrated for a phone onto a 27" monitor.
- **A second table for device workspaces.** Rejected — the legacy row and the device rows are the same concept at two points in a migration, and two tables would leave permanent dead weight. The legacy columns are optional and clearly marked instead.
- **Unconditional (non-CAS) settings pushes.** Rejected. The first cut of this used plain LWW on the grounds that a lost CAS would mean discarding the writer's most recent change — but that is only true if the client resolves a conflict by taking the winner wholesale. Merging per key (the winner's values for everything this device did not touch, the local value for what it did) keeps the writer's change *and* stops a stale tab reverting another device.
- **Deleting the Clerk user first.** Rejected — it strands the data with nobody able to reach it. The chosen order can leave an empty-but-live account, which is recoverable; the other cannot.
- **Relying on the JWT expiring instead of a tombstone.** Rejected — the window is short but real (a Clerk session token is valid for 60 seconds), an offline outbox can replay into it, and the failure is silent: rows owned by an account that no longer exists, invisible to every UI and to the purge that already ran.
- **Inferring blob ownership from markdown references.** Rejected — see 4b. It is wrong in both directions (deletes shared files, misses history-only and generated files) and unbounded in cost.
- **Shipping ES256 client-secret signing anyway.** Rejected — crypto that has never run against a real Apple account, for a provider that is not configured, would read as done and be discovered broken by a rejected app review.
- **Rendering `.docx` in the Convex default runtime.** Not possible: remark-docx compiles OOXML through `docx`/`jszip`, hence `"use node"`.

### Consequences

- The deployed web client keeps working through the deploy: `workspaces.get/save` still serve the legacy row, now found by scanning the user's rows rather than `.unique()` on `by_user` — which would throw the moment a device row exists, inside the old client's own save.
- Each migrating browser reads the legacy row exactly once, to seed its device row. Nothing writes it again. Removing it is a follow-up, not part of this change.
- `lib/studio/use-studio-settings.ts` is now the hook and the action surface only; the shape, defaults and coercion moved to `lib/studio/settings-schema.ts` so the sync layer can validate a blob written by another device. All previous exports are re-exported, so no consumer changed.
- Hydration must not run in the same commit as the first push, or the device sends its pre-hydration settings straight back over the server's. `useSettingsSync` tracks hydration in state, not a ref, for exactly that reason.
- `convex/files.ts:deleteStoredFile` checks the row before deleting: `ctx.storage.delete` throws "Delete on non-existent doc" for a file that is already gone, and an expiry can fire after the account purge removed the same blob.
- The account purge resolves storage references through the permanent index, including `documents.markdown` and `docNodes` history. The backfill pages are capped by rows and bytes; request-path writes keep it current afterwards.
- Deployment needs `CLERK_SECRET_KEY` in the Convex environment (both dev and prod). Without it `account.deleteEverything` refuses up front and deletes nothing.
- After deploy, run `files:startLegacyUploadCutover` once (the hourly cron is a backstop) and wait until its returned `safeAfter` before enabling account deletion. Then run the six migration commands in order: `backfillNodeAuthors`, `backfillNodeBranches`, `scanDocumentRefs`, `scanNodeRefs`, `backfillBlobOwners`, `cleanupBlobRefs`. Each is idempotent and resumable; `cleanupBlobRefs` is now a compatibility no-op because the reference index is permanent. Until the reference scans finish, deletion is correct for new writes and conservative for older rows.
- Image uploads now go to `POST {NEXT_PUBLIC_CONVEX_SITE_URL}/upload-image` with a Convex-templated Clerk JWT, not to a signed storage URL. That is a different origin from the app, so the route answers a CORS preflight.
- Storage tokens are extracted by one function (`convex/storageTokens.ts`) on both sides of every comparison. Deriving one side with `new URL(url).pathname.split("/").pop()` and the other with a regex looks equivalent and is not — a token containing `/` is truncated by the split and kept whole by the regex, and the two then never match.
- `docNodes.origin` is no longer the only reviewer attribution; `authorUserId` is the indexed one, and `review.listOpenBranches` still reads the origin string for labelling. A kept-but-de-attributed node carries `review:deleted-user`.
- The upload path calls `files.registerUpload` instead of the `files.getImageUrl` query. Same single round trip; it now records ownership and returns the URL.

### References

- [`../../plans/023-native-apple-apps.md`](../../plans/023-native-apple-apps.md) §4.1, §10 · [`03-data-model.md`](./03-data-model.md) §1.2, §3.4–§3.6 · [`10-sync-persistence.md`](./10-sync-persistence.md) §8 · [`11-clipboard-export.md`](./11-clipboard-export.md)
- [App Store Review Guideline 5.1.1(v)](https://developer.apple.com/app-store/review/guidelines/#data-collection-and-storage) · [Apple TN3194 — Handling account deletions and revoking tokens for Sign in with Apple](https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple) · [Clerk Backend API — Delete user](https://clerk.com/docs/reference/backend-api/tag/Users#operation/DeleteUser)
