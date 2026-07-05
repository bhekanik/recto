# Plan 021: Stand up a browser e2e smoke harness and retire the standing "runtime checks pending" debt

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat e8058fe..HEAD -- package.json vitest.config.ts .github`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED (auth + live editor automation is the hard part; time-box it)
- **Depends on**: plans/012-ci-gate.md (extends its workflow)
- **Category**: tests
- **Planned at**: commit `e8058fe`, 2026-07-05

## Why this matters

Recto's core promises are interactive — lossless lens switching, never-lose-work
sync, focus-mode feel, AI accept/reject, image round-trip, email preview — and
none of them has automated browser coverage. The repo itself says so:
`plans/README.md:43` has carried "**Runtime checks pending** … should still get
a manual smoke pass in the running app" since 2026-06-18, and plan docs admit
"the repo has no editor-interaction test harness". 234 unit tests guard the
logic; zero tests guard what a user actually touches. Every design pass or
refactor re-risks the interactive surface with only human memory as the gate.

Two deliverables, in order of certainty:

1. **Immediately**: perform and RECORD the four pending manual smoke checks
   (cheap, closes a 3-week-old known unknown).
2. **Then**: a minimal Playwright harness + the first four smoke specs, wired
   into CI, so the checks stop depending on memory.

## Current state

- Test stack today: `vitest run` (happy-dom) + one `bun test` spike file
  (`package.json:12`); `vitest.config.ts` includes `lib`, `convex`, `spikes`
  patterns. No playwright/cypress/puppeteer anywhere in `package.json`.
- No `.github/` until plan 012 lands (this plan extends its `ci.yml`).
- Auth: Clerk (`@clerk/nextjs` v7) — sign-in at `/login`. Clerk's official
  testing story is `@clerk/testing` (Testing Tokens: bypass bot detection,
  programmatic session; works with Playwright). Requires a dev-instance
  `CLERK_SECRET_KEY` + publishable key in the test env — **secrets stay in env /
  CI secrets, never in files**.
- Backend: `bun run dev` runs `convex dev --start 'next dev --turbopack'` — the
  e2e target needs a Convex dev deployment; tests will write real rows there.
  Keep tests self-contained: create a fresh document per test, delete it after
  (the UI's own delete flow, or directly via a `bunx convex run` helper, is
  acceptable for cleanup).
- The four flows named pending in `plans/README.md:43`:
  1. focus-mode scroll feel (plan 003 — typewriter/dim; toggles via palette)
  2. AI accept/reject in the live app (plan 009 — needs `aiEnabled` ON + a
     selection + OpenRouter key in dev env)
  3. image upload round-trip (plan 008 — paste/drop an image, blob in Convex
     storage, `![alt](url)` in markdown, renders in preview)
  4. email preview rendering (plan 008 — preview variant toggle; subject/preheader
     from frontmatter via `components/workspace/document-header.tsx` fields)
- Deferred test debt to fold in (from `plans/002-writing-goals-and-streaks.md:629`):
  a convex-test integration test for `writingStats.record`/`list` was deferred —
  add it here as a unit-level companion (it needs no browser).

## Commands you will need

| Purpose   | Command                       | Expected on success |
|-----------|-------------------------------|---------------------|
| Install   | `bun install`                 | exit 0              |
| Unit tests| `bun run test`                | all pass            |
| Dev app   | `bun run dev`                 | app on :3000        |
| E2E (new) | `bun run test:e2e` (you create)| playwright passes  |
| Typecheck | `bun run typecheck`           | exit 0              |

## Scope

**In scope**:
- Part 1: a recorded manual smoke pass (report artifact — a dated checklist in
  the final report AND a strike-through/update of `plans/README.md:43`)
- Part 2: `playwright.config.ts`, `e2e/` directory with 4 specs, `@playwright/test`
  + `@clerk/testing` dev-deps, `test:e2e` script, CI job (extend
  `.github/workflows/ci.yml` — non-blocking `continue-on-error: true` for the
  first iteration)
- `convex/writingStats` convex-test integration test (the plan-002 deferred item)

**Out of scope**:
- Porting the whole manual QA surface (phase-5 F1–F7) to e2e — four smoke specs
  only; more specs are follow-up once the harness proves stable.
- Visual-regression tooling, screenshot diffing.
- Testing against production or any real user data.
- The "scroll feel" subjective judgment — the e2e spec asserts the *mechanism*
  (caret line stays vertically centered while typing); feel remains a human call
  recorded in Part 1.

## Git workflow

- Work on `main`. Suggested commits: `test: record pending runtime smoke pass`,
  `test: playwright smoke harness with Clerk testing tokens`,
  `test: writingStats record/list integration coverage`. No AI attribution.
  Don't push unless asked.

## Steps

### Step 1: Manual smoke pass (do this first, alone)

Run `bun run dev`, sign in, and execute the four flows above. For the AI flow,
`aiEnabled` must be toggled ON (palette: "Toggle AI") and the dev env needs the
OpenRouter key — if AI errors on config, record that flow as BLOCKED with the
error rather than stopping the whole plan. Record pass/fail + date + notes per
flow, then edit `plans/README.md:43` to reflect what was verified.

**Verify**: `plans/README.md` no longer claims all four are pending; your
report carries the dated checklist.

### Step 2: Harness

`bun add -d @playwright/test @clerk/testing` · `bunx playwright install chromium`.
Create `playwright.config.ts` (testDir `e2e`, baseURL `http://localhost:3000`,
`webServer: { command: "bun run dev", url: "http://localhost:3000", reuseExistingServer: true }`)
and an `e2e/global-setup.ts` using `@clerk/testing/playwright`'s `clerkSetup()`;
each spec signs in via the testing-token helpers (follow the current
`@clerk/testing` README — do not hand-roll session cookies). Add
`"test:e2e": "playwright test"` to `package.json`. Ensure `vitest.config.ts`
does NOT pick up `e2e/**` (its include patterns are lib/convex/spikes — verify,
and exclude explicitly if needed).

**Verify**: a trivial `e2e/smoke.spec.ts` (loads `/`, lands signed-in on the
studio, sees the status bar) passes via `bun run test:e2e`.

### Step 3: The four specs

1. `e2e/focus-mode.spec.ts` — create doc, type 30 lines, toggle typewriter via
   palette, type at document end → assert the active line's bounding box stays
   within the vertical center band of the pane (mechanism, not feel).
2. `e2e/image-roundtrip.spec.ts` — paste a small PNG (Playwright clipboard/file
   drop), await the `![](…)` insertion in raw lens, switch to preview → assert
   an `<img>` with a `convex.cloud` URL renders (naturalWidth > 0).
3. `e2e/email-preview.spec.ts` — set subject/preview text in the document
   header fields, switch preview variant to email → assert the inbox chrome
   shows both strings.
4. `e2e/ai-accept-reject.spec.ts` — ONLY if dev AI config is available: enable
   AI, select a sentence, run a transform preset, accept → assert text changed
   AND one undo (palette Undo) restores the original (the reversibility
   promise). If AI config is unavailable in the e2e env, mark the spec
   `test.skip` with a comment naming the env requirement — do not mock the LLM
   in a smoke test.

**Verify**: `bun run test:e2e` → 4 specs pass (or 3 pass + 1 documented skip).

### Step 4: CI wiring

Extend `.github/workflows/ci.yml` with an `e2e` job: needs the dev-instance
Clerk keys and a Convex dev deployment URL as repo secrets — list the exact
secret NAMES in the workflow and in your report; values are the operator's to
set. Mark the job `continue-on-error: true` initially so a flaky start doesn't
block the main gate; note in the workflow comment that it should become
blocking once stable.

**Verify**: workflow YAML parses; local `bun run test:e2e` green.

### Step 5: writingStats integration test

Add the deferred convex-test coverage: `record` twice in a day keeps the max
(monotonic per the schema comment at `convex/schema.ts:133`), `list` returns
per-day rows for the user only. Model on the existing convex-test harness.

**Verify**: `bun run test` → green including the new cases.

## Test plan

This plan IS the test plan; see Steps. Suite totals afterward: unit suite +
~2 writingStats cases; e2e suite: 5 specs (smoke + four flows, one possibly
skipped).

## Done criteria

- [ ] Dated manual smoke record exists; `plans/README.md:43` updated
- [ ] `bun run test:e2e` green locally (documented skips allowed only for the AI spec)
- [ ] CI has a non-blocking e2e job with secret names documented
- [ ] writingStats integration test passes in `bun run test`
- [ ] `bun run typecheck && bun run biome && bun run test` exit 0
- [ ] No secret values in any committed file (`git diff` inspected)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- `@clerk/testing` cannot authenticate against this Clerk instance after a
  reasonable setup attempt (~1h) — auth-bypass hacks are out of bounds; report
  what Clerk's tooling needs.
- The Milkdown/CodeMirror editors prove un-automatable for paste events in
  Playwright within the time box — ship the other specs and report the gap.
- Convex dev-deployment writes from CI look like they'd touch anything shared
  (the deployment is not isolated per-run) — report before wiring CI.

## Maintenance notes

- Grow this suite toward the phase-5 QA list (F1–F7) one spec at a time; the
  highest-value next spec is lossless round-trip (rich→raw→rich byte-stable)
  since it guards the product's core promise.
- Flip the CI e2e job to blocking after ~2 weeks of stability.
- The AI spec's skip-if-unconfigured pattern is the template for any future
  spec needing paid external services.
