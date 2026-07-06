# Plan 022: Fix the undo-after-AI-accept pointer race (editor blanks, empty markdown syncs up)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat <planned-at SHA>..HEAD -- lib/history/use-document-history.ts lib/studio/use-ai-features.ts e2e/ai-accept-reject.spec.ts`
> On a mismatch with the "Current state" excerpts, STOP.

## Status

- **Priority**: P1 (visible data loss, recoverable only via the undo-tree panel)
- **Effort**: M (investigation + fix + un-skip the e2e assertion)
- **Risk**: MED — touches the history pointer path that every edit flows through
- **Depends on**: none (plan 021's e2e harness is merged and is the reproduction vehicle)
- **Category**: bug
- **Planned at**: commit `d1386d8`, 2026-07-06

## Why this matters

Discovered live by the plan-021 e2e harness (2026-07-06): after accepting an AI
transform ("Keep"), pressing Undo sometimes navigates to a stale node — often
the empty UUID root — the editor blanks, and autosync then flushes `""` into
`documents.markdown`. The content is recoverable through the undo-tree panel
(the server DAG is correct), but to a writer this reads as their draft being
destroyed by a single Undo. The e2e spec `e2e/ai-accept-reject.spec.ts`
currently **self-skips** its undo assertion when the race bites; this plan's
end state is that assertion running un-skipped and green.

## Current state (evidence, not yet root-caused)

Harness-observed evidence (instrumented runs, 2026-07-06; instrumentation was
reverted and is NOT in the tree):

- After `commitProgrammatic` (AI "Keep"), the SERVER state is correct: the AI
  node is parented on the latest typed-text node and `documents.currentNodeId`
  points at the AI node.
- The CLIENT's `currentNodeIdRef` sometimes still holds the PRE-AI node id.
  Undo then computes that node's parent — frequently the empty root — and
  navigates there: logs showed `[undo] id: <pre-AI ULID>` then
  `[nav] to: <uuid-root> mdLen: 0` while the server pointer was the AI node.
- Suspected (NOT verified): a race in `lib/history/use-document-history.ts`
  between server rehydration (`setCurrentNodeId(serverCurrentNodeId)`) and the
  debounced pointer write / programmatic-commit path. Root-causing this is
  Step 1, not an assumption to build on.

Related, same file, confirmed by reading:

- `undo()` reads `currentNodeIdRef.current` and navigates to its parent
  (`lib/history/use-document-history.ts:300-307`).
- `navigateTo` writes the pointer via a fire-and-forget `updatePointer` with a
  200ms `navigatingRef` guard (`:286-295`).
- Secondary bug (fix if cheap, else report): keystrokes typed before the
  history controller hydrates are silently dropped (`recordChange` no-ops while
  the controller ref is null) — early harness runs produced AI nodes parented
  on the root/title-only node.

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Install   | `bun install`        | exit 0              |
| Typecheck | `bun run typecheck`  | exit 0              |
| Lint      | `bun run biome`      | exit 0              |
| Unit      | `bun run test`       | all pass            |
| E2E (repro + proof) | `bunx playwright test e2e/ai-accept-reject.spec.ts` | passes WITHOUT the self-skip after the fix |

E2E prerequisites: `.env.local` with dev Convex + Clerk keys (copy from the
operator's main checkout; never print or commit it) and a working
`OPENROUTER_API_KEY` on the dev deployment.

## Scope

**In scope**:
- `lib/history/use-document-history.ts` (the pointer/rehydration logic)
- `lib/studio/use-ai-features.ts` ONLY if the commit path must hand the fresh
  node id to the history hook (read before touching)
- `e2e/ai-accept-reject.spec.ts` (remove the bug-aware self-skip once fixed)
- New unit test alongside the existing history tests if the race can be
  captured at that level (attempt it — a deterministic unit repro beats e2e)

**Out of scope**:
- Any change to the server undo-tree model (`convex/docNodes.ts` etc.) — the
  server is provably correct here.
- The "early-input clobbered by async server seed" papercut (separate,
  documented in plans/README findings).
- Redesigning the debounced sync.

## Steps

### Step 1: Reproduce and root-cause

Run the AI spec repeatedly (`--repeat-each=5` or a small loop) with temporary
instrumentation on: `currentNodeIdRef` updates, `setCurrentNodeId` callers,
`commitProgrammatic`'s node id, and rehydration writes. Identify EXACTLY which
writer leaves `currentNodeIdRef` stale after the AI commit. Record the causal
chain in your report. Remove instrumentation before committing.

**Verify**: you can state the exact interleaving; the stale writer is named.

### Step 2: Fix minimally

Candidate shapes (choose based on Step 1, do not implement all):
- `commitProgrammatic` (or its caller) synchronously advances
  `currentNodeIdRef`/state to the newly created node id before returning.
- Rehydration ignores server pointers older than a locally-newer commit
  (monotonic guard) instead of overwriting unconditionally.
- `undo()` re-reads the freshest pointer source rather than a possibly-stale ref.

Also, if cheap and clearly safe: make `recordChange` buffer (or the controller
hydrate before first input) so pre-hydration keystrokes aren't dropped; if not
cheap, leave it and say so.

**Verify**: `bun run typecheck && bun run biome && bun run test` → exit 0.

### Step 3: Prove it

Remove the self-skip branch from `e2e/ai-accept-reject.spec.ts` so the undo
assertion always runs. Run the spec ≥5 times consecutively — all green.

**Verify**: `bunx playwright test e2e/ai-accept-reject.spec.ts --repeat-each=5` → 0 failures, 0 skips.

## Done criteria

- [ ] Root cause documented in the report (exact interleaving, exact writer)
- [ ] Undo immediately after AI accept restores the pre-transform text — e2e assertion un-skipped and green ×5
- [ ] No editor-blank/`""`-sync reproducible in those runs
- [ ] `bun run typecheck && bun run biome && bun run test` exit 0
- [ ] No instrumentation left in the diff
- [ ] `plans/README.md` status row updated

## STOP conditions

- Step 1 shows the stale pointer originates in the EDITOR bridge or Convex
  round-trip rather than the history hook — different blast radius, report.
- The fix appears to require changing `navigateTo`'s fire-and-forget pointer
  write into an awaited write on the typing path (input-latency risk) — report
  with the evidence instead of shipping it.
- The e2e spec cannot reproduce the race in ~10 attempts even before the fix —
  report; the fix would be unverifiable.

## Maintenance notes

- The 200ms `navigatingRef` window and the debounced pointer write are the
  likely interaction surface for any future race — a reviewer should scrutinize
  ordering guarantees there.
- If per-document AI provenance (direction option) lands later, it touches the
  same commit path — re-run the ×5 e2e proof then.
