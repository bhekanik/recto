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
| JS core perf (W3, corrected by W8) | Mac: add `com.apple.security.cs.allow-jit` to the app entitlements (JIT on, ~13×). iOS: no JIT; JS core used only at document boundaries (open, paste, save, mode switch, export) off the main thread with a progress state; Swift ports own the per-keystroke paths; device measurement when BK connects an iPhone (not a STOP: extrapolated 0.7–1.1 s for 50 kB is acceptable at boundaries). |
| Multi-window editing (decided 2026-08-28 after PR #9 round 5) | Stage 1 = ONE attached view per `MarkdownEditorController` (a second `attach` is refused). Two windows on one document = two controllers, each with its own storage, kept in sync by `DocumentSession` (W10's registry shares one actor per document; each window applies the session's patches through `applyPatch`). Rich/Raw/Preview remain presentations switchable on the single view. Rationale: TextKit 2 rendering attributes cannot collapse marker advances, so per-view presentation over one storage was never achievable; five rounds of admission machinery kept producing new holes. D-N1's "one storage" is reinterpreted as one storage per window, one document model per document. |
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
| `apple/Packages/RectoEditor` | W9a/W9b | W12, W14, W10 (`storage.onEdit` UTF-16 edit feed), W8 (`controller.textView` for the vim layer) | `RectoTextStorage` (+ `.controller`: `applyPatch(range:replacement:actionName:registersUndo:)`, `applyPatches`, `applyText`, `textView`, `selectedRange`, `undoManager`; `configuration.undo = .external`), `MarkdownStyler`, `Presentation` (.rich/.raw/.preview), `RectoTextView` facade, `RectoEditorView` (SwiftUI), `RectoEditorTheme` (OKLCH defaults until tokens are wired) |
| `apple/Packages/RectoStore`, `RectoSync`, `RectoHistory`, `RectoAuth`, `RectoCore` | W10 | W12 | `DocumentSession` actor via `DocumentSessionRegistry` (shared per document); API, outbox contract and conflict states in `apple/Packages/README.md`; word counting injected (W8's `countWords`) |

## 5. Learnings log (append; newest first)

- 2026-08-28 (orchestrator, merges): `gh pr merge --squash` immediately after a push is refused with "Pull Request is not mergeable" while GitHub recomputes mergeability; wait a few seconds and retry (a local `git merge --squash` + push is the fallback). Never run `git pull origin main` / `vercel deploy` inside `/tmp/recto-backend-split` while it is on a feature branch: deploy from `/Users/bhekanik/code/bhekanik/recto` on `main`.
- 2026-08-28 (W7, N1b): `ctx.storage.delete` throws on an already-deleted file (guard with an existence check). Two React effects in one commit see the same state, so a ref flag set by one is invisible to the other: hydration must be state. A `Blob` cannot cross convex-test's mutation boundary (unwrap to `ArrayBuffer` inside `t.run`). happy-dom has no `window.localStorage`. Same-millisecond `Date.now()` ties break "newest first" assertions. Clerk's `OauthAccessToken` has no refresh token for any provider and deleting a Clerk user does not revoke Apple tokens.
- 2026-08-28 (orchestrator): worker agents expire (transcript gone) after very long runs (W2 after ~460k tokens, W10 after ~955k): plan for a fresh agent per PR review round once a worker passes ~600k tokens; the PR body §1x response tables + package README are the hand-over context. W10's `withKnownIssue` wrapper on the live parent-rule case must be removed by the next W10 agent (dev is redeployed).
- 2026-08-28 (W1, rebase): the session scratchpad root is SHARED across workers; W8 overwrote W1's PR-body file and W1's next `gh pr edit` published W8's text as PR #1's body. Workers must write per-worker files under unique paths (`/tmp/w<N>-*` or a `scratchpad/w<N>/` dir). Also: a worktree rebase can replay an OLD copy of `plans/023-orchestration.md` over main's; workers must take main's version of that file.
- 2026-08-28 (W8, round 3): `@marijn/find-cluster-break` and `NSString.rangeOfComposedCharacterSequence` are NOT UAX #29 (miss Hangul jamo sequences, SpacingMark, Prepend, CRLF); use `Intl.Segmenter` in JSC and Swift `Character` boundaries, gated by Unicode 16 `GraphemeBreakTest.txt`. Linux ICU and macOS ICU disagree on some emoji ZWJ rows: assert only the strict half, print allowances. Truncated assertions (`expect(failures.slice(0, 10))`) hide failures. `git add -A` while a Codex subagent has work in flight sweeps its files into the wrong commit. Corrected JIT figures: 12–13× at 8–64 kB, 4.2× at 250 kB (pooled across fresh processes); the iPhone run still needs BK's device.
- 2026-08-28 (W9a, round 3): TextKit 2 rendering attributes (`setRenderingAttributes`/`renderingAttributesValidator`) do NOT affect layout, so marker hiding by font-size/kern collapse cannot be per-view; per-presentation views over one storage need a layout-neutral hiding technique (zero-size attachment, fragment skipping marker glyphs, or per-presentation content storage kept in step by patches): W9b design item. Interim: one controller = one presentation (`accepts(rawSourceMode:isEditable:)`). Swift Testing parallelises ACROSS suites: window-backed suites must nest under one `.serialized` parent. SwiftPM refuses `unsafeFlags` in a package consumed as a dependency: warnings-as-errors must be a CI step. Incremental parse windows must extend until the trailing block cannot be reinterpreted by the suffix (paragraph/table row/definition/list/blockquote/fence), not just "fence closed".
- 2026-08-28 (W10, round 4): a remote pointer-only move (undo on another device) is indistinguishable BY ANCESTRY from "the server has not seen our nodes yet"; `pointerRevision` (monotonic per document) is what separates them (`ConflictResolver.remotePointerIsNewer`). convex-swift's SDK-owned `onIdToken` push callback cannot be serialized by client code; W10 deleted it (pull path only, verified by N0a to hold a session across ~20 rotations); forking convex-swift stays the escalation if #26 reproduces on device. Owner mismatch with retained unsynced work now BLOCKS sign-in (`AuthStatus.blockedByRetainedWork`) until explicit consent: W12 must build that UX.
- 2026-08-28 (orchestrator, process): PR #1 has taken 10 review rounds; rounds 5–9 mostly found regressions in code added by the previous round (the cross-hook projection contract), i.e. each fix widened the surface. Rule for round 11 onward: if Codex still reports NEW single-device regressions after round 10, split the PR: (a) backend `commitEdit` + `pointerRevision` + `markdownHeadNodeId` + validation (additive, needed by W10) merges first behind the existing client, (b) the client cross-hook rework lands as its own PR with the combined harness, so the native lanes stop waiting on the web client's convergence.
- 2026-08-28 (W1, round 9): a revert that breaks the build makes vitest report "no tests", which looks like a pass; check the executed test COUNT in revert verification, not only the absence of failures.
- 2026-08-28 (W8, round 2): `NSUndoManager.groupsByEvent = false` breaks IME (`setMarkedText` reaches `_prepareEventGrouping`, which raises): scope it to the adapter's own writes only. ICU treats `\r\n` as one grapheme cluster; keep line endings verbatim per line. Bounds checks must precede grapheme-boundary assertions. JIT claim corrected: 13–15× between 8 and 64 kB, 4.5× at 250 kB (fresh-process median/p95); the iOS no-JIT conclusion is source-based (WebKit `ExecutableAllocator.cpp`), not device-measured.
- 2026-08-28 (W10, round 3): `documents.list` carries no body, so a newer `updatedAt` on a known document must trigger a `get` to see another device's stamped draft. A deterministic `SIGBUS (EXC_ARM_DA_ALIGN)` inside a Swift concurrency job pointed at convex-swift's FFI auth bridge (issues #21/#26) during the live tests; it stopped after serializing `loginFromCache`/`logout` but ALSO stops with that fix reverted (likely SwiftPM stale-build), so it is unverified: watch TestFlight crash reports from W12 on. A fake transport's delay gate must NOT be cancellation-aware (real Convex calls do not abort when their Task is cancelled), or `stop()` looks correct when it is not.
- 2026-08-28 (W1, round 8): an asserted revert-pattern match proves the edit landed, not that it changed behaviour (a `useRef` initialiser flip was inert because a reset effect reassigns the ref on mount); when a revert still passes, instrument before concluding. Follow-up: an e2e/component test for the real `PaneEditor` preview→raw remount path (the hook harness cannot model the `paneMarkdown` override).
- 2026-08-28 (Codex on W9a): the fenced-code typing cliff is `BlockParser.incrementalParse` returning nil when the incremental window ends in `.fencedCode` (full reparse per keystroke). The engine creates one `NSTextContentStorage` PER VIEW (`NativeTextView(frame:)` per wrapper; controller keeps only the last attached view), so "one storage, several presentations" (D-N1) needs the document to own the storage and each view its own layout manager. Raw mode must switch off quote/dash substitution, text replacement, autocorrect and smart insert/delete; the engine's paste path (`sanitizePastedText`) rewrites Markdown (trims indented code, hard-break spaces); Writing Tools acceptance writes back the whole binding without firing the mutation feed; whole-text diffs split surrogate pairs (ill-formed `String`, `JSONSerialization` error 3852).
- 2026-08-28 (orchestrator): Codex sometimes overwrites its `-o` report with a one-line link as its final message; the full report survives in the `--json` events log as an apply_patch diff (`+`-prefixed lines): extract by line range.
- 2026-08-28 (W8, N3): **the ~10 ms/kB JSContext figure was JavaScriptCore WITHOUT its JIT**: a hardened-runtime process needs `com.apple.security.cs.allow-jit` (plan §2's Mac entitlement list was missing it); with it, 50 kB `normalize` goes 525 → 54 ms (13×); `jsc --useJIT=false` reproduces the slow column. iOS: third-party in-process JSC has no JIT on 17/18/26 (WebKit `isJITEnabled()`/`process-entitlements.sh`); the SIMULATOR has the JIT (`HAVE_IOS_JIT_RESTRICTIONS` excludes it), so simulator numbers are not the go/no-go; extrapolated device cost 0.7–1.1 s for 50 kB (`apple/Spikes/JSCPerf/README.md` has the device command for BK). Swift ports `WordCount`/`Outline`: 6.65 ms vs 593 ms at 64 kB. A `Resources/` directory inside a SwiftPM resource bundle breaks iOS codesigning (renamed `JS/`). `Vim.defineMotion("moveByCharacters")` is load-bearing for the grapheme clamp (upstream-upgrade checklist). Per-key CPU time p50 0.10 / p95 0.19 ms at 10k words without JIT. W3's README "the JIT is running" conclusion is wrong (fix when touching that file).
- 2026-08-28 (W9a, N5 stage 1): GitHub `macos-26`/`macos-latest` runners DO have the macOS 26 SDK + Xcode 26.6 + Swift 6.3 (no `continue-on-error` needed); pin `macos-26`. Engine gotchas: `lists.helpersEnabled` gates the drawn bullets as well as editing helpers (tying it to `isEditable` leaves preview showing raw `-`); hiding a whole-line marker needs its LINE HEIGHT collapsed (0.01 pt), not just the font (a newline starts a new fragment whatever its font); `applyPatch` exists to avoid the `textView.string =` rebuild (caret → {0,0}), AppKit already adjusts the caret through `replaceCharacters`; a paragraph abutting a fenced code block with no blank line costs ~3× per keystroke (4.4 → 13.4 ms) anywhere in the document (unexplained, inside restyle scoping; recorded as a test); the engine force-unwraps `NSApp.effectiveAppearance` in table styling (headless render with a table kills the process; fix before W12); wiki links were the only construct where display ≠ storage, so deleting them made `applyPatch` coordinates unambiguous. Fork `recto` branch: tools-version 6.2, `defaultIsolation(MainActor.self)`, 19.5k → 16.5k lines, 384 tests; pinned `8646430`. Design §5 tracking −0.015 em NOT applied (moves cached table bitmaps). Plans §1.3 still mention overlay tables / `setRenderingAttributes` (reversed by §0b).
- 2026-08-28 (W10, round 1): SwiftPM can serve a STALE cross-package module: after editing `RectoSync`, `swift test --package-path apple/Packages/RectoCore` ran the previous build of the dependency and produced failures contradicting the source; `rm -rf .build` fixes it. Swift Testing skips: use `@Suite(.enabled(if:))` / `try #require`, never `Issue.record` (that fails the suite). Determinism work in the sync engine exposed four real bugs (stale `open()` snapshot, resolver re-seed producing no commit, `.failed` state overwritten by reconcile, `awaitingNodes` waiting on a dead subscription): flaky tests were engine bugs.
- 2026-08-28 (W1, rounds 3–4; Codex): `documents.markdown` carries no provenance, so a client cannot tell a newer same-head draft from a legacy/stale headless save; decision: additive `documents.markdownHeadNodeId` written by `commitEdit` and by guarded `updateMarkdown`; clients trust `documents.markdown` over `materialize(head)` only when provenance matches the head. Cross-hook contracts (sync ↔ history) need a combined harness with ONE global FIFO for mutation responses (Convex orders all of a client's mutations) and query snapshots advanced before a mutation resolves.
- 2026-08-28 (W10, N4): history patches must be computed on UTF-16 code units (`[UInt16]`), not `Swift.String`: a patch boundary can land inside a surrogate pair (😀→😁 stores `{"from":1,"to":2,"insert":"\ude01"}`), a lone surrogate no `String` can hold and `JSONSerialization` corrupts, so the patch JSON needs a hand-written reader. jsdiff-style Myers must compare tokens with `utf8.elementsEqual` (Swift `==` is canonical equivalence; JS `===` is not). `DatabasePool(path: ":memory:")` cannot open. convex-swift has no one-shot query. `swift test` on macOS can drive a real Clerk sign-in (the -34018 keychain trap is simulator-only). Fixture generation must be deterministic (ULIDs are random) for a `git diff --exit-code` CI gate. `lib/stats/streak.ts` subtracts 86,400,000 ms and is wrong across a DST transition; the Swift port steps a calendar day (follow-up F2: fix the web). ConflictResolver needs a fifth state, `awaitingNodes`, when the remote head is not yet in the local DAG. Dev deployment name: `marvelous-ibis-268`.
- 2026-08-28 (orchestrator): `vercel deploy` from the main checkout uploads the working tree and hit "Request body too large. Limit: 10mb" once `.claude/worktrees/` (12 GB of agent worktrees, gitignored but not ignored by the CLI) existed. Fixed with a committed `.vercelignore` (`.claude/`, `apple/`, `spikes/`, `plans/`, `docs/`, `e2e/`, `test-results/`). The non-blocking `e2e` CI job fails on every run because the `*_CI` GitHub secrets were never set (all empty in the job env).
- 2026-08-28 (W2, round 2): a contrast suite must assert every token against every surface it can land on (token × layer × palette matrix on the raw ratio); Paper `ink-tertiary`/`success`/`warning` moved to L 0.51/0.50/0.51; `on-accent` is now each palette's canvas colour (Twilight 5.02, Aurora 5.85, Dawn 5.34, Moonlit 6.96, Paper 7.92). **Pre-existing bug on main**: the shadcn `@theme inline` block redefines `--color-accent`, so Twilight's live accent (caret, list markers, active states) renders as `accent-muted`; fix = rename Recto's accent token (scheduled as a follow-up PR after #3). React re-inserts a JSX-rendered `<meta>` after a pre-hydration script mutates it (`suppressHydrationWarning` on `<html>` does not cover head children): a script-owned element must be created by the script, not rendered by JSX. Aurora's `on-accent` equals its `bg-app` by design (breaks naive string replacement in tokens.json).
- 2026-08-28 (W3, N1d/N0d): `bun build --target=browser` picks DOM implementations via package `exports` (`decode-named-character-reference` → `index.dom.js` calls `document.createElement` at module scope); `conditions: ["worker"]` selects the DOM-free variants without polyfills. A bare `JSContext` has no `console` (the bundle carries a no-op prelude) and no `TextDecoder` (pass strings, never bytes). Grepping a bundle for `window`/`document` is not a usable gate; loading it in a `node:vm` realm with no DOM globals and calling every entry point is. `htmlFromMarkdown` = `lib/preview/render.ts` (sanitized); `lib/export/html.ts` reads `window.location.origin` and stays web-only. `lint` is the only async call (lazy `write-good` import; JSC drains microtasks before returning to native, so a Swift `then` has run when `invokeMethod` returns). Bundle is deliberately unminified (`adverb-where` regex corrupts under minifiers). **Plan §1.5 was wrong**: whole-document calls in the system `JSContext` cost ~9 ms/kB (927 kB → 9 s; 48 kB → 440 ms), ~20× Bun's JSC on the same bundle; `JSC_*` env options are ignored by the system framework. Decision: countWords/parseOutline/streak get Swift ports (fixture parity); normalize/htmlFromMarkdown/markdownFromHtml/lint stay in JS at document boundaries (open, paste, save, mode switch, export) off the main thread. **iOS in-process JSC has historically had no JIT for third-party apps; measuring on a device is the N3 go/no-go.** `Bun.fileURLToPath` fails under vitest/Node (`Bun is not defined`): use `node:url`. `packages/*` are not Bun workspaces (no own deps; `@/*` alias).
- 2026-08-28 (W1, round 2): "verified the test fails without the fix" claims need the revert pattern asserted to match; a `sed`/replace that silently matched nothing (biome reformatted the code) produced a false pass. Remote pointer adoption now queues (`pendingRemotePointerRef`) and reconciles on window `focusout` + on `diverged`; `GroupingController.hasPendingDraft` is the exact "local input no node captured yet" signal.
- 2026-08-28 (W6, N0c GO): `@replit/codemirror-vim`'s `initVim(CM)` is a factory taking the editor adapter as its only argument, so the core splits out verbatim (0 upstream lines modified; `initVim` 7,043 lines, adapter ~690; plan §1.4's "~7,200 / ~640" was close). JSContext load ~3 ms, bundle 119 kB; per-key bridge p50 0.05 ms / p95 0.09 ms on a 10k-word doc, p95 0.49 ms at 950 kB (CPU time; wall-clock is noise while other workers load the machine: measure with `CLOCK_THREAD_CPUTIME_ID`). 64/64 fixtures identical in Bun and JSC; 12/12 NSTextView steps. **Grapheme clamping is an N3/N5 acceptance criterion**: the core clips to code points, so ZWJ families, flags, skin tones and combining marks corrupt silently (`a👨‍👩‍👧‍👦b` → `a‍👩‍👧‍👦b`). Undo: direct `NSTextStorage` mutation is invisible to undo (use `shouldChangeText`/`didChangeText`, `groupsByEvent = false`); after `u` the undo tree must compute a vim-shaped caret from the patch. Macro recording opens an input-less dialog: do not treat it as a prompt. `dG` leaves a trailing empty line upstream (web does too; parity is correct). Soft-wrapped `j`/`k` need the host's `findPosV`. Fallback (native Swift vim subset) re-estimated at 6–8 weeks, not 4.
- 2026-08-28 (W6, environment): `~/package.json` was a dangling symlink to a purged `.dotfiles/package.json`; Bun resolves upward and dies with `Cannot read file "/Users/bhekanik/": ENOENT`, breaking `bun build` for any project under `$HOME` (`bun run`/`bun test` only print it). Orchestrator removed the symlink 2026-08-28.
- 2026-08-28 (W5, N0a GO): clerk-ios 1.5.0 + convex-swift 0.8.1 work on macOS 26 + iPadOS 26.4.1 (sign-in, templated JWT, live subscriptions, mutations, reconnect after suspend, token rotation ~50 s without dropping the socket, signed sandboxed Release archive). **`clerk-convex-swift` 0.1.0 must not be used**: its untemplated token has `aud=<none>` and Convex rejects it as a silent 1 s reconnect loop; the spike's `ConvexTemplateAuthProvider` (~130 lines, `session.getToken(.init(template: "convex"))`, TTL 60 s) replaces it. `ConvexClient` is non-Sendable with nonisolated async methods: an actor must own it; `@preconcurrency import ConvexMobile` under Swift 6. Subscriptions are Combine publishers that terminate permanently on a server error (re-subscribe on auth transitions). `Int` encodes as `$integer` and `v.number()` rejects it: send `Double`. `ConvexClientWithAuth.logout()` abandons teardown if the provider throws. Simulator builds must be signed with `keychain-access-groups` or Clerk traps (-34018); `-destination` needs the exact runtime (`id=<udid>`). macOS Release: `ARCHS=arm64` + `EXCLUDED_ARCHS[sdk=macosx*]=x86_64` (no x86_64 macOS slice in the xcframework; issue #10). #19/#20 (no optimistic updates/cache) are covered by the GRDB mirror + outbox. **§1.7 fallback dropped** (decision): no own transport; keep the client behind a `RectoSync` actor. Clerk dev instance: email code + Google enabled; **passkeys disabled and Sign in with Apple not configured** (BK dashboard actions; D-N12).
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
| W1 history-commit (client half) | N1a | 023/history-commit | round 14 (Codex r13: 3 blocking: OCC-exhaustion/rate-limit rejections are retryable and must not be terminal; resolveBlockedWrite is destructive and incomplete with no disclosure; the pointer CAS expectation is advanced by ignored snapshots instead of being causal to the queued move; 1 test gap) | #1 | Claude / Codex r1–r13 | |
| W1b history-backend (backend half, cut by the orchestrator from W1's head `9cf1e94`) | N1a + N0e | 023/history-backend | **merged + deployed** 2026-08-28; smoke: `commitEdit` validates, LangSmith smoke skips (no key) | #11 | orchestrator / Codex (no blocking) | prod |
| W1c pointer-cas (backend follow-up cut by the orchestrator: `updateCurrentNodeId.expectedPointerRevision`; review accepts bump the revision) | N1a | 023/pointer-cas | **merged + deployed** 2026-08-28 (prod + dev); gated locally (CI billing-blocked) | #13 | orchestrator / Codex (1 finding fixed) | prod |
| W1d refusal-codes (backend follow-up cut by the orchestrator: `ConvexError({code})` for deterministic refusals; `TERMINAL_REFUSAL_CODES` excludes `unauthenticated`) | N1a | 023/refusal-codes | **merged + deployed** 2026-08-28 (prod + dev) | #14 | orchestrator / Codex (2 findings fixed) | prod |
| W2 light-theme | N1c | 023/light-theme | **merged + deployed** 2026-08-28 (`b9fe11b`, `vercel deploy --prod`) | #3 | Claude r1+r2 / Codex r1 | prod `recto-dusky.vercel.app` |
| W3 core-js | N1d + N0d | 023/core-js | **merged** 2026-08-28 (`42acd0c`); main CI green (ci, core-js) | #6 | Claude r1+r2 / Codex r1 | n/a (CI) |
| W4 editor-spike | N0b | spike/editor-engine | **done: GO** (fork @ 08ff3c07) | #2 (draft, not merged) | n/a | n/a |
| W5 native-spike | N0a | spike/native-core | **done: GO** (clerk-ios 1.5.0 + convex-swift 0.8.1; own templated auth provider) | #4 (draft, not merged) | n/a | n/a |
| W6 vim-spike | N0c | spike/vim-jsc | **done: GO** (verbatim core split, ~20× latency headroom) | #5 (draft, not merged) | n/a | n/a |
| W7 settings-workspaces-deletion | N1b | 023/settings | round 3 (Codex r2: 3 of 9 fixed, 6 partial; 6 blocking: export registers after purge; uploads complete before registration; blob backfill unbounded reads; reviewer purge exceeds transaction limits; accepted status applied per document not per branch; settings ack clears in-flight changes; resume scheduling gap; final purge ignores pass cap) | #12 | Claude r1 / Codex r1+r2 | |
| W8 js-cores | N3 | 023/js-cores | round 5 (Codex r4: 3 blocking: insert-mode cursor keys desync caret/mirror/undo; IME resync exits insert mode; external mid-insert edit joins the open undo group; 2 should-fix in the Swift word-count port); W8 agent EXPIRED at ~886k tokens → **W8b** (fresh agent) launched; iPhone measurement = BK | #10 | Claude r1 / Codex r1–r4 | n/a (CI blocked on billing) |
| W9a editor-engine stage 1 (fork plumbing + dialect + RectoEditor skeleton) | N5 | 023/editor-engine | round 6 (Codex r5: 4 blocking inside the multi-view admission machinery → SCOPE DECISION: one attached view per controller, multi-window via DocumentSession; W9a agent at ~870k tokens → **W9a-b** (fresh agent) removes the machinery) | #9 + fork PR #1 (`c4d9c97`) | Claude r1 / Codex r1–r5 | n/a (CI blocked on billing) |
| W9b editor-engine stage 2 (blocks, features, undo-tree, typewriter) | N5 | 023/editor-engine-2 | blocked on W9a | | | |
| W10 native-core | N4 | 023/native-core | round 7 (Codex r6: 8 of 9 fixed, 1 partial; 4 blocking: failed replacement login restarts sockets on the old bridge; purged account's open sessions stay readable in memory; native pointer moves still use wall-clock LWW instead of PR #13's CAS; rejected-pointer + tail commit strands instead of surfacing divergence) | #7 | Claude r1 / Codex r1–r6 | n/a (CI blocked on billing) |
| W11 ai-on-convex | N2 | 023/ai-convex | blocked on W7 | | | |
| W12 mac-alpha | N6 | 023/mac-alpha | blocked on W9, W10, W8, W2 | | | |
| W13 mac-beta | N7 | 023/mac-beta | blocked on W12, W11 | | | |
| W14 ios-engine-ipad | N8 | 023/ios-ipad | blocked on W9, W12 | | | |
| W15 iphone | N9 | 023/iphone | blocked on W14 | | | |
| W16 release | N10 | 023/release | blocked on W13, W15 | | | |
| F2 streak-dst | N1 follow-up | (folded into PR #7) | assigned to W10 round 2 | | | |
| F1 accent-token-rename | N1c follow-up | 023/accent-token | **merged + deployed** 2026-08-28; prod CSS no longer redefines `--color-accent` | #8 | Claude / Codex (no blocking) | prod |

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

- **Convex prod env for deletion**: set `CLERK_SECRET_KEY` on `careful-capybara-416` before PR #12 deploys (the Delete-account action refuses up front without it).
- **Sign in with Apple token revocation (TN3194)**: Apple's `/auth/revoke` needs an ES256 client secret signed with the team's `.p8` key plus the user's Apple token; Clerk holds neither. Decision needed: put the Apple Services key (`.p8`, key id, team id, services id) on Convex as env, and enable SIWA on the Clerk instance so it can be verified. Until then deletion reports revocation as not performed (an iOS release blocker per 5.1.1(v)).
- **GitHub Actions billing** (found 2026-08-28 by W8): every CI job now fails to start with "recent account payments have failed or your spending limit needs to be increased". Until fixed in GitHub billing settings, the orchestrator gates merges on locally re-run suites instead of CI.
- **Vercel**: unblock Git deploys (see learnings 2026-08-28). The PR check now shows the exact fix: an invite link `https://vercel.com/teams/invite?...teamId=team_3oxuHKlgssY2lCgwFXZJAuOB` ("Git author bhekanik must have access to the project on Vercel to create deployments"): open any PR's Vercel check → follow the invite as the GitHub `bhekanik` account. Dashboard → team `planetaryescape` → the blocked deployment's "Request access"/seat prompt, or Account → Authentication → connect GitHub `bhekanik` to the team-member account. Until then the orchestrator deploys via CLI.
- **LangSmith**: org Personal / workspace "Workspace 1" / project `recto` created 2026-08-28 (Developer free plan) via Codex computer use; API key `recto-convex` creation pending owner confirmation.
- Found: Apple team `WAVMJLFY95` (from life-coach-os / worthyourtime); still needed: ASC app records + API key.
- **Clerk dashboard (dev instance `musical-flounder-88`)**: enable Passkeys; configure Sign in with Apple (Apple Services ID + key under team `WAVMJLFY95`); add a Native Application entry (App ID prefix `WAVMJLFY95`, bundle id `com.bhekani.recto`); allowlist the native OAuth redirect `com.bhekani.recto://callback`. Sign in to dashboard.clerk.com in Dia so Codex computer use can fetch the dev `sk_test_` key for e2e.

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
