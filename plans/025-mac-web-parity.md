# 025 — Mac app: web feature parity

## Status

DONE (2026-09-24): every web action has a Mac twin (63 of 63; `open-in-mac-app`
is the web's, `open-in-web` the Mac's). PRs #37–#45, fix #46; engine PRs
bhekanik/swift-markdown-engine #8–#10 (pin `c528eb6`). Supersedes the N6/N7 feature scope of plan 023 for
the macOS app; iPad/iPhone (N8/N9) and App Store release (N10) are out of scope.

Baseline: `main` `e161f7f`. The Mac palette carries 20 of the web's 63 actions
(`lib/keyboard/actions.ts` vs `apple/RectoApp/Sources/CommandRegistry.swift`).
Done means every web action that makes sense on a Mac is in `CommandRegistry`
with the web's id and label, carried out natively, and tested.

Not ported: `open-in-mac-app` (web-only; the Mac's twin is `open-in-web`).

## Constraints found while planning

- The backend already has every function needed (versions, shares, comments,
  branches, AI transform/review/embed, credentials, consent, `export.docx`,
  `writingStats`). This is client work only; no Convex changes are planned.
- `RectoCoreJS` already exposes `lint`, `parseOutline`, `htmlFromMarkdown`,
  `markdownFromHtml` and `streak`.
- Local gates need `./apple/scripts/copy-js-bundles.sh` first: the JS bundles
  are gitignored, and without them 38 Vim tests fail with `isAttached == false`.
- GitHub Actions cannot start jobs (billing). Gates are local: `xcodebuild test`
  for the app, `swift test` for touched packages, and the web suite when shared
  JS changes.

## Work packages (one PR each, in order)

| # | Package | Actions | Notes |
|---|---|---|---|
| P0 | Foundation | — | Generic Convex call surface on `ConvexTransport`; document context (convex id, API) reachable from an editor host; fix the flaky `selection chrome follows its owning window lifecycle` assertion |
| P1 | Modes and look | `mode-preview`, `cycle-next`, `cycle-prev`, `theme-aurora`, `theme-dawn`, `theme-moonlit`, `toggle-font`, `toggle-focus` | Theme is orthogonal to appearance (web ADR-20): dark palettes apply only while dark; light is always Paper. Palettes from `packages/design-tokens/tokens.json` |
| P2 | Writing aids | `toggle-smart-paste`, `toggle-email-preview`, `set-goal`, `toggle-goal-style`, `toggle-goal-scope` | Goals: document or daily scope, ring or bar, at-least/about/at-most; daily uses `writingStats`; streak through `RectoCore.streak` |
| P3 | Navigate and export | `go-to-heading`, `toggle-outline`, `copy-rich`, `export-md`, `export-html`, `export-docx` | Outline via `RectoCore.parseOutline`; HTML via `htmlFromMarkdown`; DOCX via the `export.docx` action (signed-in) |
| P4 | Editor decorations | `toggle-focus-dim`, `cycle-dim-scope`, `toggle-lint-passive`, `toggle-lint-readability`, `toggle-lint-adverb`, `toggle-lint-weasel` | Plan 024 C3: display-only source-range decorations in RectoEditor; lint through `RectoCore.lint` off the main thread |
| P5 | Panes | `split-v`, `split-h`, `close-pane`, `focus-next`, `focus-prev` | Same document in a second editor = second controller synced through `DocumentSession` (plan 023 §0b) |
| P6 | History | `checkpoint`, `version-history`, `undo-tree` | Versions via `versions.*`; undo tree from the local node store |
| P7 | Review | `manage-sharing`, `toggle-comments`, `add-comment`, `review-surface` | Comment highlights use P4's decoration input; anchors relocate with the web's quote/prefix/suffix rules |
| P8 | AI | `toggle-ai`, `toggle-transform-mode`, `ai-transform`, `ai-critique`, `ai-related`, `ai-reindex` | Consent + BYOK (paste; OpenRouter PKCE); transform checks shared with the web through `recto-core-js` |

Each package: failing tests first where the behaviour is testable, app suite
green three runs in a row, merged to `main`, then the signed app reinstalled to
`/Applications` (orchestration memory).

## Outcome

| # | PR | Notes |
|---|---|---|
| P0 | #37 | `RectoAPI`; flaky selection-chrome test fixed |
| P1 | #38 | Figtree bundled; preview never stored as the default lens |
| P3 | #39 | Pi GLM draft, reworked (outline placement, `export:docx`, sync before DOCX) |
| P2 | #40 | Pi GLM draft, reworked (engine paste flag, stats off the status bar, cross-device days) |
| P4 | #41 | Engine #9 (fragment dimming), #10 (underlines; TextKit 2 ignores underline rendering attributes) |
| P5 | #42 | One model per document per window, mirror storages |
| P6 | #43 | Session `historyNodes`/`markdown(at:)`; auto versions; ⌘S after Save |
| P7 | #44 | `CommentAnchor` port; share, comments, review surface |
| P8 | #45 | Session origin override (`ai:<label>`); core `transformWarnings` + `chunk` |

Gates were local throughout (GitHub Actions cannot start jobs). App suite 239.

## Not done

- The reviewer side of review: opening a document someone shared with you
  (`review:listSharedWithMe`, `getReviewerDocument`, `reviewerAppend`). No palette
  action names it, so it was outside this plan.
- Removing a saved OpenRouter key or revoking AI consent from the Mac (the server
  functions are registered; there is no UI yet).
- On-screen checks of the synced-only features (P5–P8): they need a signed-in
  library. Their logic is covered by tests against the in-memory backend and a
  scripted API; P1–P4 were checked on screen through Codex computer-use.

## Unresolved

- Panes on file (non-synced) documents: second view over the same
  `FileDocument`, or cloud documents only? Default: cloud documents only.
