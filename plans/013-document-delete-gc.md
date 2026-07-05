# Plan 013: Stop leaking embeddings and image blobs — complete the delete cascade and add an orphan-blob sweep

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat e8058fe..HEAD -- convex/documents.ts convex/files.ts convex/crons.ts convex/embeddings.ts convex/schema.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (a wrong reference check could delete a blob a document still renders)
- **Depends on**: none (execute before 014 — both edit `convex/crons.ts`)
- **Category**: bug
- **Planned at**: commit `e8058fe`, 2026-07-05

## Why this matters

Deleting a document leaks storage forever, on two paths:

1. **Embedding rows.** `documents.remove` cascades five tables (`docNodes`,
   `versions`, `documentShares`, `reviewBranches`, `comments`) but not
   `docChunks` — the RAG chunks for a deleted document sit in the vector index
   permanently. Worse than dead weight: `embeddings.ts` vector search filters by
   `userId`, not document liveness, so deleted-document text can keep surfacing
   in "related passages" results.
2. **Image blobs.** Images are uploaded to Convex `_storage` and referenced in
   markdown as `![alt](url)` where the servable URL embeds the storage id.
   There is no `ctx.storage.delete` anywhere in `convex/` — no delete mutation,
   no GC. Deleting a document (or just removing an image from the text) orphans
   the blob permanently. Storage grows without bound with document churn.

## Current state

- `convex/documents.ts:127-164` — the `remove` mutation. Cascade pattern (repeat
  this exact shape for `docChunks`):
  ```ts
  const nodes = await ctx.db
      .query("docNodes")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
  for (const node of nodes) await ctx.db.delete(node._id);
  ```
  The doc comment (lines 120–126) says it cascades "everything keyed
  by_document" — currently false for `docChunks`.
- `convex/schema.ts:109-126` — `docChunks` has `.index("by_document", ["documentId"])`,
  so the cascade addition is symmetric with the other five.
- `convex/files.ts` (29 lines) — only `generateUploadUrl` + `getImageUrl`.
  No delete anywhere.
- `lib/editor/image-upload.ts:36-38` — after upload, the client resolves
  `storageId` → servable URL via `api.files.getImageUrl` and inserts that URL
  into the markdown. Convex servable URLs have the storage id in the URL
  (`.../api/storage/<storageId>`), so a blob is "referenced" iff its storage id
  appears as a substring of some markdown text.
- Reachable markdown lives in TWO places: `documents.markdown` (live text) and
  `docNodes` rows (snapshots + patches — history that restore can resurrect).
  `versions` rows point at nodeIds and hold no markdown of their own.
- `convex/crons.ts` (23 lines) — two daily crons exist (`retention.sweep` 08:00
  UTC, `embeddings.reindexSweep` 09:00 UTC). Model the new cron on these.
- `convex/retention.ts:49-80` — exemplar `internalMutation` sweep that iterates
  all documents and deletes in a loop. Note it is an `internalMutation`;
  **storage access from a cron works in both mutations and actions, but listing
  `_storage` requires `ctx.db.system`** (see Step 3).
- Convex conventions in this repo: single-user scoping via `requireUserId` /
  `requireOwnedDocument` (`convex/documents.ts` top); crons call `internal.*`
  functions only.

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Install   | `bun install`        | exit 0              |
| Typecheck | `bun run typecheck`  | exit 0              |
| Lint      | `bun run biome`      | exit 0              |
| Tests     | `bun run test`       | all pass            |
| Convex codegen (after schema/function edits) | `bun run convex:codegen` | exit 0, `_generated` updated |
| Manual sweep run (dev) | `bunx convex run files:orphanSweep` (adjust to final name) | JSON result `{ scanned, deleted }` |

## Scope

**In scope**:
- `convex/documents.ts` (extend `remove` cascade + its doc comment)
- `convex/files.ts` (add the orphan sweep)
- `convex/crons.ts` (schedule the sweep)
- `convex/files.gc.test.ts` or extend an existing convex-test file (create tests)
- `convex/_generated/*` (regenerated, committed as the repo does)

**Out of scope** (do NOT touch):
- `convex/retention.ts` — plan 014 owns changes there; you only *read* it as an exemplar.
- `convex/embeddings.ts` — the stale-doc scan logic is fine once chunks are
  cascade-deleted; do not "fix" it.
- Client code (`lib/`, `components/`) — no UI change is part of this plan.

## Git workflow

- Work on `main` (single-author repo) unless told otherwise.
- Conventional commits, e.g. `fix: cascade docChunks on document delete` and
  `feat: orphaned image blob GC sweep`. No AI attribution. Don't push unless asked.

## Steps

### Step 1: Cascade `docChunks` in `documents.remove`

In `convex/documents.ts` `remove`, after the `comments` loop (line ~160), add the
same collect-and-delete block for `docChunks` using its `by_document` index.
Update the function's doc comment to list `docChunks`.

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Test the cascade

The repo tests Convex functions with `convex-test` (see
`spikes/undo-tree/tests/convex.bun.test.ts` for the harness pattern and any
existing `convex/*.test.ts` / `lib/review/access.test.ts` for auth-context
patterns). Write a test: create a document, insert two `docChunks` rows for it
(directly via the test harness `t.run(async (ctx) => ctx.db.insert(...))`),
call `documents.remove`, assert `docChunks` for that documentId is empty.

**Verify**: `bun run test -- files.gc` (or the chosen filter) → new test passes.

### Step 3: Add the orphan-blob sweep to `convex/files.ts`

Add an `internalMutation` (name it `orphanSweep`) that:

1. Collects the set of referenced storage ids: scan every `documents.markdown`
   and every `docNodes` row's text fields (both `snapshot` and `patch` content —
   check the actual field names in `convex/schema.ts` / `convex/docNodes.ts`
   before coding), extracting storage-id substrings. Simplest robust check:
   for each stored file, test whether its id string appears in any of those
   texts. To keep it O(files + texts): concatenate is NOT acceptable for memory;
   instead build one pass — collect all text rows once, then for each file id do
   `texts.some((t) => t.includes(id))`. Document count is single-user-small;
   if this proves heavy, fall back to scanning only `documents.markdown` +
   `docNodes` snapshots and treat patch-only references as kept (conservative).
2. Lists stored files via `ctx.db.system.query("_storage").collect()`.
3. Deletes (`ctx.storage.delete(file._id)`) every file that is (a) unreferenced
   AND (b) older than a 24-hour grace window (`_creationTime < now - 24h`) —
   the grace window prevents racing an upload whose markdown insert hasn't
   synced yet.
4. Returns `{ scanned, deleted }`.

**Verify**: `bun run convex:codegen && bun run typecheck` → exit 0.

### Step 4: Schedule it

In `convex/crons.ts`, add a daily cron (pick 10:00 UTC — after retention at
08:00 so freshly-pruned `docNodes` don't hold references) calling
`internal.files.orphanSweep`, with a comment matching the existing two.

**Verify**: `bun run typecheck` → exit 0.

### Step 5: Test the sweep

convex-test supports storage (`t.run` gives `ctx.storage.store` /
`ctx.db.system.query("_storage")`). Cover:

- referenced blob (id present in a live document's markdown) → kept
- referenced only in a `docNodes` snapshot (not live markdown) → kept
- unreferenced + older than grace window → deleted
- unreferenced but fresh (< 24h) → kept

If convex-test's clock cannot age a file past the grace window, make the window
an optional arg to the mutation (default 24h, tests pass 0). Do NOT weaken the
default.

**Verify**: `bun run test` → all pass, including the 4 new cases.

### Step 6: Live smoke (dev deployment)

**Verify**: `bunx convex run files:orphanSweep` against dev → returns
`{ scanned: N, deleted: M }` without error. If dev has real orphans, spot-check
the Convex dashboard storage tab afterward.

## Test plan

- New: `convex/files.gc.test.ts` — the cascade test (Step 2) + four sweep cases
  (Step 5), using the convex-test harness modeled on
  `spikes/undo-tree/tests/convex.bun.test.ts`.
- Existing suite must stay green: `bun run test` → exit 0.

## Done criteria

- [ ] `bun run typecheck`, `bun run biome`, `bun run test` all exit 0
- [ ] `documents.remove` deletes `docChunks` rows (test proves it)
- [ ] `internal.files.orphanSweep` exists, is cron-scheduled, and passes the four reference-check tests
- [ ] `grep -n "storage.delete" convex/files.ts` → at least one match (was zero repo-wide)
- [ ] Dev-deployment smoke run returns without error
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- `docNodes` text fields don't match what Step 3 assumes (e.g. patches are
  stored in a compressed/encoded form where `includes(id)` can't see references)
  — a wrong reference check here deletes user images; report the actual shape.
- convex-test cannot exercise `ctx.db.system.query("_storage")` at all — report
  rather than shipping the sweep untested.
- You find an existing GC/delete path this plan's premise missed.
- The sweep needs to become an action (e.g. mutation limits) — that changes its
  transactional guarantees; report first.

## Maintenance notes

- Plan 014 also edits `convex/crons.ts` — execute these two plans sequentially.
- If image references ever move to storing raw `storageId`s in markdown (instead
  of resolved URLs), the reference check keeps working (substring match on the
  id), but re-verify.
- The grace window trades storage-leak latency for upload-race safety; 24h is
  deliberate — don't shorten it below the sync debounce + offline window.
- Reviewer note: scrutinize the reference-collection pass — it must include
  `docNodes` content, not just live markdown, or restore-from-history breaks
  images.
