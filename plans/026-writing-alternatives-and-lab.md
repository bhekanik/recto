# Writing experiments stay attached to the draft

Status: full feature set unfinished. Overflow 0.1.3 is published and installed; its actual held drag, Undo/Redo, online sync and full relaunch pass. The offline edit/reopen check awaits approval for a brief Ethernet and Wi-Fi disconnect. Atomic stash/restore, alternatives, Ghost, Lab and web parity remain unfinished. BK accepted the selected model and waived the unavailable cross-provider review.

The chat is the source of truth for scope and decisions. This file preserves the execution detail for the next agent. The HTML companion is temporary and is linked in the chat.

## Completion means writing with these features safely

BK can open a real draft, create and cycle through word, sentence and paragraph alternatives in place, ghost and revive a passage, stash material in Overflow and bring it back, and run a focused Lab pass. Proposed cuts fade in place without rewriting the surviving prose. Each suggestion explains its purpose and can be kept, rejected or applied. Closing and reopening, switching editor modes, undo/redo, branching history and syncing preserve both the draft and its writing material.

Manual features work offline. AI is explicitly requested and uses Recto's existing consent, provider and document-access checks. A delayed result cannot replace text BK has changed while it was running.

Accepted sequencing for this run: macOS library drafts first, then web, following BK's acceptance of the proposed execution. Shared contracts must preserve still-deployed clients. Plain Markdown file support and ghost export semantics need decisions before the storage contract is finalised; recommendations appear below.

## The scope follows the video and four concrete Lab passes

- Alternatives at word, sentence/headline and paragraph level: create, edit, delete and cycle in context; preserve the original; mark the current choice; distinguish human and AI suggestions; adjust a/an when an applicable word substitution requires it.
- Ghost and Revive: keep selected text in its original position at roughly 10% opacity, visibly recoverable and editable.
- Overflow: a document-scoped scratchpad for unused passages, notes, links and outlines; stash a selection and restore material through insert, copy/paste or drag.
- Optional AI alternatives: add candidates to the same alternatives list; never silently replace the selected text.
- The Lab has four editorial passes: find repetition and unnecessary explanation; audit the opening; find confusing passages; check voice and phrasing. Existing grammar/typo corrections and local lint findings remain available within these flows rather than becoming a second editing system.
- The cut pass previews exact removals, explains each cut, supports keep/reject and a walkthrough, and reports the projected word count. The default is contribution-based cutting. Optional 10%, 20%, 30% and 50% presets express an approximate reduction request; they do not force deletion to satisfy a quota.

The essay skill shapes these passes: preserve facts, quotations, citations, useful roughness and British spelling where the draft follows it; flag gaps rather than inventing material; read patterns in context; connect ideas; stop after a useful pass. It does not create a tool for every editorial step.

Deferred: idea maps and structural rearrangement, thesis and storytelling reviews, author interviews, full fact-checking, an automatic end-to-end essay editor, social publishing and invisible-character cleanup. Existing save/open remains the document workflow. No feature depends on clicking the word count to become discoverable: selection actions and the command palette should expose them, with quiet contextual panels.

## The baseline already supplies several parts

Code inspected from freshly fetched `origin/main` at `8de7737dcafba3ec6bff0e08474d697e001cc588`. The working checkout is at `9edcc2c64f1097c80ef3dfd93cda8058882a5c25`; it must not be used as the implementation baseline. Start implementation in an isolated checkout from a fresh remote fetch and re-fetch before pushing.

| Existing code at the baseline SHA | Reuse and limitation |
|---|---|
| `lib/lint/analyze.ts`; `apple/RectoApp/Sources/ProseLinting.swift` | Local readability, passive, adverb and weasel/filler findings; includes indefinite-article analysis. Reuse these rules and their code/link/frontmatter masking. |
| `apple/Packages/RectoEditor/Sources/RectoEditor/RectoDecorationController.swift` | Native source-range dimming, lint underlines and comment highlights. Extend decorations for ghost spans, alternative indicators and pending cut previews. |
| `lib/editor/handle.ts`; `components/workspace/pane-editor.tsx` | Shared web editor handle, captured AI selection replacement, mode switching. Persistent writing spans still need canonical source-range capture and mapping through edits. |
| `apple/Packages/RectoCore/Sources/RectoCore/DocumentSession.swift`; `apple/Packages/RectoStore/Sources/RectoStore/Records.swift` | Session-owned changes, local recovery, history and outbox. Text plus writing state must share the same commit boundary. |
| `convex/schema.ts`; `convex/documents.ts`; `convex/docNodes.ts` | Cloud Markdown and branching history. Add backwards-compatible, versioned writing state; never keep it only in a panel's component state. |
| `convex/ai/review.ts`; `lib/ai/use-ai-review.ts`; `apple/RectoApp/Sources/AIClient.swift` | Authenticated, source-identified AI review and request recovery. Current review creates comments and a suggestion branch: a Lab preview must not call it unchanged and then pretend nothing was committed. |
| `lib/review/anchor.ts`; `apple/RectoApp/Sources/CommentAnchor.swift` | Quote/context relocation is useful for navigation. The web anchor caps quotes at 200 characters and has fuzzy fallback: do not use it unchanged to replace paragraphs or delete text. |
| `packages/recto-core-js/entry.ts`; `apple/RectoApp/Sources/SharedRectoCore.swift` | DOM-free TypeScript shared with native through JavaScriptCore. Put pure writing-state and result-validation rules here; Swift and React own their UI. |
| `apple/RectoApp/Sources/RectoDocument.swift`; `apple/RectoApp/Sources/ExportController.swift` | Plain files serialise Markdown bytes; exports currently consume Markdown. New writing metadata needs an explicit file-storage decision and a consistent export projection. |

These are source-level findings, not claims that new features have been tested in a running app. The older status prose in `plans/README.md` is not authoritative for current behaviour.

## Writing state follows the same history as the prose

Proposed contract: canonical Markdown remains the prose source. A versioned, document-owned writing state carries alternatives, ghost spans and Overflow. Do not encode private working material into rendered prose or replace the Markdown dialect.

- Alternative groups have stable IDs, a complete selected source span, original wording, candidate IDs and authorship, and the active candidate. Ghost spans have stable IDs and complete ranges. Overflow entries have stable IDs, Markdown content and optional origin information.
- Range offsets use UTF-16, matching JavaScript strings and native source ranges. Store complete spans, not truncated comment quotes. Map them through actual editor changes or verified canonical patches, including Unicode and normalisation changes.
- Previewing alternatives or cuts is temporary. Choosing an alternative, ghosting, reviving, stashing, restoring and accepting cuts are named history operations. Metadata-only edits must still be undoable. Undo, branch navigation and recovery restore text and metadata together.
- Persist writing state with history checkpoints and recoverable drafts, and include it in native SQLite/outbox and cloud commits. Prove whether complete snapshots or explicit metadata deltas fit the existing history path inside the first usable release; keep the first representation simple and versioned.
- Overlapping edits must have explicit behaviour. If a replacement touches another group's span, keep its saved candidates but mark its anchor detached until it is deliberately reattached. Never guess a destructive target from fuzzy similarity. Concurrent/offline divergent edits keep separate history branches rather than merging unrelated spans by offset.
- Typing in an active alternative updates that candidate through the same transaction. Cycling is an in-place preview; completing the interaction commits the chosen candidate once. Escape restores the starting choice. Commit the preview before subsequent typing so displayed and persisted text agree.
- Opening an older document produces empty writing state. An older client must not erase new metadata; incompatible writes must map/preserve it or fail with a recoverable update message. Include the metadata revision in conflict checks and AI source identity.
- Document deletion, account deletion, retention and duplication must cover the new state. Overflow can reference uploaded images, so extend blob-reference accounting rather than deleting an image still used in Overflow or saved alternatives.

Recommendation for publication: reader-facing preview, copy and exports use the chosen alternatives and omit ghosted text and Overflow. Explicit source-copy/file-save remains distinguishable and never silently destroys working material. AI Lab input uses the active draft, excluding Overflow and discarded alternatives unless BK deliberately includes them. Validate this projection on the server against the full stored document and metadata revision; the current review requires full source text, so projection cannot bypass that check.

Recommendation for delivery: synced-library documents first, including their offline local mirror. Plain `.md` files need a durable metadata identity and portability policy before these features are advertised there. This is an unresolved scope decision, not permission to silently disable existing file workflows.

## Every release adds a complete writing capability

The initial component phases are replaced by the ladder below. Storage, range mapping, AI validation and UI ship inside the capability that needs them. No hidden fixture or backend-only milestone counts as a usable release. macOS library-first is the accepted starting scope for this run.

| Rung | User promise and exact demo | Acceptance beyond the demo | Dependencies and non-goals |
|---|---|---|---|
| 1. Keep material in Overflow | Open a library draft, type or paste a note into Overflow, close and reopen offline, then copy the note back into the editor. | Notes stay available during prose history navigation; focused note editing has its own undo. Recovery and reconnect retain them. Old clients cannot erase state. Document/account deletion and image retention include saved notes. | Establish release path and fix relevant baseline failures. Include only Overflow's versioned state; no selection moves or range framework yet. |
| 2. Move passages without losing them | Select a paragraph, stash it in Overflow, restore it at the caret, undo the restore and then undo the stash. | Text and notes commit atomically. Retry, crash and concurrent edits cannot duplicate or lose the paragraph. Two views observe the same operation. | Rung 1 deployed and its journey passes. No alternatives, Ghost or AI. Dragging selected Overflow text into the editor at the actual drop position is required. A copy retains the notes; a move requires the same atomic history contract as stash/restore. |
| 3. Compare word choices in context | Save an original word and two manual alternatives, cycle with the keyboard, choose one, reopen and undo the choice. | UTF-16 mapping, repeated words, adjacent edits, detached targets and metadata-only history behave safely. Preview is temporary; Escape restores the starting choice. | Rung 2 deployed. No sentence/paragraph groups, article adjustment or AI. |
| 4. Compare openings and paragraphs | Select a headline, sentence or paragraph, add/edit alternatives, compare inline and commit a choice; try a word substitution requiring a/an adjustment. | Complete selections beyond 200 characters, Markdown boundaries, Unicode, overlap and normalisation are covered. Article changes share the same undo operation. Typing updates the active candidate. | Rung 3 deployed. No generic annotation framework or new editor. |
| 5. Set text aside in place | Ghost a sentence, keep editing, revive it, reopen the draft and export the reader-facing version. | Ghost, lint, comments and focus decorations compose. Undo restores state. Preview/copy/HTML/DOCX follow the agreed publication policy without losing source material. | Rung 4 deployed; ghost publication policy settled. No Lab previews. |
| 6. Review and apply justified cuts | Run the cut pass on BK's draft, inspect exact proposed deletions and reasons, keep one passage, apply the remaining cuts, then undo. | Preview changes neither source nor history. Surviving prose is unchanged. Source/revision checks reject stale or ambiguous cuts; cancellation and uncertain request recovery remain safe. Projected word count agrees with the result. | Rung 5 deployed. Include the real AI lifecycle, consent, editor preview and bounded live-provider validation. Fixtures alone do not ship a Lab. Percentage requests remain approximate. |
| 7. Request alternatives deliberately | Select a passage, request AI alternatives, distinguish them from manual candidates and compare before choosing. | Validated candidates have stable IDs and source identity. Retry cannot duplicate candidates. Typing, sign-out or document switches invalidate application. | Rung 6 deployed. Reuse existing provider/consent/recovery paths; no separate AI integration. |
| 8. Improve the opening | Run an opening pass, inspect its assessment against the whole draft, add up to three grounded candidates and compare inline. | Facts, quotations and personal experience are preserved; missing material becomes an author question. BK reviews actual examples for usefulness. | Rung 7 deployed. No broad essay score or automatic whole-draft rewrite. |
| 9. Repair confusing passages | Run the clarity pass, navigate to a flagged passage, read the concrete difficulty and try a targeted alternative or retain an author question. | Exact passages and specific reasons; no guessed destructive target. Stale/malformed output remains inspectable but cannot be applied. | Rung 8 deployed. No full research/fact-checking workflow. |
| 10. Check voice and phrasing | Run the voice pass, inspect a register or phrasing concern, compare its restrained alternative and keep or reject it. | British spelling and useful roughness survive; pattern detections are contextual hypotheses. Reviewed examples show a useful editorial pass. | Rung 9 deployed. Reuse local lint/grammar findings where applicable; no tool for every essay-skill step. |
| 11 onward. Use each capability on the web | Release Overflow first, then the remaining deployed native capabilities in separate usable web increments. On each increment, edit the same draft on both clients and reopen it. | Rich/raw/Vim/preview and two panes preserve canonical source and writing state. Mixed-version clients, offline edits and history navigation are covered. | Only port a deployed contract. Do not combine all web parity into one oversized final release. |

For rungs 1–10 the proposed target is the established signed, notarised macOS GitHub DMG release, with any required backwards-compatible Convex change deployed before the consuming client. Each web increment uses the repository's established web deployment after its identity is verified. BK accepted the proposed execution through the established release channels. Verify the exact backend/web identity before mutation; this does not authorise account, billing or credential configuration changes.

Each rung includes its UI, minimal domain logic, persistence/backend, error handling, targeted checks, reviewed merge, installation and real demo. If a promise cannot fit one working session, narrow it before assigning it. For example, rung 1 can ship typed/pasted Overflow before rung 2 adds atomic moves. No dependent rung starts implementation until its prerequisite is deployed and the journey passes. Read-only risk discovery can proceed earlier.

## The first release owns the minimum durable state

Rung 1 owns the existing native session/store/outbox and cloud commit seam through one implementation worker. Start with the versioned Overflow state needed for its promise. Define migration, supported old-client writes, conflict checks, rollback/forward-fix and document/account cleanup before changing the contract. Use a focused persistence proof within this rung, then deliver the actual panel; do not grow a general alternatives/ghost platform in advance.

Later rungs introduce complete source ranges using existing editor transactions or verified canonical patches. Quote/context matching may navigate a finding but must not guess replacement or deletion targets. New range code is justified by complete selections and metadata history; reuse canonical Markdown parsing and editor/persistence primitives.

Native UI composes existing panels, commands and decorations. Web UI composes shadcn primitives and semantic tokens. Selection actions and the command palette expose the tools. Hover previews supplement keyboard-accessible controls; normal caret and Vim behaviour remains intact outside an active comparison.

## AI passes reuse request recovery and leave proposals uncommitted

Extend the existing Convex AI lifecycle with narrowly typed operations and results. Include pass, scope, reduction target and writing-profile version in request identity. Validate the active-draft projection against the full stored source and writing-state revision. Current general review creates comments and a branch, so Lab preview needs a deliberate extension or separate action using that same lifecycle.

Encode the selected essay rules as a reviewed product profile, rather than reading a private skill directory at runtime. Never invent facts, anecdotes, quotations or personal experience. Opening and voice passes use whole-draft context when needed. Apply only exact, current spans. Surface dropped anchors, malformed responses, provider failures and uncertain outcomes; retry the original request identity. General-review behaviour continues to work.

## Current release evidence exposes work before new features

Read-only recovery on 2026-10-04 found no open Recto PRs. The latest listed Mac release is [v0.1.1](https://github.com/bhekanik/recto/releases/tag/v0.1.1), published 2026-09-27 with a Recto.dmg asset. This proves the release exists; it does not prove that the installed client or current main passes these new workflows.

At `origin/main` / `8de7737dcafba3ec6bff0e08474d697e001cc588`, `apple/scripts/release-mac.sh` archives, signs, notarises and publishes a DMG. No release-please configuration appeared in the tracked tree inspected at that SHA. Verify this again before publishing; do not infer credentials or target identity from the script. Run heavy steps through agent-work with four workers; ensure the release invocation's xcodebuild steps honour that limit.

[CI run 36322794155](https://github.com/bhekanik/recto/actions/runs/36322794155) on that same SHA is failing. Its logs show five Biome errors, a native main-actor isolation build error, Vim integration expectations failing, an auth lifecycle test failing and browser startup missing CLERK_JWT_ISSUER_DOMAIN. Core-JS and design-token jobs passed. These are observed failures, not a root-cause diagnosis. Runners did execute; historical billing notes do not explain this run. Diagnose and repair the relevant release gates first, with a minimal separate change where needed. Do not repeatedly rerun unchanged failures or alter billing/account settings.

## Workers report exact candidates and reviews gate each release

The runtime session metadata reports `gpt-6.1-sol` at `high`; the configured default is `gpt-6.1-sol`, and the host offers `ultra`. BK explicitly instructed this run to use the selected model, overriding the skill's highest-effort gate. Keep workers on the inherited selected model. Worker routing is resolved from the host's live model list, normally the configured default at high unless a distinct next tier is selected by that policy. BK also noted Claude is unavailable. This run proceeds without cross-provider verification under that instruction; report that limitation and never label a same-provider review as independent cross-provider verification.

Use durable isolated worker worktrees under the user's code directory, created from a fresh remote base. Preserve this parked local main and its untracked plan. One worker owns the first release's persistence integration; keep one concurrency slot free for review. Do not split UI and storage into unrelated horizontal worker deliverables.

Each brief includes the promise/demo, scope, pinned base, exact file pointers, owned/shared seams, ledger facts, acceptance, deploy target and budgets. Require inline typescript-reviewer for changed JS/TS and code-simplifier for the touched implementation, plus the applicable adversarial race/recovery checks. Workers do not push, merge or deploy unless assigned that specific authority. Reports include base/head/tree/merge-base, cleanliness, checks, review results, failures, learnings and risks.

The orchestrator is the sole writer of the shared ledger at `/Users/bhekanik/code/bhekanik/.orchestrate/recto-writing-20261004/`. Send relevant deltas rather than full histories. Review the complete candidate in a clean separate checkout, then obtain an independent cross-provider whole-diff review. With BK's no-Claude instruction, use orchestrator review and a separate read-only same-model review on the same exact SHA, clearly labelled; do not claim the waived cross-provider gate ran. Blockers are concrete contradictions, data loss/duplication, a journey/check that cannot pass or a security/privacy leak; triage other findings without endless review rounds.

Before merge, fetch again, verify PR head/base/file list and the merge tree, and rerun checks invalidated by a moved base. After merge, record remote main's SHA/tree and prove tree equivalence after squash. Deploy from that clean merged commit, record the previous known-good release and rollback/forward-fix path, install/launch the real client, run the promised journey and inspect available crash/error signals. A build or HTTP 200 alone never makes the rung done.

| Long step | Initial budget | Response when exceeded |
|---|---|---|
| Worker round | 45 minutes | Inspect timestamps and slow calls; narrow the promise or diagnose the wait. |
| Snapshot/build | 3 minutes | Measure queue time separately from build time and record the cause. |
| Checkpoint evaluation | 5 minutes | Use an immutable candidate and independent execution; keep useful work moving. |
| Cross-provider review | 20 minutes | Record model/session, elapsed time and exact dependency; do not substitute the same provider. |
| Release gate | 15 minutes | Profile signing, notarisation, build or smoke; diagnose before retrying. |

At each close, record phase durations and the largest wait. Use planned/building/reviewed/verified/integrated/deployed/done precisely. A released prerequisite whose demo fails remains incomplete and blocks dependent implementation.

## Validation follows the changed behaviour

- Pure tests: UTF-16 range mapping, complete long selections, repeated quotes, nested Markdown, formatting boundaries, detached/overlapping spans, article adjustments and exact cut projections. Extend Markdown corpus cases where projection changes parsing or serialisation.
- Persistence tests: metadata-only history, branches, versions, migrations, interrupted local writes, outbox retries, conflicts, older-client compatibility, document/account cleanup and blob retention for saved material.
- UI/integration tests: keyboard and Vim behaviour, accessible indicators, composed decorations, mode changes, multiple views, no-source-change previews, selective apply and one-step undo.
- AI tests: malformed/duplicate results, fabricated quotes, stale source/revisions, cancelled runs, document/account switches, uncertain outcomes, consent/access restrictions and request replay.
- Gates for relevant slices: `bun run typecheck`, `bun run biome`, `bun run test`, `bun run build`, the relevant `bun run test:e2e` cases, and `bun run core:parity` when the shared bundle changes. Native package tests for touched packages and the macOS app suite; copy JS bundles first with `apple/scripts/copy-js-bundles.sh`.
- Heavy commands run through `agent-work run -- …`; native builds use `xcodebuild -jobs 4` and an isolated derived-data path. Check current CI availability when executing; historical billing notes are not a current diagnosis.
- Browser verification uses agent-browser, including console/network evidence; open the real web preview in Dia. Native verification drives the actual macOS app. No simulated UI counts as the completion demo.

Each slice records its outcome, evidence, remaining problems and exact next action in this plan. Update the existing plan index when execution starts, and use documentation-refiner closeout after implementation. BK's subsequent acceptance authorises the declared execution and release sequence, while account/billing/credential-setting changes remain outside that authority.

## Overflow 0.1.2 passes online and relaunch checks; offline remains

[Recto for Mac 0.1.2](https://github.com/bhekanik/recto/releases/tag/v0.1.2) was published on 2026-10-04 at 23:20 UTC from merged `origin/main` / `372ff16dfb475e8ae7b9945ee060c51571afb199`, tree `4e3fa3eef767bfa6f2f1f04920f7d8cfe6d7dece`. [PR 66](https://github.com/bhekanik/recto/pull/66) repairs the measured baseline gates; [PR 67](https://github.com/bhekanik/recto/pull/67) adds Overflow. Both merged normally, with reviewed merge trees and no force push or administrative bypass.

The first promise covers typed or pasted notes, immediate local persistence, focused note undo and separate conflict-aware sync. Notes remain available through prose history navigation. Atomic prose-and-notes stash/restore belongs to rung 2. Read [the Overflow guide](../docs/how-to/keep-notes-in-overflow.md) for the shipped controls and storage-refusal behavior.

Root and separate fresh read-only same-model reviews found no blocker. Claude was unavailable under BK's instruction; cross-provider verification was waived and is not claimed. Hosted native checks pass: 292 tests in 46 suites, plus Debug and unsigned Release archive/configuration/arm64 validation. Final Linux CI passes typechecking, formatting, 1,219 Vitest tests, four Bun tests and the Webpack production build. The native verdict carries to the final head through recorded source equivalence; the last change only selects the supported Webpack build and records the unresolved Turbopack font-parser trigger. Authenticated browser CI remains blocked by its documented configuration gap. The failed Vercel preview is separate from the successful production deployment.

Convex functions deployed successfully to the existing production backend `https://careful-capybara-416.convex.cloud`; schema validation passed and no indexes were deleted. Vercel production `dpl_6PxEdYNMYgPATuyQUWQca6RXbWA3` is READY at the same source SHA on `https://recto-dusky.vercel.app`; home and login return HTTP 200. Authenticated web workflows were not verified, and web Overflow remains a later increment.

The signed app and DMG were accepted by Apple, stapled and published. The installed DMG SHA-256 matches the GitHub asset: `0ea32bd1ca6cbc3e8700d8615dc45fee8269ed22113fb00ba45a8177d8ecf9bf`. The 0.1.2 installation reported version 0.1.2, build 516 and minimum macOS 26.2, with the existing production configuration. The first launch required local Keychain access for `com.bhekani.recto`, then opened the signed-in library. A later relaunch required another local password entry; the installed app reopened successfully on 2026-10-05. No credentials were changed or copied.

The sandbox database migrated from v8 to v9 and retained all six existing drafts. A separate release-check draft makes seven records. Installed checks prove immediate durable note edits, independent note undo/redo, production sync at revision 3 with generation 6 fully acknowledged, preserved notes during prose undo/redo, panel reopen, and clipboard transfer back into synced prose while retaining the notes. These checks used public macOS Accessibility edits and controls; injected mouse/keyboard input and default menu commands did not operate reliably, so ordinary keyboard shortcuts are not claimed verified. The uncertain input path and OS gesture diagnostics are recorded in `docs/issues/native-smoke-injected-input.md`. No direct database or backend writes were used for the smoke. Its actual location is `~/Library/Containers/com.bhekani.recto/Data/Library/Application Support/Recto/recto.sqlite`. Migration v9 requires a forward fix if a problem occurs: preserve the database rather than assuming an older binary can reopen it. A stale recovered-subscription status warning remains a recorded nonblocking issue.

Full relaunch was verified on 2026-10-05 against the installed signed 0.1.2 app: the same release-check draft and Overflow notes reopened intact, with revision 3 and generation 6 fully acknowledged. The Keychain blocker is cleared.

## Overflow 0.1.3 inserts selected notes at the drop position

[PR 70](https://github.com/bhekanik/recto/pull/70) merged normally at `origin/main` / `6cf35b54cc8f904c614dd4548cb54df3b78758a7`, tree `4bd196b6fa1b6631835457074857ee50d0093436`. [Recto for Mac 0.1.3](https://github.com/bhekanik/recto/releases/tag/v0.1.3) was published on 2026-10-05 at 15:57 UTC and installed as build 522. Its signed, notarised, stapled DMG matches the published SHA-256 `b3950cb5fb3263ddbab44a27d7ad144e593c0a9b30b7a083f123d111af5c32a3`. Production configuration and minimum macOS 26.2 are verified.

The actual installed check selected 83 UTF-16 characters in Overflow, held for 800 ms and dragged them to UTF-16 position 36 in the Raw editor, away from its previous caret at 173. The result was the exact insertion, with the source notes unchanged. Draft Undo removed only the insertion; Redo restored it. A final Undo returned the test draft to its original text, and both prose and notes synced. No direct database or backend writes were used. Rich and Vim placement, Preview refusal and adjacent-typing history boundaries pass mounted native tests; those modes were not driven in the installed pointer check.

Core 81, Store 55 and Sync 73 tests pass, along with 20 native Overflow and ordered-edit tests. Root and separate same-model review passed the exact candidate `9cc9f944b10974634db1210430045280f0c4968e`; its tree equals the merged release. Clean CI passes the Mac Debug suite and Release archive, Apple packages, editor, Core JS, tokens and web checks. The local full native run had three reading-width failures reproduced on unchanged main and an intermittent focus-blur assertion; no assertions were weakened. The existing non-blocking browser job stopped before server startup because `CLERK_JWT_ISSUER_DOMAIN` was unset. No browser assertions ran.

Rapid typing around a structural insertion needs an accepted FIFO identity separate from the mutable durable-draft revision. The correction preserves queued edits, invalidates pre-navigation input and retains the newest acknowledged draft until pending history receipts drain. The next atomic stash/restore contract must preserve these safeguards and the existing independent notes undo promise.

Next action: obtain the pending approval, then run the prepared bounded offline edit/reopen/reconnect check on the existing test draft and verify its production acknowledgement. The script rechecks active interfaces and restores their previous state in cleanup and through an independent watchdog. No network change has been made. A per-process sandbox alternative failed before app startup; it did not prove offline behavior. Until the actual check passes, rung 1 is deployed, not done, and dependent implementation remains gated by the invoked orchestrate skill. Atomic stash/restore is next; drag delivery does not complete the full feature set.

The 0.1.3 signing, notarisation and publication took 3 minutes 57 seconds, with negligible queue wait. Its clean CI Mac Debug tests took 5 minutes 29 seconds and the cold Release archive about 7 minutes.

For 0.1.2, the release archive/export took about 2 minutes 27 seconds; the full signing, notarisation and publication took 3 minutes 40 seconds. Cold hosted native archives took about 7–8 minutes. Native input diagnosis added about 11 minutes to the installed check; a bounded Accessibility path allowed the online checks to finish. Source-equivalence checks avoided repeating native gates after the web-only build flag.

Durable evidence, exact next actions and the selected-model waiver are retained in `/Users/bhekanik/code/bhekanik/.orchestrate/recto-writing-20261004/handover.md`. The parked main checkout remains untouched apart from this agent-owned plan.

## Unresolved questions

1. May the prepared check briefly disconnect and restore this Mac's active Ethernet/Wi-Fi connections? System changes outside the repository require approval; none has been received.

2. Should ghosted text be omitted from reader-facing preview/copy/export? Recommended: yes, with source view/copy retaining it. This decision is needed before the Ghost increment.
3. How should writing metadata travel with plain `.md` files? Library drafts are the accepted initial scope; portability must be decided before file support is advertised.
4. Which existing dedicated CI deployment and credentials should own authenticated browser tests? The latest browser CI job cannot start its server with the current authentication configuration. This does not justify creating credentials or changing account settings implicitly.
