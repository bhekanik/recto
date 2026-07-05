# Plan 016: Enforce the no-AI-on-shared-docs rule server-side

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat e8058fe..HEAD -- app/api/ai lib/ai/route-guard.ts lib/studio/use-ai-features.ts convex/review.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW–MED (adds a Convex read to hot AI routes; must not break the happy path)
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `e8058fe`, 2026-07-05

## Why this matters

Plan 010 committed to: "Hide/disable the AI affordances **and short-circuit the
routes** for such documents" (`plans/010-review-collaboration.md:38`). Only the
first half shipped. The rule "no AI on shared docs" is currently a client-side
flag; the AI routes themselves check Clerk auth and nothing else. A direct
request to `/api/ai/transform` (or review) with content from a shared document
runs fine. Impact is product-boundary rather than data-security (the routes are
stateless — they never write to the owner's document), but the shipped behavior
doesn't match the plan's done-criterion, and if AI policy on shared docs ever
matters contractually (reviewer trust, "your draft is never sent to a model
while shared"), a UI-only gate is not a boundary.

This plan makes the routes enforce what the UI promises.

## Current state

- Client gate: `lib/studio/use-ai-features.ts:29,57` derives
  `effectiveAiEnabled = settings.aiEnabled && !activeDocShared`; dispatch gating
  in `lib/studio/action-map.ts:143-156` (the `"ai-transform"` / `"ai-critique"` /
  `"ai-related"` / `"ai-reindex"` entries check `effectiveAiEnabled`).
- Shared-ness source of truth: `convex/review.ts` exposes `isDocumentShared`
  (grep for its export around lines 299-326) — true for both the owner side and
  the grantee side of a share.
- Route guard: `lib/ai/route-guard.ts` — `guardAiRoute(req, validate)` does
  authenticate (401) → JSON parse (400) → validate (400) → OpenRouter client
  (503). **It never sees a documentId.** Verbatim core:
  ```ts
  const userId = await requireUser();
  if (!userId) {
      return new Response("Unauthorized", { status: 401 });
  }
  ```
- Routes: `app/api/ai/transform/route.ts`, `app/api/ai/review/route.ts` (both
  use `guardAiRoute`), `app/api/ai/embed/route.ts` (hand-rolled preamble; plan
  015 may have unified it — check current state).
- The Next server can call Convex queries via the existing pattern — find the
  exemplar with `grep -rn "fetchQuery\|ConvexHttpClient" app lib --include="*.ts"`.
  If no server-side Convex read exists yet in the app, that's the main
  integration decision of this plan (see Step 1).

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Typecheck | `bun run typecheck`  | exit 0              |
| Lint      | `bun run biome`      | exit 0              |
| Tests     | `bun run test`       | all pass            |
| Dev run   | `bun run dev`        | app on :3000        |

## Scope

**In scope**:
- `app/api/ai/transform/route.ts`, `app/api/ai/review/route.ts`,
  `app/api/ai/embed/route.ts` (request contract + gate)
- `lib/ai/route-guard.ts` (extend the shared preamble)
- The client call sites that build these requests (must send `documentId`):
  find them with `grep -rn "api/ai/" lib components --include="*.ts" --include="*.tsx"`
- `convex/review.ts` ONLY if `isDocumentShared` isn't callable server-side as-is
  (e.g. needs an internal variant) — least change wins
- New/extended route tests (see Test plan)

**Out of scope**:
- Changing the client-side `effectiveAiEnabled` UX (keep the affordances hidden
  exactly as today — the server check is belt-and-braces, not a replacement).
- The future "owner opts a shared doc back into AI" setting mentioned in plan
  010 — explicitly not built here.
- Rate limiting, logging, or any other route hardening.

## Git workflow

- Work on `main`. Conventional commit, e.g.
  `fix: AI routes reject shared documents server-side`. No AI attribution.
  Don't push unless asked.

## Steps

### Step 1: Establish the server-side shared check

Decide the least-change path for the routes to answer "is this document shared?":

- Preferred: call the existing Convex query from the route using the repo's
  server-side Convex access pattern (Clerk token → `ConvexHttpClient` /
  `fetchQuery` with auth). Search for an existing exemplar first.
- If `isDocumentShared` requires an authed Convex context the route can't
  supply cleanly, add a minimal query variant in `convex/review.ts` that takes
  `documentId` and checks shares for the *calling* user (reusing the existing
  auth helpers — do not weaken auth to make the route's life easier).

**Verify**: a scratch call from a route (temporarily logged in dev) returns
true/false correctly for a shared vs unshared doc. Remove scratch logging.

### Step 2: Extend the request contract

Add `documentId: string` to the request bodies of transform/review/embed calls.
Update each client call site to send the active document's id (they all operate
on the active document — the ids are already in scope at those call sites).
Update each route's `validate` callback to require it.

**Verify**: `bun run typecheck` → exit 0 (the contract change surfaces every
call site; fix all of them).

### Step 3: Enforce in the shared guard

Extend `guardAiRoute` (or add a wrapper `guardAiDocumentRoute`) to, after auth
and validation, check shared-ness and return `403` with body
`"AI is disabled on shared documents"` when true. Keep the existing status
semantics for everything else (401/400/503).

**Verify**: `bun run typecheck && bun run test` → exit 0.

### Step 4: Prove the boundary

With `bun run dev` and a signed-in session: share a test document (the share
dialog — `components/share-dialog.tsx`), then hit the transform route directly
with that documentId (browser devtools fetch or `curl` with the session cookie)
→ expect 403. Unshared doc → normal streaming response.

**Verify**: recorded 403 for shared, 200/stream for unshared.

## Test plan

- Extend the existing AI route tests (find them:
  `grep -rln "guardAiRoute\|api/ai" --include="*.test.ts" lib app`) with:
  shared doc → 403; unshared → passes the guard; missing documentId → 400.
  Follow whatever mocking pattern those tests already use for `requireUser` /
  the Convex read (do not invent a new harness).
- `bun run test` → all pass including the new cases.

## Done criteria

- [ ] All three AI routes require `documentId` and return 403 for shared documents
- [ ] Client call sites all send `documentId`; UI behavior unchanged for the owner's unshared docs
- [ ] Manual dev proof: 403 on shared, success on unshared (recorded in report)
- [ ] `bun run typecheck && bun run biome && bun run test` exit 0
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- There is no existing server-side authed Convex access pattern AND adding one
  requires new auth plumbing beyond ~a screenful of code — that's an
  architecture decision the operator should see first.
- The added Convex read measurably delays the transform stream start in dev
  (subjectively >200ms extra) — report; we may want a cached/optimistic check.
- Any AI feature turns out to legitimately operate on a *non*-active document
  (the contract change assumption breaks).

## Maintenance notes

- The plan-010 note "A future setting could let an owner opt a specific shared
  doc back into AI (default OFF)" now has a single enforcement point: the guard
  from Step 3 is where that setting would be consulted.
- If reviewer-side AI is ever added (plan 011 successor work), it must NOT
  reuse the owner's gate — reviewers on shared docs are exactly who this
  boundary excludes.
