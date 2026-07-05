# Plan 014: Retention must not orphan open review branches; GC closed review branches

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat e8058fe..HEAD -- convex/retention.ts convex/review.ts convex/crons.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (touches the retention keep-set — a mistake prunes user history)
- **Depends on**: plans/013-document-delete-gc.md (both edit `convex/crons.ts`; run 013 first)
- **Category**: bug
- **Planned at**: commit `e8058fe`, 2026-07-05

## Why this matters

The daily retention sweep and the review-collaboration feature (plans 010/011)
don't know about each other:

1. **Dangling open branches.** The keep-set keeps only the owner's spine,
   tagged-version chains, and nodes newer than 30 days. A reviewer's suggestion
   branch lives in `docNodes` too (origins like `review-append`), but its head
   is *not* on the owner's spine and *not* tagged. If an open review branch sits
   idle for >30 days, the sweep deletes its nodes while the `reviewBranches` row
   (status `open`, pointing at `headNodeId`) survives — materializing that head
   for the review surface then throws. A reviewer's un-actioned work is
   destroyed and the review UI breaks.
2. **`reviewBranches` rows are never GC'd.** `rejectBranch` only flips status —
   its comment says "The abandoned branch subtree is pruned later by the
   retention cron (plan 010)", which is true for the *nodes* but the row itself
   is deleted only on full document delete. Accepted/rejected rows accumulate
   forever.

## Current state

- `convex/retention.ts:21-41` — the keep-set. Verbatim:
  ```ts
  function computeKeepSet(
      nodes: Node[],
      currentNodeId: string,
      taggedNodeIds: Set<string>,
      now: number,
  ): Set<string> {
      const byId = new Map(nodes.map((n) => [n.nodeId, n]));
      const keep = new Set<string>();

      for (const id of ancestorChain(currentNodeId, byId)) keep.add(id);
      for (const tag of taggedNodeIds) {
          if (byId.has(tag)) for (const id of ancestorChain(tag, byId)) keep.add(id);
      }
      for (const node of nodes) {
          if (node.createdAt >= now - RETENTION_WINDOW_MS) keep.add(node.nodeId);
      }
      for (const id of [...keep]) {
          for (const ancestorId of ancestorChain(id, byId)) keep.add(ancestorId);
      }
      return keep;
  }
  ```
  No `reviewBranches` input. `RETENTION_WINDOW_MS` = 30 days (line 4).
- `convex/retention.ts:49-80` — `sweep` iterates all documents, loads that doc's
  `docNodes` + `versions`, computes the keep-set, deletes the rest.
- `convex/schema.ts:70-84` — `reviewBranches`: `{ documentId, reviewerUserId,
  baseNodeId, headNodeId, status: "open"|"accepted"|"rejected", createdAt,
  updatedAt }`, indexes `by_document` and `by_document_reviewer`.
- `convex/review.ts:781-800` — `rejectBranch` patches `status: "rejected"` only;
  the doc comment (lines 780-782) promises cron pruning.
- Repo invariant (do not violate): retention is **append-only-safe** — it only
  deletes whole abandoned subtrees, never rewrites surviving nodes, never
  orphans a snapshot a survivor depends on (ancestor chains are kept). See the
  `sweep` doc comment at `convex/retention.ts:43-48`.

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Typecheck | `bun run typecheck`  | exit 0              |
| Lint      | `bun run biome`      | exit 0              |
| Tests     | `bun run test`       | all pass            |
| Manual sweep run (dev) | `bunx convex run retention:sweep` (internal — use `bunx convex run` with `--push` semantics the repo already uses; plans/README.md used `bunx convex run embeddings:reindexSweep`) | `{ pruned: N }` |

## Scope

**In scope**:
- `convex/retention.ts`
- `convex/review.ts` (only the `rejectBranch` doc comment if wording changes; no behavior)
- `convex/crons.ts` (only if you schedule branch-row GC as part of the existing sweep — prefer extending `retention.sweep` itself, which needs no crons.ts change)
- `convex/retention.test.ts` (create) or the existing test file that covers retention if one exists (search first: `grep -rln "computeKeepSet\|retention" --include="*.test.ts" .`)

**Out of scope**:
- `convex/documents.ts`, `convex/files.ts` — plan 013 territory.
- Any change to accept/reject/merge semantics in `convex/review.ts`.
- Client code.

## Git workflow

- Work on `main` (single-author repo) unless told otherwise.
- Conventional commit, e.g. `fix: retention keeps open review branches, GCs closed ones`.
- No AI attribution. Don't push unless asked.

## Steps

### Step 1: Feed open-branch heads into the keep-set

In `retention.sweep`, per document, load `reviewBranches` via the `by_document`
index. Pass the head nodeIds of branches with `status === "open"` into
`computeKeepSet` (new parameter, e.g. `protectedNodeIds: Set<string>`) and keep
their full ancestor chains — exactly like tagged nodes are treated today.

`baseNodeId` does not need separate protection: it is an ancestor of
`headNodeId` by construction, so the ancestor chain covers it. Verify that
assumption while coding (read `convex/review.ts` `reviewerAppend` /
`appendSuggestion` — the branch grows by appending children from the base). If
it doesn't hold, protect `baseNodeId` chains too.

**Verify**: `bun run typecheck` → exit 0.

### Step 2: GC closed branch rows

In the same per-document loop, delete `reviewBranches` rows whose status is
`accepted` or `rejected` AND whose `updatedAt` is older than
`RETENTION_WINDOW_MS`. Their nodes stop being protected (rejected-branch nodes
were never protected; accepted branches' merged result lives on the owner's
spine — the merge node was appended to the spine by `acceptBranch`), so the
existing node-prune logic handles the subtree naturally.

Update the `rejectBranch` doc comment in `convex/review.ts` so its promise
matches reality ("nodes pruned + row GC'd by the retention cron after the
30-day window").

**Verify**: `bun run typecheck && bun run biome` → exit 0.

### Step 3: Tests

Find the harness pattern first (`spikes/undo-tree/tests/convex.bun.test.ts` for
convex-test; `lib/review/access.test.ts` / `lib/review/security-hardening.test.ts`
for review fixtures). Cover, with nodes aged past the 30-day window (inject
`createdAt`/`updatedAt` directly in test inserts):

1. Open branch, idle > 30 days → its head + chain survive the sweep; the branch
   still materializes.
2. Rejected branch, > 30 days → its off-spine nodes are pruned AND the row is
   deleted.
3. Accepted branch, > 30 days → row deleted; owner's spine (including the merge
   node) untouched.
4. Regression: the pre-existing keep-set behavior (spine + tagged + recent) —
   assert a tagged old node still survives.

**Verify**: `bun run test` → all pass, including the 4 new cases.

### Step 4: Live smoke (dev)

Run the sweep against dev and confirm `{ pruned }` returns and the review
surface still opens for any existing shared doc.

**Verify**: `bunx convex run retention:sweep` → returns without error.

## Test plan

See Step 3 — four cases in `convex/retention.test.ts`, modeled on the
spike convex-test harness. Existing suite stays green.

## Done criteria

- [ ] `bun run typecheck`, `bun run biome`, `bun run test` all exit 0
- [ ] `computeKeepSet` (or its caller) demonstrably protects open-branch chains (test 1)
- [ ] Closed `reviewBranches` rows older than the window are deleted by the sweep (tests 2–3)
- [ ] `rejectBranch` doc comment matches the implemented lifecycle
- [ ] No behavior change to accept/reject/merge mutations (`git diff convex/review.ts` shows comments only)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- Reading `convex/review.ts` shows accepted branches do NOT append their merge
  node to the owner's spine (the Step 2 GC assumption) — pruning would then
  destroy accepted content.
- `baseNodeId` turns out not to be an ancestor of `headNodeId` (Step 1
  assumption) and protecting it changes sweep behavior beyond this plan's scope.
- Any existing retention/undo-tree test fails after your change and the fix
  isn't obviously in your new code.

## Maintenance notes

- If a "re-open rejected branch" feature ever lands, row GC must move from
  status-based to status+age-based with a longer window — revisit Step 2.
- The deferred *depth-cap* retention fallback (blueprint ADR-16, "monitor")
  remains deliberately unbuilt; this plan does not implement it. If `docNodes`
  growth becomes a problem, that's a separate plan.
- Reviewer: scrutinize test 1 — it is the data-loss guard.
