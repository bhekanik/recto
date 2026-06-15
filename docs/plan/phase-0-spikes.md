# Phase 0 — Spikes

> **Status: Complete** (decisions recorded in [ADR-15](../blueprint/14-tech-decisions.md#adr-15--phase-0-spike-a-live-two-mode-bridge-confirmed) and [ADR-16](../blueprint/14-tech-decisions.md#adr-16--phase-0-spike-b-cloud-undo-tree-confirmed); spike code quarantined under `spikes/`).

> **This is the execution companion to the blueprint.** Read [`../blueprint/README.md`](../blueprint/README.md) first — it holds the locked decisions **D1–D15**, the canonical Convex schema (`documents`, `docNodes`, `versions`, `workspaces`), the Markdown dialect, the glossary, and the global Definition of Done that this phase assumes. This file restates everything it needs to be executed standalone, but the blueprint is canon: if anything here contradicts it, the blueprint wins.
>
> The two mechanisms spiked here are specified in full in [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) (the live two-mode bridge) and [`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md) (the cloud-persisted undo-tree DAG), with the persistence/concurrency model in [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md).

---

## Goal

Recto rests on **two genuinely novel, unproven mechanisms**. Before any product UI is built on top of them, this phase **de-risks both with throwaway spikes** and produces a written decision for each so that Phases 1–4 can rely on it:

- **Spike A — the live two-mode bridge.** Prove that two editor engines — a [Milkdown](https://milkdown.dev/) rich-text pane (**D3**) and a [CodeMirror 6](https://codemirror.net/) raw pane (**D4**) — can edit **one** in-memory remark MDAST (**D1, D2**) in real time, losslessly, **without cursor jumps or feedback loops**, at sub-frame perceived latency. This is the mechanism specified in [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md). *Either prove it ships, or select its documented fallback (§12 of that file).*
- **Spike B — the cloud-persisted undo-tree DAG.** Prove that the append-only, immutable `docNodes` table (**D8**) **union-merges across two clients with zero conflict**, that the `documents.currentNodeId` pointer is **last-write-wins** and converges, and that an arbitrary node can be **materialized** (replay `patch` from the nearest `snapshot`) to reproduce its exact state. This is the mechanism specified in [`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md) §7 and persisted per [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §5. *Either prove it ships, or select its retention/depth fallback.*

The deliverable of Phase 0 is **not code that ships** — it is **two recorded decisions** (one per spike), each either "the production approach in the blueprint is confirmed" or "we take the documented fallback, for these measured reasons." Everything built in this spike is **throwaway**.

---

## Why now / prerequisites

**Why first.** Per [`./README.md`](./README.md) (*"Why phased, and why this order"*) and [`../blueprint/README.md`](../blueprint/README.md) §9 (*"the three hard parts"*), the live two-mode sync and the cloud undo tree are where risk concentrates. If either cannot be made smooth, **the user-facing design changes** — the bridge's failure relaxes **D6** (same document in two simultaneously-editable modes); the undo tree's failure tightens the retention policy. We must learn this **before** building product UI on top, or we build on a foundation that may have to move.

**Throwaway, not blocking.** Phase 0 spikes are explicitly throwaway and **inform** (do not block) the Phase 1+ design (see [`./README.md`](./README.md), *"How to use these docs"* §4). The spike code is deleted or quarantined after the decision is recorded; only the **decision** carries forward.

**Prerequisites (minimal — this is a spike, not the foundation):**

- A bun + TypeScript-strict + ESM scratch environment is sufficient. **No** Next.js App Router app, **no** Better Auth, **no** design system, **no** production Convex wiring beyond a throwaway dev deployment for Spike B. (Phase 1 builds the real foundation per [`./phase-1-foundation.md`](./phase-1-foundation.md).)
- A Convex dev deployment for Spike B only (a `convex dev` scratch project). It exists to exercise append + union-merge + LWW-pointer reconciliation, then is discarded.
- The libraries listed under **Libraries introduced** below, pinned to the versions the spike resolves.

---

## In scope

- A throwaway Spike A page: one Milkdown rich pane + one CodeMirror 6 raw pane, both bound to **one** in-memory remark MDAST, syncing live per [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §2–§7.
- The frozen `CANONICAL_STRINGIFY` writer config (a spike version of it) so both panes converge on byte-identical Markdown ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §2.1).
- The minimal prefix/suffix text-diff for rich→raw, and the `recreateTransform` doc-diff→steps for raw→rich ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §3, §4).
- The feedback-loop guards: origin/annotation tag + applying flag (counter) + monotonic version counter, plus the trailing throttle ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §5, §6).
- Latency and cursor-stability **measurement** for Spike A.
- A throwaway Convex setup for Spike B with the `docNodes` append-only table and the `documents.currentNodeId` pointer (canon field names — see [`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md) §3.1).
- Append nodes from **two** clients/tabs; verify **union-merge with zero conflict**; verify the pointer is **last-write-wins** and converges ([`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md) §7; [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §5).
- `materialize(node)`: walk to nearest ancestor `snapshot`, replay `patch` forward ([`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md) §5.1).
- A **stub** additive restore (fork-forward append a node), enough to confirm the shape — **not** the version-control product surface ([`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md) §10).
- A written **decision gate** per spike: confirm the blueprint approach or select the documented fallback, recorded for Phases 1–4.

---

## Out of scope

Explicitly **not** built in this phase (deferred to later phases; do not gold-plate the spike with them):

- **Product UI** of any kind — no real editor chrome, toolbars, slash palette, mode indicator. (Phases 1–2.)
- **Design system** — no OKLCH dark palette, typography, motion, shadcn primitives. The spike may be visually raw. (Phase 5 / [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md).)
- **Auth** — no Better Auth, no user scoping, no login. (Phase 1 / **D12**.)
- **Multi-doc management** — no document switcher, no `workspaces` table, no pane tree, no split layout. (Phase 3 / [`../blueprint/09-documents-workspace-split.md`](../blueprint/09-documents-workspace-split.md).)
- **Real persistence wiring beyond the spike** — no debounced `documents.updateMarkdown` autosave path, no idle-rehydration, no stale-version guard plumbing into a real app, no offline buffer. The spike exercises only what's needed to prove union-merge + LWW pointer + materialization. (Phase 1 / [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md).)
- **The version-history UI** and the undo-tree **visualizer** — restore here is a stub to confirm additivity only. (Phase 4 / [`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md) §9, [`../blueprint/08-version-control.md`](../blueprint/08-version-control.md).)
- **Preview mode** (**D5**) — preview is read-only and not part of the live two-way bridge ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §1 scope note); not needed to de-risk the bridge.
- **Vim mode** (**D4**) — for the bridge, Vim and raw are the same CodeMirror engine ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §1 scope note); the spike uses plain raw CodeMirror.
- **The full Markdown dialect round-trip corpus** — the byte-stability property test over the whole dialect (GFM tables, footnotes, frontmatter) is owned by Phase 2 and [`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md). Spike A uses a small representative content set, not the full corpus.

---

## Work breakdown

### A. Spike A — Live two-mode bridge

**A1. Scratch harness & canonical model.**
- A1.1 Stand up a throwaway page with two mounted editors side by side: a Milkdown instance (rich, **D3**) and a CodeMirror 6 instance (raw, **D4**). No styling beyond what's needed to see both panes and their cursors.
- A1.2 Establish the **single in-memory remark MDAST as the bus** ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §2). The Milkdown ProseMirror doc *is* this MDAST (no second rich format); the CodeMirror text is the derived serialized string. Neither engine is the source of truth — the model is.
- A1.3 Wire `unified` + `remark-parse` + `remark-stringify` (+ `remark-gfm`, `remark-frontmatter` so the representative content set parses) for parse/stringify between the model and the raw string.

**A2. Stable serialization (convergence requirement).**
- A2.1 Define a spike `CANONICAL_STRINGIFY` — a single, **frozen** `remark-stringify` options object used **everywhere** the model is serialized ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §2.1). Use the exact knobs in that file: `bullet: "-"`, `emphasis: "_"`, `strong: "*"`, `fence: "`"`, `fences: true`, `listItemIndent: "one"`, `rule: "-"`, `ruleRepetition: 3`, `setext: false`, etc.
- A2.2 Confirm the convergence property the bridge depends on: **for a given MDAST there is exactly one serialized string, deterministically.** This is what makes the §3 diff usually empty in steady state. (The authoritative knob values are owned by [`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md); the spike consumes them, does not finalize them.)

**A3. Rich → raw propagation (text diff).**
- A3.1 On a rich edit (throttled), serialize the current MDAST with `CANONICAL_STRINGIFY` → `nextMarkdown`.
- A3.2 Compute the **minimal change range** via longest-common-prefix / longest-common-suffix trim (`diffRanges` sketch in [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §3).
- A3.3 Dispatch **one** CodeMirror transaction with only that range, tagged with the bridge `Annotation`, `scrollIntoView: false`. Confirm the `next === prev` short-circuit fires in steady state (no transaction dispatched at all).

**A4. Raw → rich propagation (doc-diff → steps).**
- A4.1 On a raw edit (throttled), `remark-parse` the CodeMirror text into a new MDAST, then produce the corresponding new Milkdown ProseMirror doc `nextDoc`.
- A4.2 Compute ProseMirror **steps** that transform the live doc into `nextDoc` using `recreateTransform` from `prosemirror-recreate-steps` (options: `complexSteps: true`, `wordDiffs: false`, `simplifyDiffs: true`, per [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §4). **Pin the exact build here** — confirm whether the unscoped `prosemirror-recreate-steps` tracks current ProseMirror core, or whether a maintained variant (`@manuscripts/prosemirror-recreate-steps`, `prosemirror-recreate-transform`) is needed; the API `recreateTransform(startDoc, endDoc, opts)` is identical across them. **Record the chosen package + version in the decision.**
- A4.3 Replay the recreated steps onto the **live** ProseMirror state in one transaction, map the prior selection through the mapping (`selection.map(doc, mapping)`), set `BRIDGE_META`, and set `addToHistory: false`. Confirm the `curDoc.eq(nextDoc)` short-circuit fires in steady state.

**A5. Feedback-loop prevention (three guards).**
- A5.1 **Origin/annotation tag** — CodeMirror `bridgeOrigin` Annotation; ProseMirror `BRIDGE_META` meta. A handler that sees the bridge tag returns immediately.
- A5.2 **Applying guard** — a re-entrancy-tolerant counter (`beginApplying`/`endApplying`); while raised, all change handlers short-circuit.
- A5.3 **Version counter** — monotonic `version`; each accepted human edit bumps it; a projection derived from a now-stale version is dropped (`isStale`). Implement the `Bridge` class sketch from [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §5 and wire `shouldPropagate` into both engines' change handlers.

**A6. Throttling & batching.**
- A6.1 Schedule each direction on a **short trailing throttle** with leading behaviour (`throttleTrailing`, [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §6). Start at ~50 ms; **sweep 30–60 ms and record the value that feels seamless** — this is the tuning the blueprint explicitly defers to this spike.
- A6.2 Confirm typing is never blocked (projection runs after the keystroke is on screen) and bursts coalesce (one reparse at end of burst).

**A7. Measurement (the spike's evidence).**
- A7.1 **Cursor stability harness** — drive the two-pane setup, place a caret at a known logical position, inject edits in the *other* pane before/inside/after the caret in **both** directions, assert observed caret == expected mapped caret ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §11.2). May be headless or scripted manual.
- A7.2 **Propagation latency** — instrument the time from a human edit accepted into the model to the other pane's transaction applied, both directions. Capture a distribution (e.g. p50/p95), not a single number; the raw→rich path (reparse + `recreateTransform`) is the heavier one to watch (§6).
- A7.3 **No-drift check** — apply a randomized sequence of edits alternating panes for many cycles; assert the canonical Markdown is byte-identical to a single direct `serialize(parse(...))` of the final content (the anti-drift assertion, [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §11.3), and that converged states dispatch zero transactions.
- A7.4 **The success run**: type **500+ chars alternately in both panes**; record zero cursor jumps, no drift, sub-frame perceived latency.

**A8. Decision gate A (record it).** See **Decision gates** below.

### B. Spike B — Cloud undo-tree DAG

**B1. Throwaway Convex setup.**
- B1.1 A `convex dev` scratch deployment with the canon `docNodes` table and a `documents` row holding `currentNodeId` (canon field names verbatim, [`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md) §3.1; [`../blueprint/README.md`](../blueprint/README.md) §7). No auth, no user scoping — single throwaway document.
- B1.2 `docNodes.nodeId` = a client-generated **ULID** (lexicographically sortable, globally unique) per the stack table (`crypto.randomUUID()`/ULID, no extra dep where avoidable). Index by `by_document` and `by_document_node`.
- B1.3 A `docNodes.append` mutation (append-only, never mutates/deletes) and an `updateCurrentNodeId` mutation (the LWW pointer write).

**B2. Two-client append + union-merge.**
- B2.1 From two browser tabs/clients sharing the document, both offline-then-online (or just concurrent), append divergent branches from a shared ancestor `n2`: client A → `a3 → a4`, client B → `b3` ([`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md) §7.1).
- B2.2 On sync, verify the server's `docNodes` for the document is the **UNION** of both clients' nodes — distinct ULIDs, distinct `parentNodeId` chains, **zero conflict** (each node is a separate row; nothing to conflict on per [`../blueprint/README.md`](../blueprint/README.md) §7 *"separate rows, never an embedded array"*).
- B2.3 Verify both branches coexist after merge — the tree simply gained a branch.

**B3. Last-write-wins pointer convergence.**
- B3.1 Both clients write `documents.currentNodeId`; verify reconciliation is **last-write-wins** by `updatedAt` ([`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md) §7.1; [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §5). The device that synced "behind" sees its pointer overwritten but **loses no history** — every node it created is still in the union.
- B3.2 Confirm the pointer **converges** to a single value across both clients after sync.

**B4. Materialization (replay from nearest snapshot).**
- B4.1 Implement `materialize(targetNode)`: walk `parentNodeId` upward to the nearest node with a `snapshot`, start from that full Markdown, replay each `patch` forward down the ancestry chain ([`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md) §5.1). `patch` is a compact delta of canonical Markdown vs the parent's materialized state.
- B4.2 Store an occasional full `snapshot` (every *N* nodes) so replay length is bounded.
- B4.3 Navigate to an **arbitrary** node (any node, including a sibling on the other client's branch) and assert the materialized Markdown **exactly reproduces** the state that node represented when written.

**B5. Stub additive restore.**
- B5.1 Implement restore as **fork-forward**: append a *new* node equal to the chosen node's state and move the pointer there — it never rewinds or destroys history ([`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md) §10; [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §5.3). This is a **stub** to confirm the shape — not the version-control product.
- B5.2 Confirm restore is additive: the pre-restore branch remains reachable in the DAG.

**B6. Storage/retention probe (informs the fallback).**
- B6.1 Sanity-check growth: nodes are separate rows (the document value never bloats), delta-encoded `patch` with periodic `snapshot`. Confirm a single value stays well under the ~1 MiB Convex ceiling ([`../blueprint/README.md`](../blueprint/README.md) §7; [`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md) §8).
- B6.2 Note (do not fully implement) what a retention policy would prune: deep, old, abandoned branches with no tagged node — informs the depth-cap/retention fallback below.

**B7. Decision gate B (record it).** See **Decision gates** below.

### C. Decision gates (the deliverable)

**C1. Resolve Spike A** — confirm the production approach or select the fallback (below). Record the throttle value, the pinned `recreateTransform` package+version, and the measured latency/cursor evidence.

**C2. Resolve Spike B** — confirm union-merge + LWW pointer + materialization, or select the retention/depth fallback. Record snapshot cadence observed and any growth concern.

**C3. Write the decisions down** so Phases 1–4 can rely on them. The blueprint names [`../blueprint/14-tech-decisions.md`](../blueprint/14-tech-decisions.md) as the home of these ADR-style outcomes (the bridge fallback decision is explicitly recorded there per [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §12); record both gate outcomes there, and reference them from the [`./README.md`](./README.md) risk register.

---

## Technical approach & key decisions

**The one architectural rule under test (D2).** There is a single canonical document; every mode is a *view* of it; modes never convert between two competing formats ([`../blueprint/README.md`](../blueprint/README.md) §2). Spike A tests that this holds *live* with two engines editing one MDAST; Spike B tests that the *history* of that one model union-merges and materializes correctly. Neither spike introduces a second source of truth.

**Spike A — bridge mechanics (from [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md)):**
- **MDAST is the bus.** Milkdown's ProseMirror doc *is* the MDAST (no conversion, §2). The raw string is *derived* by `remark-stringify`, re-absorbed by `remark-parse`.
- **Stable serialization is non-negotiable.** A single frozen `CANONICAL_STRINGIFY` everywhere makes serialization a pure function of the tree, which is what keeps the §3 diff minimal (usually empty) and prevents progressive round-trip drift (the TipTap #7147 class of bug, §10). The spike must demonstrate this empty-diff steady state.
- **Diff-based propagation, never whole-doc replace.** Rich→raw = minimal text range (prefix/suffix trim) → one CM transaction; raw→rich = `recreateTransform` doc-diff → steps → one PM transaction. Whole-document `setContent`/`replaceWith` is **rejected** (§3, §4) because it collapses selection and scroll — the exact jank this phase exists to avoid.
- **Three overlapping guards** (defence in depth, §5): annotation/meta tag, applying counter, monotonic version. A programmatic update can never satisfy `shouldPropagate`, so the loop provably terminates; `isStale` collapses contested same-window edits to a single fixpoint.
- **Throttle is upstream of and independent from Convex persistence.** ~30–60 ms trailing throttle keeps the two panes in sync; Convex debounce (500 ms–1 s) is a separate timer for a separate concern ([`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §6; [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §2). The spike does not need the Convex timer.
- **Key decision to make:** the exact throttle window, and the exact `recreateTransform` build. Both are explicitly deferred by the blueprint to this spike.

**Spike B — undo-tree mechanics (from [`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md) + [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md)):**
- **Append-only + immutable is what makes merge tractable.** Two devices' node sets **union-merge with zero conflict** because nodes are never edited — there is no "edit the same node two ways" case ([`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md) §7). Convex stores each node as a separate row, so two devices inserting different nodes never write the same row.
- **The only mutable field is `documents.currentNodeId`, reconciled LWW** by `updatedAt`. A behind device's pointer is overwritten but **no history is lost** — the version layer is the explicit safety net.
- **No CRDT/Yjs/prosemirror-sync (D10).** Single-user; the append-only immutable shape gives conflict-free history merge for free ([`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §7). The spike must *not* reach for a CRDT to solve merge — that would invalidate the test.
- **Convex OCC serializes overlapping writes for free** (retries the loser up to ~32×, [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §5.1); the spike relies on it for node inserts and the pointer write rather than building locking.
- **Materialization = replay from nearest snapshot** ([`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md) §5.1). `patch` is relative to the **parent's materialized state** (not an absolute base) — this relativity is exactly what makes union-merge conflict-free.
- **Restore is additive (fork-forward), never destructive** ([`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md) §10). The stub must demonstrate additivity, not rewind.

**Performance contract (D11) holds even in the spike.** The local editor owns live state; never bind an editor's value to a reactive `useQuery` result — it clobbers the cursor ([`../blueprint/README.md`](../blueprint/README.md) Conventions; [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §1). Spike A's editors own their state in memory; Spike B's pointer/node reads are not the live editor render path.

---

## Libraries introduced

Pinned to the versions the spike resolves; recorded in the decision. These are spike-scoped, but they are the same libraries Phases 1–2 will use (per [`../blueprint/README.md`](../blueprint/README.md) §6 Stack), so version choices made here carry forward.

| Library | Purpose in the spike | Blueprint ref |
|---|---|---|
| `milkdown` (+ `@milkdown/preset-commonmark`, `@milkdown/preset-gfm`) | Rich-text engine; ProseMirror doc that *is* MDAST (**D3**) | README §6, `05` §2 |
| `@codemirror/state`, `@codemirror/view`, `@codemirror/lang-markdown` | Raw-text engine (**D4**); transactions, annotations, `ChangeSet` | README §6, `05` §3 |
| `unified`, `remark-parse`, `remark-stringify` | Canonical AST parse/serialize (**D1**) | README §6, `05` §2.1 |
| `remark-gfm`, `remark-frontmatter` | So the representative content set (tables, footnotes, frontmatter) parses (**D7**) | README §8, `06` |
| `prosemirror-recreate-steps` (**pin exact build** — or `@manuscripts/prosemirror-recreate-steps` / `prosemirror-recreate-transform`; same `recreateTransform` API) | Doc-diff → steps for raw→rich (**D-stack**) | README §6, `05` §4 |
| `convex` (dev deployment, throwaway) | Spike B append-only `docNodes` + LWW pointer | README §6, `07` §7, `10` |
| ULID generation (`crypto.randomUUID()` or a small ULID lib if sortability needed) | `docNodes.nodeId` (**no uuid dep**) | README §6, `07` §3.1 |

> **Not introduced** here: Better Auth, `react-resizable-panels`, `cmdk`, Tailwind v4 / shadcn, `@replit/codemirror-vim`, `remark-rehype`/`rehype-sanitize`. Those belong to later phases and are out of scope above.

---

## Data-model changes

**No production schema is committed in Phase 0.** The Spike B Convex deployment is throwaway. It exercises the **canon contract** (names verbatim, do not rename — [`../blueprint/README.md`](../blueprint/README.md) §7, [`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md) §3.1):

```ts
// documents — spike subset (no auth/title/wordCount needed beyond the pointer)
documents: {
  markdown: string,         // canonical serialized Markdown
  currentNodeId: string,    // pointer INTO docNodes; LWW across clients
  updatedAt: number,        // LWW reconciliation key
}

// docNodes — append-only, IMMUTABLE branching undo-tree DAG
docNodes: {
  documentId: Id<"documents">,
  nodeId: string,           // client-generated ULID; globally unique
  parentNodeId: string | null,
  patch: string,            // compact delta of canonical Markdown vs parent's materialized state
  snapshot?: string,        // OCCASIONAL full Markdown snapshot, for fast materialization
  selection: { anchor: number, head: number } | null,
  origin: string,           // client id that created the node
  createdAt: number,
}
// indexes: by_document (documentId), by_document_node (documentId, nodeId)
```

- **Not touched in the spike:** `versions`, `workspaces`, the full `documents` field set (`userId`, `title`, `wordCount`, `createdAt`). The `versions` table's pinning of tagged nodes is only *noted* in B6 to inform retention; it is not created. Full validators/indexes are owned by [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md) and committed in Phase 1.
- **Snapshot cadence and patch/delta format** are owned by [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md); the spike picks a working cadence (every *N* nodes) and records what it observed.

---

## Acceptance / exit criteria

A phase is done only when **all** exit criteria pass plus the global Definition of Done in [`./README.md`](./README.md) (types & lint clean via `bun run typecheck` / `bun run biome check`; snappy; no data-loss regressions). For Phase 0 specifically:

**Spike A — live two-mode bridge:**
- [x] One Milkdown pane and one CodeMirror pane edit **one** in-memory remark MDAST; neither engine is the source of truth (the model is).
- [x] A single frozen `CANONICAL_STRINGIFY` is the only serializer used; for a given MDAST it produces exactly one string deterministically.
- [x] Rich→raw dispatches **only** the minimal changed range (one CM transaction), tagged with the bridge annotation, `scrollIntoView: false`.
- [x] Raw→rich applies **only** `recreateTransform` steps to the live PM doc; selection is mapped through the mapping; `addToHistory: false`.
- [x] In steady state (panes converged), **zero** transactions are dispatched in either direction (the `next === prev` / `curDoc.eq(nextDoc)` short-circuits fire).
- [x] A single human edit yields exactly **one** `bumpVersion` and **zero** further human-classified changes (no echo) — feedback-loop assertion passes.
- [x] **Success run:** typing **500+ chars alternately in both panes** produces **zero cursor jumps** in either pane.
- [x] **No drift:** after a randomized alternating-pane edit sequence over many cycles, the canonical Markdown is **byte-identical** to a single direct `serialize(parse(...))` of the final content.
- [x] **Latency:** measured propagation latency (both directions, distribution captured) is **sub-frame perceived** with the chosen throttle window; the window (within 30–60 ms) is recorded.
- [x] The exact `recreateTransform` package + version is pinned and recorded.
- [x] **Decision A recorded** in [`../blueprint/14-tech-decisions.md`](../blueprint/14-tech-decisions.md): production bridge **confirmed**, or the §12 **fallback selected** with the measured reasons.

**Spike B — cloud undo-tree DAG:**
- [x] `docNodes` is append-only and immutable; editing always appends; no node is mutated or deleted in normal flow.
- [x] Two clients append divergent branches from a shared ancestor; on sync the server `docNodes` is the **UNION** of both, with **zero conflict** (distinct ULIDs, distinct parent chains).
- [x] **Both branches coexist** after merge (the tree gained a branch).
- [x] `documents.currentNodeId` is **last-write-wins** by `updatedAt` and **converges** to one value across both clients; the behind client loses no history.
- [x] `materialize(node)` walks to the nearest ancestor `snapshot` and replays `patch` forward; **navigating to an arbitrary node reproduces its exact state** (including a node on the *other* client's branch).
- [x] **Stub additive restore** forks forward (appends a node, moves the pointer) and the pre-restore branch remains reachable.
- [x] A single value stays well under the ~1 MiB Convex ceiling (history lives in separate rows; delta-encoded `patch` + periodic `snapshot`).
- [x] **Decision B recorded** in [`../blueprint/14-tech-decisions.md`](../blueprint/14-tech-decisions.md): production undo-tree **confirmed**, or the retention/depth **fallback selected** with reasons.

**Phase-level exit:**
- [x] **Both spikes resolved** (proven, or fallback chosen) and **both decisions written down** so Phases 1–4 can rely on them.
- [x] Spike code is quarantined/deleted (throwaway) — only the recorded decisions carry forward.

---

## Risks & mitigations

These are the carried risks from the [`./README.md`](./README.md) risk register that this phase exists to retire, plus spike-local risks.

| Risk | Mitigation in this phase | Fallback if the spike fails |
|---|---|---|
| **Live two-mode sync is janky** (cursor jumps, feedback loops) — the reason Spike A exists | MDAST bus; frozen `CANONICAL_STRINGIFY`; minimal text diff (rich→raw) + `recreateTransform` steps (raw→rich); three origin guards; trailing throttle; measured cursor-stability + latency harness | **Per [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) §12:** a single pane uses **switch-on-mode only** (lossless handoff via the model, §8.2); **cross-pane live editing limited to *different* documents**; same doc may appear in a second pane only as read-only **Preview**. Relaxes **only D6**; **D1–D5** and losslessness intact. |
| **Cloud undo-tree storage growth / merge bugs** — the reason Spike B exists | Append-only immutable nodes (union-merge, zero conflict); LWW pointer; delta-encode `patch` with periodic `snapshot`; separate rows so the document never bloats | **Cap depth / tune retention:** keep all recent + every tagged node (+ ancestor chain to a snapshot) forever; prune deep, old, abandoned, untagged branches as a background op that never mutates a surviving node ([`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md) §8). |
| **`recreateTransform` is too slow** on the raw→rich path under fast input | Throttle the heavier reparse+diff path (§6); measure p95 latency; keep `wordDiffs: false` for character-granular, smaller steps | Lengthen the throttle, or fall into the bridge §12 fallback (switch-on-mode) for same-doc two-mode editing. |
| **`prosemirror-recreate-steps` lags ProseMirror core / publish drift** | Pin the exact working build; the maintained scoped variants share the identical API | Switch to `@manuscripts/prosemirror-recreate-steps` or `prosemirror-recreate-transform`; record which. |
| **`remark-stringify` is non-deterministic across versions** (would break the empty-diff steady state) | Freeze `CANONICAL_STRINGIFY`; verify the convergence property A2.2 before measuring | Coordinate the exact knob values with [`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md); pin remark versions. |
| **Pointer-write LWW loses the user's active state** (rare two-device clobber) | LWW is by `updatedAt`; behind-client pointer overwritten but **history never lost** (union holds every node) | The version layer ([`../blueprint/08-version-control.md`](../blueprint/08-version-control.md)) is the durable safety net; any abandoned-but-unpruned node stays navigable ([`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) §5.3). |
| **Convex ~1 MiB per-value ceiling** | History in separate rows; delta-encoded patches; periodic snapshots bound replay | Per-section splitting (only if book-length becomes a need — a documented v1 non-goal). |
| **Spike scope creep** (building product UI / persistence wiring not needed to de-risk) | The Out-of-scope list is explicit; the spike is throwaway and measures only the two mechanisms | Re-read Out of scope; delete anything not serving a decision gate. |

---

## References

**Plan:**
- [`./README.md`](./README.md) — phase map, Definition of Done, conventions, the carried risk register.
- [`./phase-1-foundation.md`](./phase-1-foundation.md) — the real foundation built on top of these confirmed mechanisms.
- [`./phase-2-modes-and-losslessness.md`](./phase-2-modes-and-losslessness.md) — full dialect, round-trip corpus, mode switching.
- [`./phase-4-history.md`](./phase-4-history.md) — undo-tree visualizer + version history product UI.

**Blueprint (canon):**
- [`../blueprint/README.md`](../blueprint/README.md) — locked decisions **D1–D15**, canonical schema, dialect, glossary, "the three hard parts".
- [`../blueprint/05-lossless-bridge.md`](../blueprint/05-lossless-bridge.md) — the live two-mode bridge (Spike A's spec); §12 is the fallback Spike A may select.
- [`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md) — the branching undo-tree DAG (Spike B's spec); §7 union-merge, §5.1 materialization, §8 retention fallback.
- [`../blueprint/10-sync-persistence.md`](../blueprint/10-sync-persistence.md) — debounced LWW persistence, OCC, the clobber window, the performance contract (**D11**).
- [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md) — exact validators/indexes and the patch/snapshot/delta format (committed in Phase 1).
- [`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) — owns the frozen serialization knobs and the round-trip corpus the bridge consumes.
- [`../blueprint/14-tech-decisions.md`](../blueprint/14-tech-decisions.md) — where both Phase 0 decision-gate outcomes are recorded as ADRs.

**External:**
- TipTap issue #7147 (markdown round-trip drift): <https://github.com/ueberdosis/tiptap/issues/7147>
- Quarto visual editor "canonical Markdown": <https://quarto.org/docs/visual-editor/markdown.html>
- `prosemirror-recreate-steps` (`recreateTransform`): doc-diff → steps; scoped variants share the API.
- Convex OCC: <https://docs.convex.dev/database/advanced/occ> · Optimistic updates: <https://docs.convex.dev/client/react/optimistic-updates>
- Vim undo tree: <https://vimhelp.org/undo.txt.html> · undotree: <https://github.com/mbbill/undotree>
