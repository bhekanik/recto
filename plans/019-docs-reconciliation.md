# Plan 019: Reconcile the docs with shipped reality (model id, per-hunk, critique cleanup, schema, banners)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat e8058fe..HEAD -- plans/README.md docs/plan/README.md docs/plan/phase-4-history.md docs/blueprint/03-data-model.md convex/review.ts lib/ai/config.ts lib/ai/review.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (docs + comments + one dead constant; no behavior change)
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `e8058fe`, 2026-07-05

## Why this matters

An audit on 2026-07-05 found the docs describing a different app than the one
that shipped. Executors and future sessions treat these docs as ground truth
(the repo's own convention: "the blueprint is the source of truth… deviations
are noted"), so each drift below actively misleads:

- The plans index claims the AI chat model is `anthropic/claude-sonnet-4.6`;
  the code ships `z-ai/glm-5.2`.
- Plans 010/011 say per-hunk accept/reject is "deferred"; it shipped (commits
  `00f9e96`, `3a5119d`; `lib/review/accept-hunks.test.ts` exists).
- Plan 011 says the superseded critique code "is left in the tree" awaiting a
  cleanup plan; the cleanup already happened (`components/ai/critique-panel.tsx`
  and `app/api/ai/critique/route.ts` no longer exist) — but one dead constant
  and stale comment references remain.
- The Phase-4 exit-criteria checklist is unchecked with no "superseded" banner
  (its siblings phase-3/phase-5 have one), so it reads as outstanding work.
- The plan README's risk register says undo-tree retention is "deferred;
  monitor" — the sweep is implemented and cron-scheduled (`convex/retention.ts`,
  `convex/crons.ts:7-11`).
- The blueprint data-model doc claims "four tables" and that the whole schema
  can be built "from this file alone"; `convex/schema.ts` has nine.
- Shipped review mutations carry `SPIKE:` doc-comment prefixes, mislabeling
  graduated product code as throwaway.
- Plan 009's env section still describes the pre-pivot `ANTHROPIC_API_KEY` /
  Convex-action architecture; the shipped design is OpenRouter through Next
  routes.

## Current state (each item = one edit site)

1. `plans/README.md:42` — "default chat `anthropic/claude-sonnet-4.6`" ↔ code:
   `lib/ai/config.ts:21` `export const AI_CHAT_MODEL = "z-ai/glm-5.2";`.
2. `plans/010-review-collaboration.md:498,563` and `plans/011-ai-reviewer.md:549`
   — per-hunk/per-edit accept-reject described as deferred. Shipped evidence:
   `lib/review/accept-hunks.test.ts`, `components/review/diff-runs-view.tsx`,
   commits `00f9e96` ("feat: accept/reject individual review hunks"),
   `3a5119d` ("feat: per-hunk accept/reject UI in review surface").
3. `plans/011-ai-reviewer.md:40,199,552` — "left in the tree… follow-up cleanup
   plan should remove them". Reality: files already deleted; remaining residue
   to actually clean in code:
   - `lib/ai/config.ts:26-27` — `AI_CRITIQUE_MAX_TOKENS` (verified zero callers)
   - `lib/ai/config.ts:15` — comment "transforms + critique"
   - `lib/ai/review.ts:294` — comment "Modeled on `parseCritique`" (function gone)
   - `components/ai/ai-review-panel.tsx:22` — comment "Chrome modeled on
     critique-panel.tsx" (file gone)
   Note: the `ai-critique` ACTION ID in `lib/keyboard/actions.ts` /
   `lib/studio/action-map.ts:146` was deliberately repurposed to open AI review
   — do NOT rename or remove it (chord muscle-memory + registry stability).
4. `docs/plan/phase-4-history.md:203+` — unchecked exit-criteria section missing
   the banner. Copy the exact banner style from `docs/plan/phase-5-polish-and-export.md:217`:
   "> **Status: superseded by [`./README.md`](./README.md).** …"
5. `docs/plan/README.md:65` — risk register: "retention fallback deferred;
   monitor in Phase 4". Reality: sweep shipped (`convex/retention.ts:49-80`,
   cron at `convex/crons.ts:7-11`); what remains deferred is only the
   *depth-cap fallback*. Reword to say the sweep is live and only the depth-cap
   is deferred-pending-signal.
6. `docs/blueprint/03-data-model.md:5,20` — "the four tables" / "implement the
   entire convex/schema.ts from this file alone". Reality: nine app tables —
   add `documentShares`, `reviewBranches`, `comments` (plan 010), `docChunks`
   (plan 009), `writingStats` (plan 002). Don't inline full specs — add a short
   "post-v1 tables" section pointing at the owning plan docs, and fix the
   "four tables"/"from this file alone" claims.
7. `convex/review.ts:349,353,479,561,589,781` — `SPIKE:` doc-comment prefixes on
   shipped mutations. Rewrite each comment to describe the shipped contract
   (keep the isolation-invariant wording — it's load-bearing documentation);
   drop only the SPIKE framing.
8. `plans/009-ai-reversible-assist.md:340,361,493` — `ANTHROPIC_API_KEY` /
   Convex-action architecture. Add a short "superseded by the shipped design"
   note at the TOP of the affected section pointing to `plans/README.md:42`'s
   description (OpenRouter via Next routes, key in Next + Convex env) rather
   than rewriting history throughout.
9. `plans/README.md` rows 010/011 — append per-hunk to the DONE notes so the
   index reflects the shipped scope.

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Typecheck | `bun run typecheck`  | exit 0              |
| Lint      | `bun run biome`      | exit 0              |
| Tests     | `bun run test`       | all pass            |

## Scope

**In scope** (edit exactly these):
- `plans/README.md`, `plans/009-ai-reversible-assist.md`,
  `plans/010-review-collaboration.md`, `plans/011-ai-reviewer.md`
- `docs/plan/README.md`, `docs/plan/phase-4-history.md`
- `docs/blueprint/03-data-model.md`
- `convex/review.ts` (comments only), `lib/ai/config.ts` (dead constant +
  comment), `lib/ai/review.ts` (comment only),
  `components/ai/ai-review-panel.tsx` (comment only)

**Out of scope**:
- Any behavior change anywhere. If deleting `AI_CRITIQUE_MAX_TOKENS` breaks the
  build, STOP — the zero-caller verification was wrong.
- Renaming the `ai-critique` action id (deliberately repurposed — see item 3).
- Rewriting plan/blueprint history beyond the targeted corrections (these docs
  are point-in-time records; add notes, don't rewrite narratives).

## Git workflow

- Work on `main`. Suggested split: `docs: reconcile plans/blueprint with shipped
  reality` + `chore: drop dead critique constant and stale SPIKE comments`.
- No AI attribution. Don't push unless asked.

## Steps

### Step 1: Code-side residue (item 3, 7)

Delete `AI_CRITIQUE_MAX_TOKENS` + fix the three stale comments; rewrite the six
SPIKE comments in `convex/review.ts`.

**Verify**: `bun run typecheck && bun run biome && bun run test` → exit 0;
`grep -rn "AI_CRITIQUE_MAX_TOKENS\|parseCritique\|critique-panel" lib components app convex --include="*.ts" --include="*.tsx"` → zero matches;
`grep -n "SPIKE" convex/review.ts` → zero matches.

### Step 2: plans/ corrections (items 1, 2, 3-doc, 8, 9)

Make the targeted edits. For 010/011's deferred notes, add a dated superseding
line (e.g. "**Update 2026-07-05:** shipped in `00f9e96`/`3a5119d` — this
deferral note is historical") rather than deleting the original text.

**Verify**: `grep -n "claude-sonnet-4.6" plans/README.md` → zero matches;
`grep -rn "left in the tree" plans/011-ai-reviewer.md` → each hit now adjacent
to a superseding note (manual read).

### Step 3: docs/plan + blueprint corrections (items 4, 5, 6)

Add the phase-4 banner (copy phase-5's wording); fix the risk-register row;
update 03-data-model per item 6.

**Verify**: `grep -n "superseded" docs/plan/phase-4-history.md` → one match;
`grep -n "four tables" docs/blueprint/03-data-model.md` → zero matches (or the
phrase now reads "four v1 tables" with the post-v1 section present).

## Test plan

No new tests — `bun run test` green proves the dead-constant deletion was safe.

## Done criteria

- [ ] All nine items edited; every grep in Steps 1–3 passes
- [ ] `bun run typecheck && bun run biome && bun run test` exit 0
- [ ] `git diff --stat` touches only in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- Any grep in Step 1 finds a *caller* of the items marked dead (verification
  drift since 2026-07-05).
- You find the per-hunk feature only partially shipped (e.g. UI present but the
  accept path incomplete) — then item 2's correction would be wrong; report
  what you found instead.

## Maintenance notes

- This plan is a snapshot-reconciliation; the durable fix is habit: when a
  deferral ships later, update the doc that called it deferred in the same
  commit. Consider adding that line to `AGENTS.md` conventions (out of scope
  here — surface as a suggestion).
