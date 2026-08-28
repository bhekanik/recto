# Plan 023 orchestration: phases, dependencies, workers, protocol, learnings

> This file is the orchestrator's resumable state. The orchestrator (this
> Claude session, Fable 5) reads it after every context compaction. Workers
> (Opus 5 subagents in isolated worktrees) get the relevant slice of it in
> their brief. Update the status table and the learnings log after every
> worker report. Canonical plans: `plans/023-native-apple-apps.md` (program),
> `plans/023-native-apple-apps-design.md` (design).

## 0. Decisions taken by the orchestrator (2026-08-27, BK delegated)

| Question | Decision | Why |
|---|---|---|
| Min OS | **iOS/iPadOS 26, macOS 26** (SDK 26 now, 27 when GA) | Launch lands ~mid-2027 when 27 is current; 26 is then n-1. Drops dual code paths (asset-catalog icon fallback, pre-glass toolbars, pre-`WebPage` preview) and the Clerk floor is satisfied. Solo dev; fewer paths beats reach. |
| Same document in two Mac windows | **Allow**, once N4's `DocumentSession` tests pass; before that, bring-forward | Shared `NSTextContentStorage` makes it cheap natively. |
| Wordmark | **Source Serif 4 semibold** everywhere (web header too); adopt the recto/verso story in About and the store description | One typographic identity; the name has a real meaning. |
| Billing | **v1.1 after launch**. AI Pro $5.99/month, $49.99/year, price parity web/App Store | Ulysses-tier pricing; revisit with usage data. |
| `swift-markdown-engine` | **Fork** (GitHub `bhekanik/swift-markdown-engine`, Apache-2.0, keep NOTICE), pinned via SwiftPM; upstream what is general | Faster than reference-only; we need the UIKit port anyway. |
| Mac sidebar default | Visible, collapsible, hidden in focus mode | Library-first like Ulysses; ⌘1 toggles. |
| Mode control placement | Toolbar segmented control; status bar keeps the text label + vim sub-mode | Mode is a document-level choice, not status. |
| Palettes at launch | Twilight (dark) + Paper (light) only | Aurora/Dawn/Moonlit later with designed light twins. |
| iPhone raw lens | Allowed under "More" | Already in the matrix; no reason to remove. |

## 0b. Orchestrator decisions on W4's open questions (2026-08-28)

| Question | Decision |
|---|---|
| Tables: engine's cached bitmaps vs overlay views | Keep the engine's approach (collapsed source + pipes revealed on caret entry) for v1; overlay views only if cell editing proves unusable. Plan 023 §1.3 / design §4.2 amended. |
| Upstream dialect work | Fork branch `recto` is the source of truth; upstream general pieces (setext, footnotes, hard breaks, link titles) as separate PRs later, low priority. |
| Extension/directive seams | Keep the extension seam (strikethrough rides it); delete directives, wiki-links, LaTeX, scroll-away header, embedded-images-by-name. |
| Focus dim | Fragment-level transparency layer (Edmund), not `setRenderingAttributes`. |
| 8 ms typing target | Applies to M1-class as written; W4's derating (≈9 ms p50 on M1) is accepted for now, re-measured on an M1 iPad in N8 before it becomes a STOP. |
| N5 split | W9a = fork plumbing (applyPatch, undo flags, text-view seam, platform-neutral services, Swift 6 mode, drop unused deps) + dialect + `RectoEditor` package skeleton with corpus snapshot tests; W9b = blocks/features/undo-tree/typewriter/find. |

## 1. Phase dependency map

```
                 ┌──────────────┐
                 │ N0b editor   │──────────────┐
                 │ engine spike │              ▼
                 └──────────────┘        ┌──────────────┐     ┌─────────────┐     ┌────────────┐
 ┌──────────────┐                        │ N5 editor    │────▶│ N6 Mac      │────▶│ N7 Mac     │──┐
 │ N0c vim JSC  │───────────────────────▶│ engine (Mac) │     │ alpha       │     │ beta       │  │
 └──────────────┘                        └──────┬───────┘     └──────▲──────┘     └─────▲──────┘  │
 ┌──────────────┐     ┌──────────────┐          │                    │                  │         ▼
 │ N1d core-js  │────▶│ N3 JS cores  │──────────┼────────────────────┤                  │   ┌──────────┐
 │ + N0d parity │     │ + Swift wrap │          │                    │                  │   │ N10      │
 └──────────────┘     └──────────────┘          ▼                    │                  │   │ release  │
 ┌──────────────┐     ┌──────────────┐   ┌──────────────┐    ┌───────┴──────┐           │   └────▲─────┘
 │ N0a convex-  │────▶│ N4 native    │──▶│ N8 iOS       │───▶│ N9 iPhone    │───────────┼────────┘
 │ swift spike  │     │ core         │   │ engine+iPad  │    └──────────────┘           │
 └──────────────┘     └──────▲───────┘   └──────────────┘                               │
 ┌──────────────┐            │                                                          │
 │ N1a 022 +    │────────────┤  (commitEdit deployed before N4 sync transport)          │
 │ commitEdit   │            │                                                          │
 └──────┬───────┘     ┌──────┴───────┐     ┌──────────────┐                              │
        └────────────▶│ N1b settings │     │ N2 AI on     │──────────────────────────────┘
                      │ workspaces   │────▶│ Convex +     │  (N7 needs AI + moderation backend)
                      │ deletion     │     │ moderation   │
                      └──────────────┘     └──────────────┘
 ┌──────────────┐
 │ N1c light    │──▶ web deploy (independent; N6 consumes tokens package)
 │ theme+tokens │
 └──────────────┘
```

Critical path: **N0b → N5 → N6 → N7 → N10** (≈ 3 + 9 + 6 + 6 + 3 weeks). iOS
branch: N5 → N8 → N9 → N10. Backend lane (N1 → N2) and JS lane (N1d → N3)
finish long before N6 needs them.

Blocking rules:
- N1b waits for N1a (both touch `convex/schema.ts`, `convex/documents.ts`).
- N4's sync transport waits for N1a **deployed to prod**; N4's store, history
  ports and auth do not.
- N5 waits only for N0b go/no-go; N5's vim presentation waits for N0c.
- N6 waits for N4 + N5 + N3 + N1c (tokens).
- N7 waits for N6 + N2.
- N8 waits for N5 (engine) + N6 (shell patterns).
- N3 waits for N1d.

## 2. Waves

| Wave | Workers (parallel) | Merge + deploy gate |
|---|---|---|
| 1 (now) | W1 history-commit (N1a + N0e) · W2 light-theme (N1c) · W3 core-js (N1d + N0d) · W4 editor-spike (N0b) · W5 native-spike (N0a) · W6 vim-spike (N0c) | W1, W2: merged to `main`, Vercel + Convex prod deployed, post-deploy smoke green. W3: merged, parity CI green. W4/W5/W6: spike reports with go/no-go; code kept on `spike/*` branches, not merged. |
| 2 | W7 settings-workspaces-deletion (N1b) · W8 js-cores (N3) · W9 editor-engine (N5, long-running) · W10 native-core (N4) | W7 deployed; W8 merged; W9/W10 land in `apple/` behind CI (`xcodebuild test`), no user-facing deploy yet. |
| 3 | W11 ai-on-convex (N2, after W7) · W9 continues · W10 continues | W11 deployed to prod with the web client migrated and Next AI routes deleted. |
| 4 | W12 mac-alpha (N6) | Internal TestFlight build uploaded and installable (the "deploy" for native). |
| 5 | W13 mac-beta (N7) · W14 ios-engine-ipad (N8) | TestFlight builds; accessibility pass. |
| 6 | W15 iphone (N9) · W16 release (N10) | External TestFlight; App Review submission. |

Cap: at most 6 workers in flight; the orchestrator reviews every diff.

## 3. Worker protocol (paste the relevant parts into every brief)

**Environment**
- Agent tool: `subagent_type: "general-purpose"`, `model: "opus"`,
  `isolation: "worktree"`. Branch name `023/<worker-slug>`. Never commit to
  `main`. Never push `main`. Never run destructive git in the shared tree.
- Commits: conventional `type: description`, author BK only, no AI
  attribution, no Co-Authored-By. Push the branch and open a PR with `gh pr
  create --base main` titled `023/<slug>: <what>`; PR body = the report
  below. Do not merge.
- Repo rules: `AGENTS.md`, `CLAUDE.md` (Bun, no vite for app code, shadcn
  primitives), `docs/blueprint/README.md` locked decisions except where plan
  023 reverses them (D13 light theme, native apps).
- Before reporting: `bun run typecheck && bun run biome && bun run test`
  (and `bun run test:e2e` when the change touches the studio), then run
  `/typescript-reviewer` on the diff and `/simplify`, and fix what they
  raise. Swift work: `swift test` in the package and `xcodebuild test` for
  the scheme; snapshot tests where the plan asks.
- Deploy is part of done for web/backend lanes: after merge the orchestrator
  deploys; the worker must include the post-deploy smoke command(s) and
  expected output in the report, and must not leave schema changes that
  break the deployed web client (additive first).

**Report format (final message of the worker; also the PR body)**
1. Summary (5 lines max) and the PR URL.
2. Files changed, with one line per non-obvious change.
3. Proof: exact commands run and their output tails (typecheck, biome,
   tests, e2e, swift test, snapshots).
4. Deploy/smoke: what to run after deploy and what "green" looks like.
5. Learnings: assumptions that turned out false; things tried that did
   not work and why; gotchas future workers should know; anything in the
   plans that is wrong or stale.
6. Open questions and risks for the orchestrator.
7. Suggested follow-ups you deliberately did not do (blast radius).

**Context pack** (the orchestrator includes in every brief): the decisions
table above, the worker's phase section from plan 023, the relevant design
plan sections, the current learnings log (§5), and the interfaces other
in-flight workers are producing (§4).

## 4. Interfaces between in-flight workers

| Interface | Producer | Consumers | Contract |
|---|---|---|---|
| `documents.commitEdit` | W1 | W10 (sync), W7 | args/returns as plan 023 §4.1(1); additive; `updateMarkdown` stays until W10 ships |
| `packages/editor-fixtures/` | W3 | W8, W10, W9 | JSON fixtures: `markdown-corpus.json`, `history-patches.json`, `diff-runs.json`, `word-count.json`, `outline.json` |
| `packages/recto-core-js/dist/recto-core.js` | W3 → W8 | W9, W10 | globals `RectoCore.normalize/countWords/parseOutline/htmlFromMarkdown/markdownFromHtml/lint/streak` |
| `packages/design-tokens/` | W2 | W12, W9 | `tokens.json` (Style Dictionary v5 + culori; outputs committed under `generated/`, not `build/` which is globally gitignored): `tokens.css` (imported by globals.css), `tokens.ts` (`RECTO_HEX` sRGB table), `Colors.xcassets` (Twilight + Paper only), `RectoTokens.swift` (`Color("RectoX", bundle: .module)`: the catalog must live in the same SwiftPM target's resources). Extra tokens W2 had to add: `on-accent`, `focus-ring`, `bg-hover`, elevation/scrim/grain per appearance. |
| `settings` table + `settings.get/save` | W7 | W10, W11 | `{userId, json, updatedAt}` |
| `apple/Packages/RectoEditor` | W9 | W12, W14 | `RectoTextStorage`, `MarkdownStyler`, `Presentation` enum, `RectoTextView` (AppKit) |
| `apple/Packages/RectoStore`, `RectoSync`, `RectoHistory`, `RectoAuth` | W10 | W12 | `DocumentSession` actor API |

## 5. Learnings log (append; newest first)

- 2026-08-28 (W2, N1c): `build/` is in BK's global gitignore (`~/.gitignore_global`), so committed generated output must live elsewhere (`generated/`). Style Dictionary's built-in transforms mangle OKLCH strings; run with `transforms: []` and do colour maths with culori. Design plan §5 light values: `warning` and `comment` as specced were outside sRGB, `success` at L 0.55 measured 4.28:1, and `on-accent` was missing; final Paper ratios: ink 16.15 / 7.91 / 4.53, accent 5.42. `line-strong` fails 3:1 in BOTH appearances (Twilight 2.52) and is treated as decorative; `on-accent` on `accent-muted` is 3.15:1 on Twilight (pre-existing). Luminance elevation inverts in light except the sheet (raised/overlay step down in L, surface steps up). `next dev` rewrites `next-env.d.ts`; revert before committing. Clerk needs literal sRGB hex (it derives shade scales), hence the generated hex table. `next-themes` rejected: it would keep a second storage key beside `recto:studio-settings`.
- 2026-08-28 (W4, N0b GO): `swift-markdown-engine` @ `08ff3c07` (fork `bhekanik/swift-markdown-engine`): typing p50 5.3 ms / reveal 2.5 ms / scroll p95 1.8 ms on M3 Max Release, 10k words; caret stable across 160 reveal cycles; all 24 corpus cases byte-identical from storage. M1 derating ≈ 9 ms p50 typing (accepted; re-measure on iPad in N8). Dialect gaps: frontmatter, footnotes, setext, link titles, reference links, hard breaks, tilde fences, indented code, `- - -`, autolink brackets; list indent is `spaces/2`. External text patches force a full rebuild that drops the caret to 0 (fix first). Engine never calls `registerUndo`; internal edits go through `shouldChangeText → replaceCharacters → didChangeText` and report via `onTextMutation` in UTF-16 (our feed). Tables are cached bitmaps over collapsed source with pipes revealed on caret entry (accepted for v1 instead of overlay views). Focus dim via `setRenderingAttributes` will not work with cached decoration bitmaps; use Edmund's fragment transparency layer. `scrollRangeToVisible` kills the process on large TK2 docs; TK2 returns estimated heights above the caret, so typewriter centring needs settle passes; reserve overscroll via `textContainerInset` not `contentInsets`. UIKit port ≈ 8.9k lines rewrite (all of `TextView/`), service protocols return AppKit types (make platform-neutral first). Engine is Swift 5 mode, mutable static caches; pre-1.0 at ~3 commits/day: pin and expect divergence. Full assessment + 18-item fork change list: PR #2 body §3.
- 2026-08-28 (W4): measurement gotchas: wrap synthetic keystroke loops in `autoreleasepool` (else footprint climbs to 1 GB and reads as a leak); `phys_footprint` right after load catches a transient (peak 258 MB, steady 29 MB; use `vmmap`); the engine lays out the whole document on open (114 ms open, most of the peak; re-measure at 950 kB); `MD_PERF` trace is DEBUG-only. Source Serif 4 is NOT installed on this Mac (spike measured with Times); bundle the OFL fonts. `gh repo fork --org bhekanik` fails (user, not org). `bun` prints a spurious `Cannot read file "/Users/bhekanik/": ENOENT` on stderr after succeeding.
- 2026-08-28 (W4/W1): the corpus has **24** cases, not 25; the 25th "case" is the idempotence sweep in `corpus.test.ts`. Plans 023 and this file said 25.
- 2026-08-28 (W1, N1a/N0e): `traceable` works in the Convex DEFAULT runtime (run id readable inside the traced call; `awaitPendingTraceBatches()` warns rather than throws on an unreachable endpoint). Root cause of 022: the remote-pointer-adoption effect re-triggers on every local commit via `nodesById` identity and adopts the not-yet-published server pointer. `bunx convex codegen` uploads for typechecking but does not deploy (`convex dev --once` does). `api.x.y` is a fresh proxy per access; use `getFunctionName()` for identity in tests. Convex proxies outbound fetch; failures read `tunnel error: proxy authorization required`. A React hook can be driven under vitest with `react-dom/client` + React 19 `act` as a `.ts` test.
- 2026-08-28 (orchestrator): **Vercel Git-triggered production deploys have been BLOCKED since July** (`readyStateReason: commit author does not have contributing access`, `seatBlock: TEAM_ACCESS_REQUIRED`): the GitHub user `bhekanik` (id 4772279) resolves to a Vercel user that is not a member of team `planetaryescape`. Until BK fixes it in the Vercel dashboard (link that GitHub account to the team member, or add the seat), deploy with `vercel deploy --prod --yes` from the main checkout; it runs `npx convex deploy --cmd 'bun run build'` remotely (prod Convex = `careful-capybara-416`) and aliases `recto-dusky.vercel.app`. Verified 2026-08-28 with `681dcde`.
- 2026-08-28 (orchestrator): the main checkout had no `.env.local`; recreated it with `bunx convex dev --once --configure existing --team bhekani-khumalo --project recto --dev-deployment cloud`. Worktrees do not get it (gitignored): copy it. Clerk publishable key derived from the Convex `CLERK_JWT_ISSUER_DOMAIN` (`pk_test_` = base64 of `<frontend-api-host>$`); **prod Convex also trusts the dev Clerk instance** `musical-flounder-88.clerk.accounts.dev`. `CLERK_SECRET_KEY` exists only in Vercel (sensitive, not pullable) and GitHub secrets; needed for e2e (`@clerk/testing`). Secrets for workers live in the session scratchpad `secrets/` dir, never in the repo.
- 2026-08-28 (orchestrator): one shared cloud dev deployment; only one worker per wave may run `convex dev` / push functions (W1 in wave 1). Consider Convex preview deployments per worker for wave 2+.
- 2026-08-28 (orchestrator): Vercel-pulled env files mark every var `[SENSITIVE]`; `vercel env pull` is useless for secrets here. Global `bunx convex` outside `node_modules` is 1.35.1 and fails to bundle; run `bun install` first.
- 2026-08-28 (orchestrator): Codex computer-use (app-scoped, via `~/.agents/skills/computer-use/scripts/computer-use`) stops before confirmation-gated actions (creating an API key) in non-interactive runs; state the owner's approval explicitly in the task.
- 2026-08-28 (orchestrator): Apple: team `WAVMJLFY95`; signing identities "Apple Development: BHEKANI KHUMALO (3RQXYJX7CU)" and "Developer ID Application (WAVMJLFY95)"; BK's other apps use `xyz.planetaryescape.*` bundle ids (life-coach-os targets iOS 26.0 / macOS 26.2, Clerk + Convex from Swift, runbook `life-coach-os/docs/app-store/release-config.md`); Recto keeps `com.bhekani.recto`. No ASC API key found on disk.
- 2026-08-28 (orchestrator): two of six wave-1 agents died instantly on "API Error: Connection lost mid-response" and had to be resumed with SendMessage; always check the first notification before assuming a worker is running.
- 2026-08-27 (orchestrator): `@replit/codemirror-vim` 6.3.0 ships only
  `dist/`; the vim core talks to a ~640-line `CodeMirror` adapter class
  (~60 methods); 7 CodeMirror 6 references total, all in the adapter.
- 2026-08-27 (orchestrator): `node_modules` is not checked in and may be
  absent; `bun install --frozen-lockfile` first. The bun cache lives at
  `~/.bun/install/cache`.
- 2026-08-27 (orchestrator): Apple `swift-markdown` has no footnotes or
  frontmatter and byte-column ranges with open inline-range bugs; do not put
  it on the editing path. `NSTextTable` forces the TextKit 1 fallback.
- 2026-08-27 (orchestrator): Convex default runtime has `node:async_hooks`
  since 1.39 (repo on 1.45); `langsmith` needs it; call
  `client.awaitPendingTraceBatches()` before an action returns.
- 2026-08-27 (orchestrator): OpenRouter always returns `usage.cost`;
  `usage.include` is a no-op now; streaming usage arrives in the final chunk.

## 6. Status

| Worker | Phase | Branch | Status | PR | Reviews (Claude / Codex) | Deployed |
|---|---|---|---|---|---|---|
| W1 history-commit | N1a + N0e | 023/history-commit | in review, round 2 (Codex: 5 blocking → 8 fixes requested, 2 deferred); e2e proof blocked on CLERK_SECRET_KEY | #1 | Claude r1+r2 / Codex r1 done | |
| W2 light-theme | N1c | 023/light-theme | in review (round 1 green; Codex running) | #3 | Claude r1 / Codex running | |
| W3 core-js | N1d + N0d | 023/core-js | in progress (launched 02:30) | | | |
| W4 editor-spike | N0b | spike/editor-engine | **done: GO** (fork @ 08ff3c07) | #2 (draft, not merged) | n/a | n/a |
| W5 native-spike | N0a | spike/native-core | in progress (launched 02:30) | | | n/a |
| W6 vim-spike | N0c | spike/vim-jsc | in progress (launched 02:30, resumed after API drop) | | | n/a |
| W7 settings-workspaces-deletion | N1b | 023/settings | blocked on W1 | | | |
| W8 js-cores | N3 | 023/js-cores | blocked on W3 | | | |
| W9a editor-engine stage 1 (fork plumbing + dialect + RectoEditor skeleton) | N5 | 023/editor-engine | launched 2026-08-28 | | | |
| W9b editor-engine stage 2 (blocks, features, undo-tree, typewriter) | N5 | 023/editor-engine-2 | blocked on W9a | | | |
| W10 native-core | N4 | 023/native-core | blocked on W5 (transport on W1 deploy) | | | |
| W11 ai-on-convex | N2 | 023/ai-convex | blocked on W7 | | | |
| W12 mac-alpha | N6 | 023/mac-alpha | blocked on W9, W10, W8, W2 | | | |
| W13 mac-beta | N7 | 023/mac-beta | blocked on W12, W11 | | | |
| W14 ios-engine-ipad | N8 | 023/ios-ipad | blocked on W9, W12 | | | |
| W15 iphone | N9 | 023/iphone | blocked on W14 | | | |
| W16 release | N10 | 023/release | blocked on W13, W15 | | | |

## 7. Review protocol (orchestrator)

1. Adversarial review of the PR diff against the brief: correctness, data
   loss paths, schema additivity, tests that actually fail without the fix,
   blast radius, plan drift. Written as PR review comments + a message to
   the worker (SendMessage, same agent, keeps context). Iterate until green.
2. Codex review: `command codex exec --yolo -C <worktree> -c
   model="gpt-5.6-sol" -c model_reasoning_effort="xhigh"` with the PR diff
   and the brief; findings go back to the worker; iterate until Codex has no
   blocking findings.
3. Merge: squash merge to `main` via `gh pr merge --squash --delete-branch`
   (author BK). Then deploy and run the post-deploy smoke from the report.
   Web: Vercel Git integration deploys `main` (prod build runs `convex
   deploy`); verify with `curl` on the deployment + the e2e smoke against
   prod when safe. Native: `xcodebuild archive` + upload to TestFlight
   (from W12 on); before that, `xcodebuild test` in CI is the gate.
4. Record status, learnings and interface changes in this file; update the
   next workers' briefs with them.

## 8. Needed from BK (blocks the native lanes, not wave 1)

- **Vercel**: unblock Git deploys (see learnings 2026-08-28). Dashboard → team `planetaryescape` → the blocked deployment's "Request access"/seat prompt, or Account → Authentication → connect GitHub `bhekanik` to the team-member account. Until then the orchestrator deploys via CLI.
- **LangSmith**: org Personal / workspace "Workspace 1" / project `recto` created 2026-08-28 (Developer free plan) via Codex computer use; API key `recto-convex` creation pending owner confirmation.
- Found: Apple team `WAVMJLFY95` (from life-coach-os / worthyourtime); still needed: ASC app records + API key, SIWA in Clerk.

- Apple Developer team ID; bundle ids (`com.bhekani.recto`, `.recto.share`,
  `.recto.quicklook`, `.recto.widgets`); App Store Connect app records for
  iOS and macOS (universal purchase); an App Store Connect API key for
  Xcode Cloud / fastlane; Sign in with Apple service configured in Clerk
  (App ID prefix + bundle id under Native Applications).
- Convex prod env: `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT`,
  `LANGSMITH_TRACING=true`, `AI_CREDENTIAL_KEY` (32 random bytes, base64),
  `AI_UNMETERED_USER_IDS` (BK's Clerk user id), `AI_HOUSE_DAILY_MICROS=0`.
- Fork `nodes-app/swift-markdown-engine` under `bhekanik` (or let W4 do it
  with `gh repo fork`).
- Privacy policy + support URLs (a page on bhekani.com is enough) before
  W16.
