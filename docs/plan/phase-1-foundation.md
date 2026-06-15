# Phase 1 — Foundation

> **Status: Complete** (all exit criteria met; deviations in [ADR-17](../blueprint/14-tech-decisions.md); shadcn/ui in [ADR-18](../blueprint/14-tech-decisions.md)).

> **A self-contained build-plan phase for Recto.** This file restates everything an implementer needs to execute Phase 1 without reading the other phase files. It does, however, assume the canon in [`../blueprint/README.md`](../blueprint/README.md) — read that for the locked decisions (**D1–D15**), the canonical Convex schema, the Markdown dialect, and the glossary. Where this phase touches an area in depth, it cross-references the expanding blueprint file by relative path. Nothing here may contradict **D1–D15**; if a tension is discovered, the blueprint README wins and the deviation is reconciled there (Plan [`./README.md`](./README.md) Definition of Done item 5).
>
> **Blueprint references for this phase:** [`../blueprint/02-architecture.md`](../blueprint/02-architecture.md) (canonical-model spine, client/server split, module layout), [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md) (`documents` table + function surface), [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) (the performance contract, debounce, hydrate-on-idle, local draft buffer, unsynced-close warning), [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) (dark OKLCH tokens, typography, the measure, status bar, motion).

---

## Goal

Stand up a **real app skeleton with exactly one rich-text editing surface that syncs to the cloud and never loses words.**

Concretely, at the end of Phase 1:

- Recto runs as a Next.js (App Router) application on **bun**, TypeScript strict, ESM, gated behind a single Better Auth login.
- A **Convex** backend holds the `documents` table and the minimal document function surface; every row is scoped to the authenticated `userId`.
- A **dark-only app shell** (per [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md)) presents one **Milkdown** rich-text editor inside the centered measure column, with a quiet bottom status bar showing a live **word count** and a placeholder **mode indicator**.
- The editor edits the **canonical remark MDAST** in memory (D1) and serializes to the `documents.markdown` string; persistence is a **debounced** `documents.updateMarkdown` mutation, and the editor is **never** a controlled component of `useQuery` (D11).
- Type → refresh → reopen — including on a **second device/browser** — returns the text intact, with **no cursor clobber** from reactive sync.

This is the first phase that builds product on top of proven mechanisms. The two unproven, novel mechanisms (the live two-mode bridge, the cloud undo-tree DAG) are out of scope here and are spiked separately in Phase 0 (Plan [`./README.md`](./README.md) §"Why phased").

---

## Why now / prerequisites

**Why this is the right first product phase.** Recto's defining feature is *one canonical document edited through interchangeable lenses* (D2). Phase 1 establishes the **one canonical model** end-to-end — `documents.markdown` ⇄ remark MDAST ⇄ a single Milkdown projection — and proves the two non-negotiable promises against it before any second lens, split pane, or history UX is layered on:

- **Never lose a word** (Product principle 2) — debounced persistence + reactive hydration + local draft buffer.
- **Snappy is a feature** (Product principle 4) — the local editor owns live state; typing never waits on the network (D11; [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §1).

Every later phase (modes & losslessness, multi-doc/split, history, polish) binds to the canonical-model spine and the editor↔Convex boundary that Phase 1 lays down. Getting the spine and the performance contract right here is what makes those phases additive rather than a rewrite.

**Prerequisites.**

- Phase 0 spikes (live two-mode bridge; cloud undo-tree DAG) are *informative, not blocking* (Plan [`./README.md`](./README.md) item 4). Phase 1 may begin in parallel and need only honor the locked decisions, not any Phase 0 implementation.
- A Convex project/deployment is available to point the app at (created in the work breakdown below).
- Better Auth single-user credentials decided (the one identity that scopes all cloud state — README §1, D12).

---

## In scope

1. **Project scaffold** — Next.js App Router, bun, TypeScript strict, ESM; Tailwind v4 + shadcn primitives + the OKLCH dark token set; Biome; the four canonical scripts (`dev`, `typecheck`, `biome check`, `test`).
2. **Convex backend** — initialize the project; define the `documents` table per [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md) §2; implement `documents.list / get / create / rename / updateMarkdown`; wire `ConvexProvider`.
3. **Auth** — Better Auth, single-user/private; gate the whole app behind one login; scope `documents` by `userId`.
4. **Dark app shell** — minimal chrome, a dominant writing surface in the centered measure column, a quiet status bar with live word count and a placeholder mode indicator, plus the saving/unsynced indicator.
5. **One editor** — a single Milkdown rich-text lens bound to one document's canonical MDAST (commonmark + gfm presets), serializing to `documents.markdown`.
6. **The performance contract (D11)** — debounced `updateMarkdown` (~500 ms–1 s idle), hydrate-on-open/idle from the reactive query only, editor owns live state, no cursor clobber.
7. **Word count** — live, derived from the canonical model (D15).
8. **Local draft buffer** — a small `localStorage` crash/offline copy; `beforeunload` warn on unsynced close.

---

## Out of scope

Explicitly **not** built in Phase 1 (deferred to the phases noted; do not gold-plate toward them):

- **Raw Markdown lens, Vim lens, Preview lens**, and **lossless mode switching** → Phase 2 ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md), [`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md)).
- **The live two-mode bridge** (`lib/bridge`, the MDAST bus, recreate-steps, cursor-preserving diffs) → Phase 2/3 ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md)). Phase 0 spikes it.
- **Slash command palette** and the **contextual formatting toolbar** → Phase 2 ([`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §2.3–2.4, [`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md)).
- **Multi-document UI** (document switcher), **split panes** (`react-resizable-panels`, nested pane tree), **same-doc-two-live-modes**, and **workspace persistence/cross-device resume** → Phase 3 ([`../blueprint/09-documents-workspace-split.md`](../blueprint/09-documents-workspace-split.md)). The `workspaces`, `docNodes`, and `versions` tables are **not** defined in Phase 1.
- **Branching undo tree** and **`docNodes.append`** (Recto uses Milkdown/ProseMirror's *built-in linear* undo within the session for Phase 1) → Phase 4 ([`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md)). Phase 0 spikes the DAG.
- **Version history** (tags, additive restore) → Phase 4 ([`../blueprint/08-version-control.md`](../blueprint/08-version-control.md)).
- **Command palette** (`cmdk`), **clipboard** (html+plain / copy-as-markdown), **export** (.md/.html), and the **bespoke design pass** (final typeface selection, token tuning) → Phase 5 ([`../blueprint/11-clipboard-export.md`](../blueprint/11-clipboard-export.md), [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §9).
- **Footnotes + YAML frontmatter** round-trip guarantees and the round-trip property-test corpus → Phase 2 ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md)). Phase 1 wires the commonmark + gfm presets so those constructs survive, but does not own the dialect contract or its tests.
- **`documents.remove`** is part of the canonical surface ([`../blueprint/03-data-model.md`](../blueprint/03-data-model.md) §3.1) but its cascade deletes `docNodes`/`versions`, which do not exist yet; **defer `remove`** to the phase that introduces those tables (Phase 4). Phase 1 ships `list / get / create / rename / updateMarkdown` only.

**Single document, single rich pane only.** The UI opens (or creates) exactly one document and shows it in one Milkdown editor. No switcher, no second pane.

---

## Work breakdown (grouped tasks + sub-tasks)

### G1 — Project scaffold & toolchain

- **G1.1 Initialize the app.** `bun create` a Next.js (App Router) project; TypeScript **strict** (`"strict": true`, `"moduleResolution": "bundler"`/ESM), ESM only. Mostly client components (the studio is SPA-like — README §6). Establish the proposed module layout from [`../blueprint/02-architecture.md`](../blueprint/02-architecture.md) §7 (`app/`, `convex/`, `lib/markdown`, `lib/editor/milkdown`, `lib/sync`, `components/`, `design/`). Only create the directories Phase 1 actually fills; do not stub directories for out-of-scope areas (`lib/bridge`, `lib/history`, `lib/workspace`).
- **G1.2 Biome.** Add Biome as the single linter/formatter (`biome.json`); configure for the TS/ESM/Next conventions.
- **G1.3 Tailwind v4 + shadcn + tokens.** Install Tailwind v4; declare the canonical OKLCH dark tokens in an `@theme` block in `globals.css` **using the exact token names** from [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §2.1, §3.1–3.2, §4.5, §7.1 (background layers, ink levels, lines, accents, semantics, selection/focus, fonts, type scale + leadings, spacing, radii, motion). Add shadcn primitives (restyled to tokens, not stock — P3). No light theme, no theme toggle, no `prefers-color-scheme` light handling (D13, P4). Add the global `prefers-reduced-motion` reset ([`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §7.4).
- **G1.4 Scripts.** Wire `package.json` scripts: `dev`, `typecheck` (`tsc --noEmit`), `biome check` (exposed as `bun run biome check`), `test`. These are the canonical commands the Definition of Done checks (Plan [`./README.md`](./README.md) §Conventions).
- **G1.5 Test runner.** Configure `bun test` (or Vitest if a DOM/jsdom harness is needed for editor tests). Phase 1's tests are word-count and a serialize/hydrate smoke check — keep the harness minimal; the round-trip property corpus is Phase 2.

### G2 — Convex backend (`documents` only)

- **G2.1 Init Convex.** Add Convex to the project; create/point at a deployment; generate `convex/_generated`. Add the dev codegen to the workflow (`convex dev`).
- **G2.2 Schema.** In `convex/schema.ts`, define **only** the `documents` table exactly as in [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md) §2, including both indexes `by_user` (`["userId"]`) and `by_user_updated` (`["userId", "updatedAt"]`). Do **not** add `docNodes`, `versions`, or `workspaces` (Phases 3–4). The `users` table is owned by Better Auth (G3) — reference it via `v.id("users")`, do not redefine it.
- **G2.3 `documents.ts` functions.** Implement the subset of the canonical surface ([`../blueprint/03-data-model.md`](../blueprint/03-data-model.md) §3.1). Every function resolves the authenticated `userId` (G3) and verifies the target row belongs to that user before touching it:
  - `documents.list()` — query via `by_user_updated`, **descending**, returning metadata only (`_id`, `title`, `wordCount`, `updatedAt`) — **never** the `markdown` body (keeps the read cheap; [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md) §7).
  - `documents.get({ documentId })` — full row including `markdown` and `currentNodeId`; `null` if absent or not owned.
  - `documents.create({ title? })` — insert one `documents` row scoped to `userId`, with `markdown: ""`, `wordCount: 0`, `createdAt`/`updatedAt` set. **Phase-1 deviation note (must be reconciled in the blueprint, per Definition of Done item 5):** the canonical contract has `create` also insert the **root `docNodes` node** and set `currentNodeId = rootNodeId` in one transaction. `docNodes` does not exist until Phase 4, so in Phase 1 `create` writes `currentNodeId` as a generated ULID placeholder (`crypto.randomUUID()`/ULID — built-in, no `uuid` dep, README §6) and returns `{ documentId, rootNodeId }` with `rootNodeId` = that placeholder. This keeps the field non-null and the signature stable; Phase 4 replaces the placeholder with a real root node.
  - `documents.rename({ documentId, title })` — patch `title` (+ `updatedAt`).
  - `documents.updateMarkdown({ documentId, markdown, wordCount, expectedUpdatedAt })` — the debounced autosave write path. Overwrite `markdown` + `wordCount` + stamp `updatedAt` **only if** the stored `updatedAt` still equals `expectedUpdatedAt`; otherwise return `{ updatedAt, stale: true }` **without overwriting** (the stale-version guard; [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §5). `wordCount` is passed in by the client — the server does not recompute it.
  - **Do not** implement `documents.remove` (cascade depends on non-existent tables — see Out of scope).
- **G2.4 Wire `ConvexProvider`.** Add the Convex React client provider at the app root (composed with the Better Auth provider — G3), so client components can call `useQuery`/`useMutation`.

### G3 — Auth (Better Auth, single-user)

- **G3.1 Integrate Better Auth.** Add Better Auth (D12; README §6 default — Clerk is the fallback only). Configure the single-user/private posture: one identity, no sign-up surface beyond what the single user needs, no sharing/multi-user (README §1, §5 non-goals). Better Auth manages/owns the `users` table referenced by `documents.userId`.
- **G3.2 Gate the app.** Put the whole studio behind one login (`app/(auth)/` screens per [`../blueprint/02-architecture.md`](../blueprint/02-architecture.md) §7). Unauthenticated → login; authenticated → the studio route.
- **G3.3 Scope every Convex function.** Each `documents.*` function reads the authenticated identity and filters/asserts by `userId`. No function returns or mutates a row that does not belong to the caller ([`../blueprint/03-data-model.md`](../blueprint/03-data-model.md) §3 intro; [`../blueprint/02-architecture.md`](../blueprint/02-architecture.md) §4 "Auth / identity scoping").

### G4 — Dark app shell

- **G4.1 Root layout (dark-only).** `app/layout.tsx` applies the design tokens and dark surface (`--color-bg-app`), the UI font (`--font-ui`), and composes `ConvexProvider` + Better Auth provider. No light theme anywhere (D13/P4).
- **G4.2 Shell chrome.** Build the minimal two-element chrome from [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §4.1:
  - **Minimal top affordance** (~40px, `--color-bg-app`, `--text-ui` at `--color-ink-secondary`): shows the active document's title only. No formatting controls, no persistent toolbar (P2). The document **switcher** entry point is out of scope (Phase 3) — title display only.
  - **Quiet status bar** (~28px, `--color-bg-raised`, single `--color-line` top hairline, `--text-ui-sm`) carrying three elements per [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §4.3: **word count** (live, D15; rests at `--color-ink-tertiary`), a **placeholder per-pane mode indicator** (Phase 1 always shows `Rich text` — the indicator surface exists but there is only one mode; full mode/sub-mode display is Phase 2, [`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §7), and the **saving/sync indicator** (§5: saving pulse at `--color-ink-tertiary`, saved check at `--color-success`, unsynced/offline at `--color-warning`).
- **G4.3 Measure column.** The editor surface lives in the centered measure column: `.recto-measure` with `inline-size: clamp(45ch, 66ch, 75ch)`, `margin-inline: auto`, `padding-inline: var(--space-6)` ([`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §3.4). Editor body uses reading typography: `--text-body` (~19px) at `--leading-body` (1.6) in `--font-reading`, ink `--color-ink-primary` ([`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §3.3).
- **G4.4 Empty state.** When there is no document yet, show the centered, type-led empty state ([`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §6.11): `--text-display`/`--text-h2` headline at `--color-ink-secondary`, one-line hint at `--color-ink-tertiary`, and a single primary action that calls `documents.create`. No illustration clutter.
- **G4.5 Loading/hydrating state.** While the document hydrates on open, show a quiet skeleton/low-contrast shimmer on the pane (`--color-bg-surface`/`--color-bg-raised`), **never a spinner over the text** ([`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §5).
- **G4.6 Accessibility floor.** Visible `:focus-visible` rings using `--color-focus-ring`; the saving/offline indicator announced via a polite live region (`role="status"`); honor `prefers-reduced-motion` ([`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §8).

### G5 — The canonical Markdown pipeline (`lib/markdown`)

- **G5.1 The single crossing.** Implement `lib/markdown` as the **sole** place MDAST ↔ Markdown-string crossing happens ([`../blueprint/02-architecture.md`](../blueprint/02-architecture.md) §7 boundary; §2). Build the unified pipeline: `unified` + `remark-parse` + `remark-stringify` + `remark-gfm` (CommonMark + GFM: tables, task lists, strikethrough, autolinks — D7). Frontmatter (`remark-frontmatter`) and footnotes are wired now so those constructs survive, but the dialect *contract* and round-trip corpus are Phase 2 ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md)).
- **G5.2 Word count.** Implement `countWords(markdown | mdast)` deriving the count from the **canonical model** (D15; [`../blueprint/02-architecture.md`](../blueprint/02-architecture.md) §4 "Word count → Client"). Count words from the prose, not raw Markdown punctuation/syntax — prefer walking the MDAST text nodes (or normalizing via the pipeline) over a naive `split(/\s+/)` on the raw string so syntax characters do not inflate the count. This is the value the status bar shows and the value passed to `updateMarkdown`.
- **G5.3 No second parser.** Nothing outside `lib/markdown` parses or stringifies Markdown. (Preview's `remark-rehype`/`rehype-sanitize` path is Phase 2; do not add it now.)

### G6 — The one editor (Milkdown rich-text lens)

- **G6.1 Milkdown lens wrapper.** In `lib/editor/milkdown`, wrap Milkdown with `@milkdown/preset-commonmark` + `@milkdown/preset-gfm` (D3; README §6). Milkdown's document model **is** a remark MDAST ([`../blueprint/02-architecture.md`](../blueprint/02-architecture.md) §2.1) — so rich editing mutates the canonical tree directly; there is no "convert to Markdown later" step. Expose an imperative handle: `getCanonicalMarkdown()` (serialize the live MDAST via `lib/markdown`) and a one-time seed/hydrate method.
- **G6.2 Editor lives in a ref, not React state.** The Milkdown instance + canonical model are held in a React `ref` (imperative handle), **never** React-controlled by a query result ([`../blueprint/02-architecture.md`](../blueprint/02-architecture.md) §8). React renders the *container*, not the editor's value.
- **G6.3 Seed on open.** On open, hydrate the editor **once** from `documents.get(...).markdown` (parse → MDAST → Milkdown). After seeding, the editor owns the live state ([`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §1).
- **G6.4 Local linear undo.** Use Milkdown/ProseMirror's built-in in-session undo/redo (history plugin). Do **not** build the branching DAG or persist undo nodes — that is Phase 4 (and Phase 0 spikes it).

### G7 — The editor↔Convex boundary (the performance contract)

This is the heart of Phase 1. Implement in `lib/sync` ([`../blueprint/02-architecture.md`](../blueprint/02-architecture.md) §7; [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md)).

- **G7.1 Debounced flush.** On each local editor change, (re)start an idle timer of **`DEBOUNCE_MS` = 500–1000 ms**. When it fires: read `editor.getCanonicalMarkdown()`, compute `wordCount` (G5.2), call `documents.updateMarkdown({ documentId, markdown, wordCount, expectedUpdatedAt })` ([`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §2). A keystroke during the window resets the timer — a burst produces one write, not one per character. Use a battle-tested debounce (e.g. `useDebouncedCallback`) — do not hand-roll timer bookkeeping.
- **G7.2 Stale guard handling.** Track `expectedUpdatedAt` per open document. If `updateMarkdown` returns `{ stale: true }`, do **not** overwrite again; flag the pane for re-hydration when idle ([`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §5.3). On success, set `expectedUpdatedAt = res.updatedAt`.
- **G7.3 Hydrate-on-open/idle only.** Consult the `documents.get` reactive query for exactly two things ([`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §1, §3): (1) the one-time seed on open (G6.3); (2) re-seeding a pane that is **idle/unfocused** when a newer `updatedAt` arrives from a **different `origin`**. A **focused** editor ignores query echoes entirely. The query result is never bound into the live editor value (D11). For Phase 1 (single pane), "idle" means the editor is mounted but not focused (e.g. another tab is active); the cross-device case below exercises this.
- **G7.4 Origin / last-writer guard.** Generate a stable per-client `origin` id (device/tab id; `crypto.randomUUID()` persisted in `localStorage`). Although `docNodes.origin` does not exist in Phase 1, the client must still distinguish *its own* echoed write from a *remote* write so a focused/idle pane does not re-seed from its own save ([`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §3). Track the `updatedAt` the client last wrote; treat a query whose `updatedAt` is newer-than-last-written as remote and re-hydrate **only if idle**.
- **G7.5 Forced flush on teardown.** When the editor unmounts/the document closes, force a final debounced flush before release so no pending edits are lost ([`../blueprint/02-architecture.md`](../blueprint/02-architecture.md) §6.3; [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §2). Optimistic updates are allowed only for list/derived UI (e.g. title in a future switcher), **never** for `documents.markdown` of the focused pane ([`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §4).

### G8 — Local draft buffer & unsynced-close warning

- **G8.1 Draft buffer.** On the same debounce tick as the network flush, mirror the canonical Markdown to a small `localStorage` buffer keyed by `documentId` ([`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §6). This is a crash/offline safety copy — **not** the live editor state (D11). On reload, reconcile the buffer against the hydrated `documents.markdown`: the freshest content wins; on a genuine conflict, offer the buffered text rather than auto-applying ([`../blueprint/02-architecture.md`](../blueprint/02-architecture.md) §9 item 2).
- **G8.2 Warn on unsynced close.** If there are buffered changes not yet acknowledged by Convex, fire a `beforeunload` warning so a tab/window is not closed with unsynced text ([`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §6). Once a flush is acknowledged and the buffer matches the synced markdown, clear the warning.

### G9 — Verification & Definition of Done

- **G9.1 Word-count unit test** (G5.2): known Markdown inputs → expected counts (syntax characters excluded).
- **G9.2 Serialize/seed smoke test**: `parse → seed Milkdown → getCanonicalMarkdown()` returns the input for a representative CommonMark+GFM document (full round-trip *contract* is Phase 2; this is a smoke check that the pipeline and editor are wired).
- **G9.3 Manual / Playwright cross-device check** (the headline exit criterion): type in browser A → wait past the debounce → refresh A → text intact; open the same document in browser/profile B → text present; type in the focused window and confirm the idle window does **not** clobber the focused cursor; confirm word count updates live. Reproduce against the running app in a real browser before declaring done (per the user's debug-before-patching convention). Use the `playwright` skill if automating.
- **G9.4 Toolchain green**: `bun run typecheck` and `bun run biome check` pass with no errors (Plan [`./README.md`](./README.md) Definition of Done item 2).

---

## Technical approach & key decisions

- **One canonical model, one projection.** Phase 1 implements the architecture spine from [`../blueprint/02-architecture.md`](../blueprint/02-architecture.md) at its simplest: `documents.markdown` (at rest) ⇄ remark MDAST (in memory) ⇄ a single Milkdown rich projection. Because Milkdown's document model *is* the canonical MDAST (§2.1), rich editing never leaves the canonical layer — there is no second format to drift, so the lossless boundary is preserved from day one even though only one lens exists yet.
- **`lib/markdown` is the only serialize/parse boundary.** Enforcing this now (§7 boundary in the architecture file) is what keeps the round-trip property checkable in one place when Phase 2 adds the other lenses and the corpus.
- **The editor owns live state (D11).** The single most important decision in this phase. The Milkdown instance lives in a `ref`; `useQuery` hydrates only on open/idle; the focused editor ignores reactive echoes. This is the operational form of "the editor is never a controlled component of a reactive query" ([`../blueprint/02-architecture.md`](../blueprint/02-architecture.md) §8; [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §1). Getting this wrong reintroduces the "cursor clobbered by reactive sync" risk the whole design is built to avoid.
- **Debounced last-write-wins, with the stale guard (D10).** No CRDT, no Yjs, no `prosemirror-sync` ([`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §7) — Recto is single-user; the only concurrency is one person on two surfaces, handled by Convex OCC + debounced last-write-wins + the `expectedUpdatedAt` stale guard + the local draft buffer. Phase 1 implements all of these except the append-only history backstop (Phase 4), which is acceptable because the live `documents.markdown` plus the local buffer already satisfy "never lose a word" for a single rich pane.
- **Two write rhythms, only one in Phase 1.** The canonical surface separates `documents.updateMarkdown` (autosave, every debounced idle) from `docNodes.append` (history, coarser cadence) — [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §2. Phase 1 implements only the autosave rhythm; the history rhythm arrives with `docNodes` in Phase 4.
- **`currentNodeId` placeholder.** `currentNodeId` is non-null in the schema (D-canon, [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md) §2.1). Without `docNodes` yet, `create` seeds it with a client-style ULID placeholder so the field and the `create` return shape stay canonical; Phase 4 swaps in a real root node. **Recorded as a deviation to reconcile** (Definition of Done item 5).
- **Tokens now, bespoke pass later.** Phase 1 applies the canonical OKLCH tokens and typography roles verbatim from [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md); the *finished* look (final typeface selection, token tuning, the `frontend-design` pass) is Phase 5 (§9 there). Do not prematurely polish; do not drift toward the generic shadcn default the design system explicitly rejects (P3).

---

## Libraries introduced

All are the canon stack from README §6; versions per their current releases under bun. Prefer these battle-tested libraries / built-in features over custom code.

| Library | Role in Phase 1 | Canon ref |
|---------|-----------------|-----------|
| Next.js (App Router) | App framework, mostly client components | D14, README §6 |
| bun | Runtime / package manager / test runner | D14, README §6 |
| TypeScript (strict, ESM) | Language | D14, README §6 |
| Tailwind v4 | Styling; `@theme` token declarations | README §6, [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §2.1 |
| shadcn primitives | Restyled UI primitives (status bar, dialog/empty-state) | README §6, [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §6 |
| Biome | Lint + format (single tool) | README §6 |
| Convex (`convex`, `convex/react`) | Backend, reactive queries, `ConvexProvider` | D10, README §6 |
| Better Auth | Single-user auth; owns `users` | D12, README §6 |
| Milkdown (`@milkdown/core`, `@milkdown/preset-commonmark`, `@milkdown/preset-gfm`, React binding) | The one rich-text lens; model is remark MDAST | D3, README §6 |
| `unified`, `remark-parse`, `remark-stringify`, `remark-gfm` | The canonical MDAST ⇄ string pipeline (`lib/markdown`) | README §6 |
| `remark-frontmatter` | Frontmatter survives parse/serialize (contract is Phase 2) | D7, README §6 |
| A debounce util (e.g. `use-debounce`) | Debounced flush (G7.1) — battle-tested over hand-rolled timers | [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §2 |

**Not introduced in Phase 1** (deferred): CodeMirror 6 + `@codemirror/lang-markdown` + `@replit/codemirror-vim` (Phase 2), `remark-rehype`/`rehype-sanitize`/`rehype-stringify` (Phase 2 preview), `prosemirror-recreate-steps` (bridge, Phase 2/3), `react-resizable-panels` (Phase 3), `cmdk` (Phase 5). Built-in `crypto.randomUUID()`/ULID for ids — no `uuid` dependency (README §6).

---

## Data-model changes (Convex)

Phase 1 introduces **only** the `documents` table and a **subset** of its function surface. The exact validators and indexes are canon in [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md) §2; reproduced here for self-containment.

```ts
// convex/schema.ts — Phase 1 defines ONLY this table.
// users — owned by Better Auth; referenced by Id<"users">, not redefined here.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  documents: defineTable({
    userId: v.id("users"),
    title: v.string(),
    markdown: v.string(),        // canonical serialized Markdown — source of truth at rest (D1)
    wordCount: v.number(),
    currentNodeId: v.string(),   // ULID placeholder in Phase 1 (no docNodes yet); see deviation note
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_updated", ["userId", "updatedAt"]),
  // docNodes / versions / workspaces are NOT defined in Phase 1 (Phases 3–4).
});
```

**Functions implemented (`convex/documents.ts`)** — signatures per [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md) §3.1, all auth-scoped to `userId`:

- `documents.list()` → metadata only (`_id`, `title`, `wordCount`, `updatedAt`), `by_user_updated` descending, **no `markdown`**.
- `documents.get({ documentId })` → full row or `null`.
- `documents.create({ title? })` → `{ documentId, rootNodeId }` (`rootNodeId` is the ULID placeholder; `markdown: ""`, `wordCount: 0`).
- `documents.rename({ documentId, title })` → `void`.
- `documents.updateMarkdown({ documentId, markdown, wordCount, expectedUpdatedAt })` → `{ updatedAt, stale }` (stale guard; no server-side word recount).

**Deferred functions / tables:** `documents.remove` (cascade needs `docNodes`/`versions` — Phase 4); all of `docNodes.*`, `versions.*`, `workspace.*` and their tables (Phases 3–4).

---

## Acceptance / exit criteria (testable checkboxes)

The phase is done only when **all** of these hold (these subsume the global Definition of Done, Plan [`./README.md`](./README.md) §"Definition of Done").

- [x] **Scaffold runs.** `bun run dev` serves the app; it is a Next.js App Router project on bun, TypeScript strict, ESM.
- [x] **Dark-only shell.** The app renders dark-only using the canonical OKLCH tokens from [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) (exact token names); there is no light theme, no theme toggle, and no `prefers-color-scheme` light branch (D13/P4).
- [x] **Writing surface dominates.** One Milkdown rich editor renders in the centered measure column (`clamp(45ch, 66ch, 75ch)`, centered) in reading typography (`--text-body`/`--font-reading`); chrome is the minimal top affordance + the quiet status bar only.
- [x] **Status bar.** The status bar shows a **live word count** (D15) and a **placeholder mode indicator** reading `Rich text`, plus a saving/unsynced indicator (saved/saving/offline per [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §5).
- [x] **Auth gate.** The app is behind a single Better Auth login; an unauthenticated visitor cannot reach the studio or read/write documents.
- [x] **Document scoping.** Every `documents.*` function rejects access to rows not owned by the authenticated `userId`.
- [x] **Convex surface.** `documents.list / get / create / rename / updateMarkdown` exist with the canonical signatures; `list` omits `markdown`; `updateMarkdown` honors `expectedUpdatedAt` (returns `{ stale: true }` without overwriting on mismatch). `documents.remove`, `docNodes`, `versions`, `workspaces` are absent (out of scope).
- [x] **Editor owns live state.** The Milkdown instance is in a `ref`; the editor value is never bound to a `useQuery` result; `documents.get` is consulted only for open/idle hydration (verifiable by inspection + the cursor test below).
- [x] **Debounced persistence.** Typing produces **one** `updateMarkdown` write per idle pause (~500 ms–1 s), not one per keystroke; typing never blocks on the network.
- [x] **Never lose a word — same device.** Type → wait past the debounce → refresh → reopen: the text is intact.
- [x] **Never lose a word — second device/browser.** With the same document open in a second browser/profile, edits made (and flushed) on one appear on the other after a refresh/idle re-hydrate.
- [x] **No cursor clobber.** While typing in the focused window, a reactive update (including the client's own echoed write, and a remote write to an *idle* pane) does **not** reset the focused editor's selection/cursor (D11; [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §3).
- [x] **Live word count.** The status-bar word count updates as the user types, derived from the canonical model (not a stale server value).
- [x] **Local draft buffer.** Pending unsynced edits are mirrored to `localStorage`; a refresh inside the debounce window (before a flush) does not lose text.
- [x] **Warn on unsynced close.** Closing the tab/window with unacknowledged buffered changes triggers a `beforeunload` warning; closing after a confirmed flush does not.
- [x] **Word-count test green** (G9.1) and **serialize/seed smoke test green** (G9.2).
- [x] **Toolchain clean.** `bun run typecheck` and `bun run biome check` pass with no errors.
- [x] **No data-loss regressions** under refresh, navigate-away, and device-switch (Plan [`./README.md`](./README.md) Definition of Done item 3).
- [x] **Snappy.** No perceptible input latency while typing; sync work is debounced off the hot path (Plan [`./README.md`](./README.md) Definition of Done item 4).
- [x] **Deviation recorded.** The `currentNodeId` placeholder and the deferral of `documents.remove` / the root-`docNodes`-node creation are noted against the blueprint for Phase 4 reconciliation (Definition of Done item 5).

---

## Risks & mitigations

Drawn from the carried risk register (Plan [`./README.md`](./README.md) §"Risk register"); only the rows live in Phase 1 are restated.

| Risk | Likelihood | Mitigation (Phase 1) | Fallback |
|------|-----------|----------------------|----------|
| **Cursor clobbered by reactive sync** (D11 violated) | High if D11 is not respected | Editor in a `ref`, never controlled by `useQuery`; focused pane ignores echoes; hydrate on open/idle only; origin/last-writer guard ([`../blueprint/02-architecture.md`](../blueprint/02-architecture.md) §8, [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §1, §3). The dedicated cursor test (G9.3) is a gate. | — (this is non-negotiable; if it cannot be made stable the editor-binding approach is wrong) |
| **Same doc edited on two devices within the debounce window** (last-write-wins clobber) | Low (single user, two surfaces) | Convex OCC + `expectedUpdatedAt` stale guard (`updateMarkdown` returns `{ stale: true }` without overwriting) + idle re-hydration + local draft buffer ([`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §5). | Accept rare last-write-wins; **note:** the append-only history safety net (the usual restore path) does **not** exist until Phase 4, so in Phase 1 the local draft buffer is the only sub-second recovery — acceptable for a single rich pane, and called out for Phase 4 to backstop. |
| **Milkdown's serialization drifts from the `lib/markdown` pipeline** (two MDAST flavors) | Medium | Treat `lib/markdown` as the single serialize/parse authority; serialize the *Milkdown/canonical* MDAST through it where possible; the serialize/seed smoke test (G9.2) catches drift early; full corpus is Phase 2 ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md)). | Narrow the Phase 1 surface to constructs proven stable; document any normalization difference; never silently drop content. |
| **Convex ~1 MiB per-document ceiling** | Low for articles | `documents.markdown` is one article — comfortably small; history is never embedded (and does not exist yet) ([`../blueprint/03-data-model.md`](../blueprint/03-data-model.md) §5). | Book-length manuscripts are an explicit non-goal (README §5). |
| **Better Auth ↔ Convex integration friction** (identity not resolvable in functions) | Medium | Follow Better Auth's Convex integration; assert `userId` resolves in every function; research the current integration docs before wiring rather than guessing (user convention: research before fixing). | Clerk is the documented auth fallback (README §6); switch only if Better Auth integration is genuinely blocked. |
| **Premature polish drifts to generic-AI aesthetic** | Medium | Apply tokens verbatim; the bespoke pass is Phase 5; honor the do/don't table in [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §9 (no stock cards/shadows/blue accent). | — (defer all finish work to Phase 5). |

---

## References

**Plan**

- [`./README.md`](./README.md) — phase map, Definition of Done, conventions, carried risk register.

**Blueprint (canon)**

- [`../blueprint/README.md`](../blueprint/README.md) — locked decisions **D1–D15**, the canonical schema summary (§7), the Markdown dialect (§8), the glossary (§11).
- [`../blueprint/02-architecture.md`](../blueprint/02-architecture.md) — the one rule, the canonical model, client/server split, single-edit data flow, in-memory model lifecycle, module layout (§7), state management (§8), recovery posture (§9).
- [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md) — `documents` table validators/indexes (§2), the `documents.*` function surface (§3.1), Convex limits (§5), access patterns (§7).
- [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) — the performance contract (§1), debounced persistence (§2), reactive hydration (§3), narrow optimistic updates (§4), concurrency + stale guard (§5), offline / local draft buffer / unsynced-close warning (§6), why no CRDT/Yjs/prosemirror-sync (§7).
- [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) — OKLCH dark tokens (§2), typography + the measure (§3), layout/chrome/status bar (§4), the visible states (§5), component inventory (§6), motion (§7), accessibility (§8), avoiding the generic AI aesthetic (§9), consolidated token reference (§10).

**Deferred-area blueprint files (context only; not built in Phase 1)**

- [`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md), [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md), [`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) — Phase 2.
- [`../blueprint/09-documents-workspace-split.md`](../blueprint/09-documents-workspace-split.md) — Phase 3.
- [`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md), [`../blueprint/08-version-control.md`](../blueprint/08-version-control.md) — Phase 4.
- [`../blueprint/11-clipboard-export.md`](../blueprint/11-clipboard-export.md) — Phase 5.
- [`../blueprint/14-tech-decisions.md`](../blueprint/14-tech-decisions.md) — ADR rationale for the locked decisions.
