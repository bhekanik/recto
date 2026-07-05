# Plan 012: Add a CI gate — typecheck, lint, tests, build on every push

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat e8058fe..HEAD -- package.json vercel.json .github`
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

Pushing/merging to `main` auto-deploys to production (Vercel Git integration), but
nothing runs `typecheck`, `biome`, or `test` on push — `vercel.json` only runs the
build. A commit that breaks types, lint, or the 234-test suite can reach
production; verification today depends entirely on developer discipline. This is
the verification baseline that every other plan in this batch leans on, which is
why it executes first.

## Current state

- `.github/` does not exist — there is no CI at all.
- `vercel.json:3` is the only automated gate:
  ```json
  "buildCommand": "if [ \"$VERCEL_ENV\" = \"production\" ]; then npx convex deploy --cmd 'bun run build'; else bun run build; fi"
  ```
- `package.json` scripts (the four gates every prior plan ran manually):
  `typecheck` = `tsc --noEmit` · `biome` = `biome check .` ·
  `test` = `vitest run && bun test spikes/undo-tree/tests/convex.bun.test.ts` ·
  `build` = `next build`.
- Convex codegen output **is committed** (`git ls-files convex/_generated` lists
  `api.d.ts`, `api.js`, `dataModel.d.ts`, `server.d.ts`), so typecheck/tests need
  no live Convex deployment.
- `next build` reads `NEXT_PUBLIC_CONVEX_URL` and the Clerk publishable key from
  env; locally these come from `.env.local` (gitignored, never committed).
- Runtime/package manager is Bun (repo convention — see `CLAUDE.md`).

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Install   | `bun install`        | exit 0              |
| Typecheck | `bun run typecheck`  | exit 0, no errors   |
| Lint      | `bun run biome`      | exit 0              |
| Tests     | `bun run test`       | all pass (~234 vitest + 4 spike bun tests) |
| Build     | `bun run build`      | exit 0              |

## Scope

**In scope** (the only files you should create/modify):
- `.github/workflows/ci.yml` (create)
- `README.md` (one short "CI" sentence in the Deployment section)

**Out of scope** (do NOT touch):
- `vercel.json` — the deploy path stays as-is; CI is additive.
- `package.json` — do not add scripts or deps; the four existing scripts are the gate.
- Branch-protection settings (a GitHub UI action; note it in the final report instead).

## Git workflow

- Branch: work directly on `main` unless the operator says otherwise (repo is
  single-author; recent history commits straight to `main`).
- Commit style: conventional `type: description`, e.g. `ci: run typecheck, lint, tests and build on push`.
  **No AI attribution, no Co-Authored-By.** Do not push unless the operator asked.

## Steps

### Step 1: Create the workflow

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun run biome
      - run: bun run test
      - run: bun run build
        env:
          NEXT_PUBLIC_CONVEX_URL: https://placeholder.convex.cloud
          NEXT_PUBLIC_CONVEX_SITE_URL: https://placeholder.convex.site
          NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: ${{ secrets.CLERK_PUBLISHABLE_KEY_CI }}
          NEXT_PUBLIC_CLERK_SIGN_IN_URL: /login
```

**Verify**: `bunx --yes yaml-lint .github/workflows/ci.yml` (or any YAML parse) → valid YAML.
Alternatively `bun -e "const f = await Bun.file('.github/workflows/ci.yml').text(); (await import('js-yaml')).load(f); console.log('ok')"` → `ok` (js-yaml is already a dependency).

### Step 2: Prove the gate locally

Run all four scripts exactly as CI will:

**Verify**: `bun install --frozen-lockfile && bun run typecheck && bun run biome && bun run test` → all exit 0.

Then check whether the build tolerates placeholder env:

**Verify**: `NEXT_PUBLIC_CONVEX_URL=https://placeholder.convex.cloud NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_cGxhY2Vob2xkZXItbm90LXJlYWwuY2xlcmsuYWNjb3VudHMuZGV2JA bun run build` → exit 0.
- If Clerk rejects the placeholder key format at build time, this is the expected
  fallback: the workflow's `CLERK_PUBLISHABLE_KEY_CI` secret must be set to the
  real **dev-instance** publishable key (it is a public value by design —
  `NEXT_PUBLIC_*`). Record in your report that the operator must add that one
  repo secret; do NOT paste any key value into any file.

### Step 3: Document it

Add one sentence to `README.md`'s Deployment section: pushes and PRs run
`typecheck` + `biome` + `test` + `build` via GitHub Actions (`.github/workflows/ci.yml`).

**Verify**: `grep -n "workflows/ci.yml" README.md` → one match.

## Test plan

No new unit tests — this plan adds infrastructure. The verification is Step 2
(the exact CI command sequence passing locally) plus, after the operator pushes,
a green run on the Actions tab.

## Done criteria

- [ ] `.github/workflows/ci.yml` exists, parses as YAML, and runs the four scripts under Bun
- [ ] `bun run typecheck && bun run biome && bun run test` exits 0 locally
- [ ] Build verified locally (with placeholder env, or the secret fallback recorded in the report)
- [ ] README mentions the CI gate
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `bun run test` fails on a test unrelated to this plan (pre-existing breakage —
  note: one bridge *latency* test is known to be flaky baseline noise; a single
  latency-threshold flake may be re-run once, anything else is a STOP).
- The build fails with placeholder env AND the dev publishable-key fallback also
  seems insufficient (e.g. build requires a live Convex connection) — report,
  do not start mocking modules to force a green build.
- You find an existing CI config anywhere (`.github/`, `.circleci/`, etc.) —
  the premise of this plan would be wrong.

## Maintenance notes

- Plan 021 (e2e smoke harness) will extend this workflow with a Playwright job;
  keep the job name `ci` stable so it can be added alongside rather than replacing.
- If `bun run test` grows slow, split vitest and the spike bun test into parallel
  jobs — don't drop either (the spike test guards the undo-tree Convex contract).
- The operator should enable branch protection requiring this check once it's green.
