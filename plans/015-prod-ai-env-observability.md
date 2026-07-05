# Plan 015: Verify prod AI env and make the silent re-embed sweep observable

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat e8058fe..HEAD -- convex/embeddings.ts app/api/ai/embed/route.ts README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `e8058fe`, 2026-07-05

## Why this matters

The daily RAG re-embed cron degrades **silently** when the OpenRouter key is
missing from the Convex deployment env: it logs a `console.warn` and returns
`{ embedded: 0 }` — deliberately (a throwing cron would retry forever), but
nothing surfaces the degradation to the user. `plans/README.md:36` explicitly
warns "⚠️ When deploying to production, set the key there too" and there is no
record that this was ever done — if prod lacks the key, "related passages"
quietly serves stale/empty results for every document edited since deploy, and
the only evidence is a warning line in Convex logs nobody reads.

Compounding it, the code contradicts itself about where the key lives:
`app/api/ai/embed/route.ts` claims embedding "Lives in Next (not Convex)
because the embedding key (`OPENROUTER_API_KEY`) is in the Next server env" —
while `convex/crons.ts` schedules a Convex-side sweep that reads the same key
from the Convex env. Both runtimes need it; the comment says otherwise.

**Never print, paste, or commit any key value while executing this plan.
Reference the env var by name only.**

## Current state

- `convex/embeddings.ts:360-371` — the graceful skip:
  ```ts
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
      console.warn(
          "reindexSweep: OPENROUTER_API_KEY not set in Convex env — skipping embedding generation",
      );
      return { scanned: stale.length, embedded: 0 };
  }
  ```
  The doc comment (lines 354-358) explains the no-throw choice — keep that
  behavior.
- `convex/crons.ts:13-21` — daily 09:00 UTC cron calling
  `internal.embeddings.reindexSweep`; its comment correctly says "using the
  Convex-side OPENROUTER_API_KEY".
- `app/api/ai/embed/route.ts:10-15` (approx.) — the stale rationale claiming the
  key is Next-only. Also note: this route hand-rolls the auth/JSON/client
  preamble that `lib/ai/route-guard.ts` (`guardAiRoute`) centralizes for the
  transform and review routes.
- `README.md:39-46` — env documentation covers `.env.local` and the Clerk JWT
  issuer `convex env set`, but there is no production-deploy checklist naming
  the Convex-deployment-side vars (`OPENROUTER_API_KEY`,
  `CLERK_JWT_ISSUER_DOMAIN`).
- Ops facts: dev deployment HAS the key (verified 2026-06-18 per
  `plans/README.md:36`, sweep returned `{ scanned: 7, embedded: 7 }`). Prod is
  unverified. Convex env is per-deployment; `bunx convex env list` targets dev
  by default, `bunx convex env list --prod` targets production.

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Typecheck | `bun run typecheck`  | exit 0              |
| Lint      | `bun run biome`      | exit 0              |
| Tests     | `bun run test`       | all pass            |
| Check prod env (names only) | `bunx convex env list --prod` | list includes `OPENROUTER_API_KEY` and `CLERK_JWT_ISSUER_DOMAIN` |
| Prod sweep smoke | `bunx convex run embeddings:reindexSweep --prod` | `{ scanned: N, embedded: M }` with M > 0 when stale docs exist |

## Scope

**In scope**:
- Ops verification (env presence check + one prod sweep run)
- `convex/embeddings.ts` (health surfacing — Step 3 only; do not change skip semantics)
- `app/api/ai/embed/route.ts` (comment fix; optionally fold into `guardAiRoute`)
- `README.md` (production-deploy env checklist)
- `plans/README.md` (strike the ⚠️ once verified — status-row update covers it)

**Out of scope**:
- Any change to `convex/crons.ts` scheduling.
- Model/config changes in `lib/ai/config.ts`.
- Alerting infrastructure (no new services; the health signal is a query, not a pager).

## Git workflow

- Work on `main`. Conventional commits (e.g. `fix: surface re-embed sweep health`,
  `docs: production Convex env checklist`). No AI attribution. Don't push unless asked.

## Steps

### Step 1: Verify prod env (names only)

Run `bunx convex env list --prod` and check for `OPENROUTER_API_KEY` and
`CLERK_JWT_ISSUER_DOMAIN` **by name**. Do not echo values; if your shell prints
values, do not copy them anywhere.

- If `OPENROUTER_API_KEY` is missing: report to the operator that they must run
  `bunx convex env set OPENROUTER_API_KEY <value> --prod` themselves (you do not
  have the value, and must not ask for it in a file). Continue with the code
  steps regardless.
- If `CLERK_JWT_ISSUER_DOMAIN` is missing yet prod auth works, STOP and report —
  the premise about Convex-side JWT verification would be wrong.

**Verify**: env list ran; presence/absence recorded in your report (names only).

### Step 2: Prod sweep smoke (only if the key is present)

`bunx convex run embeddings:reindexSweep --prod` → record `{ scanned, embedded }`.
`embedded: 0` with `scanned: 0` is healthy (nothing stale); `embedded: 0` with
`scanned > 0` right after Step 1 confirmed the key means something else is wrong
— STOP and report the Convex log line.

### Step 3: Add a health signal

In `convex/embeddings.ts`, add a small **public query** (auth-gated with the
same `requireUserId` pattern the other Convex functions use — import from
`./documents`) named `embeddingHealth` returning:

```ts
{ staleCount: number; lastSweepSkippedMissingKey: boolean }
```

Implementation: `staleCount` = length of the existing internal stale-docs query
(`allStaleDocuments` — reuse it via `ctx.runQuery` if this is an action, or
refactor-shared helper if a query; check what `allStaleDocuments` is declared as
and follow the least-change path). For the skip flag, persist a tiny marker:
the simplest repo-consistent mechanism is a patch on the sweep itself — have
`reindexSweep` write `console.warn` AND return the skip in its result as it
already does; then have `embeddingHealth` report `staleCount` only, and rename
the field accordingly. **Do not build new tables for this.** If a persisted
skip-flag requires a new table, drop the flag and ship `staleCount` alone — a
monotonically growing `staleCount` IS the missing-key signal.

Surface it minimally in the UI: the AI "Re-index drafts" flow
(`lib/studio/use-ai-features.ts:200-215`) already reports counts via dialogs;
do NOT redesign that here (plan 017 owns dialog→toast). Just ensure the query
exists and is callable; wiring a status-bar indicator is explicitly out of
scope.

**Verify**: `bun run convex:codegen && bun run typecheck && bun run test` → exit 0.

### Step 4: Fix the contradictory comment (and optionally unify the guard)

In `app/api/ai/embed/route.ts`, correct the header comment: the key lives in
BOTH the Next server env (on-demand client path) and the Convex deployment env
(daily sweep). While in the file, if the hand-rolled preamble is trivially
replaceable with `guardAiRoute` from `lib/ai/route-guard.ts` (same 401/400/503
semantics — read both first), do it; if the embed route's shape differs
materially, leave the code and fix only the comment.

**Verify**: `bun run typecheck && bun run test` → exit 0.

### Step 5: Write the production-deploy checklist

Add a short "Production env (Convex deployment)" subsection to `README.md`'s
Deployment section: `OPENROUTER_API_KEY` (AI sweep + embeddings) and
`CLERK_JWT_ISSUER_DOMAIN` (JWT verification) must be set via
`bunx convex env set <NAME> <value> --prod` — distinct from Vercel project env.

**Verify**: `grep -n "convex env set" README.md` → includes a `--prod` line.

## Test plan

- New unit test only if `embeddingHealth` contains logic beyond a count
  passthrough (a count-only query can be covered by a convex-test asserting it
  returns 0 on empty and N after inserting stale docs — write that one test,
  modeled on the existing convex-test harness).
- `bun run test` stays green.

## Done criteria

- [ ] Prod env presence recorded (names only) in the final report; sweep smoke result recorded (or the missing-key handoff to the operator recorded)
- [ ] `embeddingHealth` query exists, auth-gated, typechecks, tested
- [ ] `app/api/ai/embed/route.ts` comment no longer claims the key is Next-only
- [ ] README has the prod Convex env checklist
- [ ] `bun run typecheck && bun run biome && bun run test` all exit 0
- [ ] No secret value appears in any diff (`git diff | grep -i "sk-\|pk_live"` → empty)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- `bunx convex env list --prod` fails with auth/permission errors — the
  deployment link may not be configured on this machine; report, don't
  reconfigure deployments.
- Prod sweep errors in a way that implicates data (not config).
- Unifying the embed route onto `guardAiRoute` changes any response status
  observed by existing tests.

## Maintenance notes

- If the embedding model ever changes (`lib/ai/config.ts` warns the vector index
  dimension must match), the sweep re-embeds everything — `staleCount` will
  spike; that's expected, not a regression.
- A future status-bar "AI index stale" indicator can consume `embeddingHealth`;
  deliberately not built here.
