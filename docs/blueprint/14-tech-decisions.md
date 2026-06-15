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

**Status:** Accepted. Locks **D13** ("Dark only. No light theme") and the styling stack.

### Context

Recto's identity is *"dark-only, typography-first, bespoke — the type is the UI"* ([`README.md`](./README.md) §1), *"premium and bespoke … not a templated shadcn default"* ([`README.md`](./README.md) §4.6). It needs a styling system and accessible component primitives, but must not look like an off-the-shelf shadcn template.

### Decision

UI uses **Tailwind v4** + **shadcn primitives** + an **OKLCH** color palette, and is **dark-only** — there is no light theme ([`README.md`](./README.md) §6, D13).

### Alternatives rejected

- **Shipping a light theme / theme toggle.** **Rejected** — explicitly a non-goal ([`README.md`](./README.md) §5); dark-only is a locked decision (D13). Building a second palette is scope we deliberately do not take.
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

**Status:** Accepted. Detailed in [`11-clipboard-export.md`](./11-clipboard-export.md).

### Context

Recto exports documents. Markdown export (`.md`) is trivial — it is the canonical string. The question is the **rich** export format: what file format do we offer for a styled document that other apps can ingest? The obvious candidates are `.html`, `.rtf`, and `.docx`.

### Decision

Rich export is **`.html`** (rendered from the canonical MDAST via `remark-rehype` + `rehype-sanitize`, the same pipeline as Preview). **`.rtf` is skipped.** **`.docx` is optional and later**, via `html-to-docx` if/when it is wanted ([`11-clipboard-export.md`](./11-clipboard-export.md)).

### Alternatives rejected

- **`.rtf` export.** **Rejected** on two concrete grounds:
  1. There is **no maintained browser-side RTF generator** worth depending on; RTF generation in the browser means hand-rolling or adopting an unmaintained library — neither acceptable per "do it right."
  2. **UTF-16 ↔ 8-bit escaping pain.** RTF's encoding model (control words, `\uN` escapes, code-page handling) makes correct Unicode emission from JS strings (UTF-16) fiddly and error-prone — a poor cost/benefit for a format whose audience HTML already serves.
- **`.docx` now.** **Rejected for v1** — not skipped, just deferred. `html-to-docx` can convert our exported HTML to `.docx` later with low marginal effort, so there is no reason to build it before it is needed.

### Rationale

`.html` reuses the **exact** Preview pipeline (one renderer, no drift — [`README.md`](./README.md) §6), is universally pasteable/ingestible, and carries the document's structure and styling faithfully. `.rtf` adds a fragile, unmaintained dependency and Unicode-escaping risk for an audience HTML already covers. `.docx` is a reasonable future convenience that piggybacks on the HTML export, so deferring it costs nothing and avoids premature work.

### Consequences

- Export menu offers `.md` (canonical string) and `.html` (Preview pipeline) in v1 ([`11-clipboard-export.md`](./11-clipboard-export.md)).
- A future `.docx` is an additive feature layered on the existing HTML export via `html-to-docx`; no architecture change required.
- No RTF code or dependency enters the tree.

### References

- [https://www.npmjs.com/package/html-to-docx](https://www.npmjs.com/package/html-to-docx) — `html-to-docx`; the path for optional, later `.docx` from exported HTML.
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
| ADR-12 | D13 | [`12-design-system.md`](./12-design-system.md), [`13-keyboard-commands.md`](./13-keyboard-commands.md) |
| ADR-13 | — | [`11-clipboard-export.md`](./11-clipboard-export.md), [`06-markdown-dialect.md`](./06-markdown-dialect.md) |
| ADR-14 | — | [`11-clipboard-export.md`](./11-clipboard-export.md), [`12-design-system.md`](./12-design-system.md) |
| ADR-15 | D6 | [`05-lossless-bridge.md`](./05-lossless-bridge.md), [`../plan/phase-0-spikes.md`](../plan/phase-0-spikes.md) |
| ADR-16 | D8 | [`07-undo-tree.md`](./07-undo-tree.md), [`10-sync-persistence.md`](./10-sync-persistence.md), [`../plan/phase-0-spikes.md`](../plan/phase-0-spikes.md) |

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
| `recreateTransform` package | **`@manuscripts/prosemirror-recreate-steps@0.1.4`** (unscoped `prosemirror-recreate-steps` is unpublished on npm; API identical) |
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
2. **Restyle via Recto OKLCH tokens** — map shadcn CSS variables (`--background`, `--primary`, etc.) to the canonical tokens in [`12-design-system.md`](./12-design-system.md) §2.1; never ship stock light-theme defaults (D13).
3. **Compose custom UI from shadcn building blocks** — if a needed element has no shadcn component, build it by composing existing primitives (e.g. `Card` + `Alert` + `Button`), not raw HTML with ad-hoc styles.
4. **No parallel component libraries** — no MUI, Radix direct imports in app code (shadcn wraps Radix/Base UI), no one-off styled `<button>`/`<input>` in feature code.

Configuration: [`components.json`](../../components.json) (style: `base-nova`, `@/components/ui` alias).

### Alternatives rejected

- **Hand-rolled components only.** Rejected — duplicates accessibility and interaction work shadcn already solves.
- **Stock shadcn defaults un-themed.** Rejected — violates P3 and D13; tokens must be mapped to Recto OKLCH.
- **Multiple UI libraries.** Rejected — inconsistent patterns and bundle weight.

### Consequences

- New UI work starts with `bunx shadcn add …` then token mapping in `app/globals.css`.
- Feature components live in [`components/`](../../components/); primitives stay in `components/ui/`.
- Phase 5 bespoke pass tunes tokens and typography, not the component sourcing strategy.

### References

- [`12-design-system.md`](./12-design-system.md) §6 · [`../plan/phase-1-foundation.md`](../plan/phase-1-foundation.md) G1.3
