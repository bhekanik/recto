# Recto — Implementation Plan

> **This directory describes how Recto gets built and in what order.** It is the execution companion to [`../blueprint/`](../blueprint/README.md), which describes *what* we are building. Read [`../blueprint/README.md`](../blueprint/README.md) first — it holds the locked decisions, the canonical Convex schema, the Markdown dialect, and the glossary that every phase below assumes.

Each phase file is **self-contained**: it restates its own goal, prerequisites, work breakdown, technical approach, the data-model and dependencies it touches, explicit out-of-scope items, testable exit criteria, and risks. You should be able to hand a single phase file to an implementer and have them execute it without reading the others (though they should read the blueprint).

**Current status:** Phase 0–2 are complete. Next up: [Phase 3 — Multi-doc, split & workspace](./phase-3-multi-doc-split-workspace.md).

---

## Why phased, and why this order

Recto has two genuinely novel, unproven mechanisms — **live two-mode editing of one document** and a **cloud-persisted branching undo tree**. If either cannot be made smooth, the user-facing design changes. So the plan front-loads them as throwaway spikes (Phase 0) and only builds product UI on top of mechanisms that are proven. After that, the order follows dependency: a single editing surface that syncs and never loses words → the full set of modes with lossless switching → multiple documents, splitting, and workspace restore → the history UX → polish, clipboard, and export.

---

## Phase map

| Phase | Title | Goal in one line | Blueprint refs | Status |
|-------|-------|------------------|----------------|--------|
| [0](./phase-0-spikes.md) | **Spikes** | Prove the live two-mode bridge and the cloud undo-tree DAG, or choose fallbacks — before any product UI | `05`, `07`, `10` | ✅ Done |
| [1](./phase-1-foundation.md) | **Foundation** | Next.js + Convex + Better Auth + dark shell; document CRUD; one rich-text surface that syncs and never loses words; live word count | `02`, `03`, `10`, `12` | ✅ Done |
| [2](./phase-2-modes-and-losslessness.md) | **Modes & losslessness** | Add raw Markdown, Vim, and preview; lossless mode switching; slash palette; full GFM + footnotes + frontmatter with round-trip tests | `04`, `05`, `06`, `13` | ✅ Done |
| [3](./phase-3-multi-doc-split-workspace.md) | **Multi-doc, split & workspace** | Document switcher; nested split panes; same-doc-two-live-modes; workspace persistence and cross-device resume | `09`, `10` | — |
| [4](./phase-4-history.md) | **History** | Undo-tree visualizer wired to the persisted DAG; version history with auto + manual tags; additive restore | `07`, `08` | — |
| [5](./phase-5-polish-and-export.md) | **Polish & export** | Command palette; clipboard (html+plain) and copy-as-markdown; export .md / .html; bespoke design pass | `11`, `12`, `13` | — |

---

## Definition of Done (every phase)

A phase is done only when **all** of these hold:

1. **Exit criteria pass** — each phase lists concrete, testable criteria; all are demonstrably met (ideally with an automated test or a recorded manual check).
2. **Types & lint clean** — `bun run typecheck` and `bun run biome check` pass with no errors.
3. **No data-loss regressions** — refresh, navigate away, and (from Phase 1 on) switch devices without losing content; the relevant round-trip / persistence tests are green.
4. **Snappy** — typing introduces no perceptible input latency; sync work is debounced off the hot path; mode switches feel instant.
5. **Self-contained docs updated** — if the implementation deviated from the blueprint, the blueprint file is updated (it is the source of truth) and the deviation is noted.

---

## Conventions

- **Runtime / package manager:** bun. Scripts: `bun run dev`, `bun run typecheck`, `bun run biome check`, `bun run test`.
- **Language:** TypeScript strict, ESM only. Prefer built-in language features and battle-tested libraries over custom implementations.
- **Backend:** Convex functions are the only write path to persistent state. The editor never writes directly; it calls debounced mutations (see `../blueprint/10-sync-persistence.md`).
- **Performance contract:** the live editor owns its state; never bind an editor's value directly to a reactive `useQuery` result (it will clobber the cursor). Hydrate on open/idle only.
- **Commits:** Conventional style, `type: description`. **No AI attribution, no Co-Authored-By lines, author is the user only.** Commit/push only when explicitly asked.
- **Blast radius:** touch only what a task needs; surface unrelated observations as suggestions, don't act on them.
- **Testing:** round-trip property tests for the Markdown dialect (Phase 2) and persistence/merge tests for the undo DAG (Phases 0/4) are not optional — they guard the two core promises (lossless, never-lose-work).

---

## Risk register (carried across phases)

| Risk | Phase | Mitigation | Fallback |
|------|-------|------------|----------|
| Live two-mode sync is janky (cursor jumps, feedback loops) | 0, 3 | Spike first; MDAST bus; origin-guard; throttle; diff-based updates | **Phase 0 resolved (ADR-15): bridge confirmed** — §12 fallback not needed. Same-pane degrades to switch-on-mode only if regressions appear in Phase 2+ |
| Cloud undo-tree storage growth / merge bugs | 0, 4 | Append-only immutable nodes; union-merge; delta encoding; periodic snapshots; retention policy | **Phase 0 resolved (ADR-16): undo-tree confirmed** — retention fallback deferred; monitor in Phase 4 |
| Footnotes / tables don't round-trip | 2 | remark-native AST; explicit serialize rules; property-test corpus | Narrow the dialect (documented), never silently drop |
| Convex ~1 MiB per-document ceiling | 1, 4 | Markdown string is small for articles; history in separate rows | Per-section splitting (only if book-length becomes a need) |
| Same doc edited on two devices within debounce window | 1, 3 | Local-owns-live; version-history safety net; stale-version guard | Accept rare last-write-wins; restore from version history |
| Cursor clobbered by reactive sync | 1 | Editor owns live state; hydrate on open/idle only | — |

---

## How to use these docs with an implementing agent

1. Point the implementer at [`../blueprint/README.md`](../blueprint/README.md) for canon.
2. Hand them exactly one phase file.
3. Require the phase's exit criteria + the global Definition of Done before moving on.
4. Phases are sequential. Do not start Phase _N+1_ until Phase _N_ is done — except Phase 0 spikes, which are throwaway and inform (not block) the Phase 1+ design.
