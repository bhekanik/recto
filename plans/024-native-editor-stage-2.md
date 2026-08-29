# 024: Native editor stage 2

## Status

IN PROGRESS. Branch: `codex/024-editor-engine-2`.

Baseline: `origin/main` at `ce5bfb5b809ffacf187112187d32f0a816fb1752`
on 2026-08-28. Engine fork pin:
`9435fed639363278033725bc6199c75415d3245c`.

This is N5/W9b from plan 023. It blocks the Mac alpha (N6/W12).

## Progress — 2026-08-28

- A1 complete in the local engine fork: attachment and selection callbacks now
  follow controller swaps (`8e48172`).
- A2 projection complete locally: rich/preview visible text and reversible
  UTF-16 span mapping cover the engine golden corpus and all 24 Recto corpus
  files (`7bbd92a`). Find and VoiceOver integration remain A4/A5 work.
- A3 complete in the local engine fork: TextKit 2 fragment scrolling replaces
  AppKit's unsafe range-scroll path (`2f8c8d3`).
- A4 complete locally: AppKit's standard incremental Find bar searches the
  visible projection, maps selections and scrolling back to source, and batches
  replace operations through the editor patch path. Vim inherits raw semantics
  when B3 adds that presentation.
- A5 complete locally: typewriter scrolling plus projected VoiceOver text,
  Markdown attributes and heading/list/link/image/footnote rotors. Manual
  VoiceOver validation remains part of the W12 app-window gate.
- Verification: engine 453 tests in 74 suites; RectoEditor 94 tests in 16
  suites. Both passed. Hosted CI remains blocked by GitHub Actions billing.
- The four engine commits are not pushed, so RectoEditor still pins
  `9435fed`. Push and pin update require explicit authorization.

## Outcome

Finish the macOS editor engine without replacing the stage-1 architecture:

- four presentations: rich, raw, vim and preview;
- safe typewriter scrolling and focus dim;
- visible-text Find and VoiceOver structure;
- native slash and selection command surfaces;
- syntax-highlighted code, image captions/upload, footnote interaction;
- comment and lint decorations;
- Recto undo-tree and Vim integration;
- corpus, accessibility and 10k-word performance gates.

## What already exists

Do not rebuild these:

- one `RectoTextStorage` and engine controller per editor presentation;
- canonical Markdown remains the only document model;
- scalar-safe UTF-16 `applyPatch`, `applyPatches`, `applyText`;
- external undo policy and exact `onEdit` mutation feed;
- rich/raw/preview rendering and caret reveal;
- headings, emphasis, links, lists, tasks, quotes, code backgrounds, tables,
  frontmatter header, footnotes and image syntax styling;
- rich HTML → Markdown paste, raw/private-flavour verbatim paste;
- Writing Tools session reconciliation;
- system spell/grammar, copy and link interaction;
- 24-case corpus snapshots and window-backed fragment tests;
- `RectoVim`, `RectoCore`, `RectoCoreJS`, `RectoHistory` and `RectoDesign`
  packages from W8/W10/W2.

Current source of truth:
`apple/Packages/RectoEditor` plus the pinned fork, not plan 023's stale table
overlay or rendering-attributes wording.

## Decisions

1. **Keep one presentation per controller/storage.** A second presentation is
   a second `RectoTextStorage`, synchronized by `DocumentSession` patches.
   TextKit 2 rendering attributes do not affect layout, so they cannot collapse
   marker advance. Do not add a parallel display string or AST document.
2. **Fix stage-1 debts before feature UI.** Attachment handoff, outgoing
   selection callbacks, scroll safety and source↔visible mapping are shared
   dependencies. New popovers wait for them.
3. **Use system text affordances.** `NSTextView` owns Find, Writing Tools,
   spelling, dictation, Speak, Look Up and Services. Do not build a custom text
   engine or custom Find UI.
4. **Find searches what the reader sees.** Rich/preview exclude collapsed
   frontmatter, hidden marker-only text and hidden link/image destinations.
   Raw/vim search the file. A tested source↔visible projection maps results back
   to source UTF-16 ranges.
5. **Never call `layoutManager` or `scrollRangeToVisible`.** Both cross the
   TextKit 1 compatibility boundary or hit the known large-document crash path.
   Scroll via TextKit 2 fragments and the clip view.
6. **Recto owns history.** Editor UI emits intent and patches; the host supplies
   undo/redo through small protocols. `RectoEditor` does not import persistence,
   Convex or app-shell state.
7. **Reuse existing packages and web contracts.** The Vim engine, 17 slash
   entries, anchor relocation, lint payloads, image upload result and history
   semantics already exist. Port contracts; do not invent variants.
8. **No tracking change.** The deferred −0.015 em value remains unapplied until
   a separate visual decision; it changes table and list measurements.

## Slice A: text-system foundation

Fix the shared editor foundation first.

### A1. Attachment lifecycle

- Make attach/detach callbacks identity-bound so a stale teardown cannot clear
  the newly attached view.
- Prevent selection callbacks during controller transfer from reaching the
  outgoing document closure.
- Add window-backed A→B→A remount and same-turn replacement regressions.

### A2. Visible-text projection

- Add an engine-produced immutable projection for the current presentation:
  visible string, source range per visible span and visible range per source
  span.
- Preserve scalar and grapheme boundaries. Ranges remain UTF-16.
- Rich/preview omit hidden syntax and collapsed blocks. Raw returns identity.
- Use it for Find and VoiceOver. Later slices reuse it for popover labels and
  decoration hit-testing.
- Gate all 24 corpus cases with source→visible→source round trips.

### A3. Safe fragment scrolling

- Add one engine-level fragment-scroll operation. It lays out only the target
  range, reads `NSTextLayoutFragment` geometry, scrolls the clip view and
  settles at most three passes through `layoutViewport()`.
- Override the editor's range-scroll entry point so AppKit callers cannot enter
  the unsafe default path.
- Preserve horizontal position, header offset, reading-column offset and
  overscroll clamp.

### A4. System Find

- Install one `NSTextFinder` per attached editor, using the scroll view as
  `NSTextFinderBarContainer`.
- Forward standard `performTextFinderAction(_:)` responder actions; enable
  incremental search.
- Back rich/preview with the projection client; raw/vim can use the text view's
  identity representation.
- Replace operations map through source ranges and land through the normal
  editor edit path as one Recto history boundary.
- Search and replace must not expose frontmatter or hidden URLs in rich/preview.

### A5. Typewriter and accessibility

- `RectoTypewriterController` observes selection/text/viewport changes only
  while enabled and attached.
- Center the caret line at 50% of the visible height using A3; reserve last-line
  room with `textContainerInset`, not `contentInsets`.
- Disable during marked-text composition, drag selection and programmatic
  history/sync application; re-center once after completion.
- Expose heading/list/link/image/footnote structure and visible text to
  VoiceOver without changing storage.

Acceptance:

- no TextKit 1 compatibility notification;
- Find/replace works in all four presentation semantics;
- 10k-word top/middle/bottom typewriter cases settle within three passes;
- stale attach/selection callbacks cannot target the wrong document;
- VoiceOver projection matches the visible corpus.

## Slice B: commands, Vim and history

### B1. Formatting command API

- Replace notification-name plumbing at the Recto boundary with typed
  `RectoEditorCommand` values: bold, italic, strike, inline code, headings,
  lists, task, quote, fence, divider, table, link, image and footnote.
- Commands operate through the engine edit path and mark one structural history
  boundary. Link/image commands accept host-provided values.
- Publish typed selection state for format-bar enablement.

### B2. Slash menu and selection bar models

- Port the authoritative 17 entries from
  `lib/editor/milkdown/slash-entries.ts`; add a parity fixture so labels,
  aliases and insertion semantics cannot drift.
- `RectoEditor` owns command/filter/anchor models. W12 owns `NSPopover` and
  `NSPanel` chrome so the editor package stays shell-neutral.
- Trigger slash only at a source line's command position; Esc/arrow/Return are
  fully keyboard-driven.

### B3. Vim presentation

- Add `.vim` as raw rendering plus `RectoVim` key interception.
- Use the existing block/bar/visual caret shapes and status payload.
- Route wrapped-line geometry through TextKit 2 fragments.
- Adopt external text through `VimEngine.adoptText`; never rebuild JS state per
  key or assign `NSTextView.string`.

### B4. Undo tree

- Define a host `RectoEditorHistory` protocol returning the post-navigation
  markdown and Vim-shaped caret.
- Reader edits from `onEdit` are grouped by the host; commands/paste/AI/history
  form structural boundaries.
- ⌘Z/⇧⌘Z and Vim `u`/`Ctrl-r` call the same provider. Apply returned changes
  through `applyPatch`/`applyText` with undo registration off.
- One round-trip suite drives typing → command → paste → Vim → undo/redo across
  emoji, combining marks and branches.

Acceptance: the existing 100-command Vim fixture runs through the real
`RectoTextView`; undo/redo parity matches web fixtures; no AppKit undo entry is
created.

## Slice C: rich blocks and decorations

### C1. Code blocks

- Use the engine's recommended HighlighterSwift bridge unless its dependency or
  output conflicts with Recto's theme contract; no custom tokenizer.
- Theme light/dark token colours and invalidate appearance caches.
- Expose the parsed language and fragment anchor for W12's top-right language
  tag/copy control.

### C2. Images and footnotes

- Render standard Markdown images with an `NSTextAttachmentViewProvider` over
  the source range, capped to the reading column; alt text is the caption and
  accessibility label.
- Inject image loading/upload protocols. Paste/drop uploads first, then inserts
  `![alt](url)` through one structural edit. Failure inserts nothing.
- Keep private Markdown paste lossless and ahead of image/HTML branches.
- Footnote activation publishes id, definition and caret anchor for a W12
  popover; orphan references remain literal.

### C3. Focus dim, comments and lint

- Implement focus dim in the fragment rendering surface/layer, not text-storage
  attributes; cached table/image surfaces must dim with their fragment.
- Paragraph and sentence scopes follow web semantics. Selection and active
  composition stay fully opaque.
- Add display-only source-range decoration inputs for lint and comments.
- Overlaps compose deterministically; neither modifies Markdown, copy output,
  Find results or Writing Tools input.
- Comment anchors relocate through the existing quote/prefix/suffix rules before
  ranges reach the editor.

Acceptance: screenshot fixtures cover Twilight/Paper, active/inactive blocks,
tables/images, focus scopes and overlapping decorations; hit tests return source
ranges.

## Slice D: N5 gate

Run on the macOS 26.5 SDK / Xcode 26.6 baseline and CI `macos-26`:

```sh
swift build --package-path apple/Packages/RectoEditor
swift test --package-path apple/Packages/RectoEditor
swift test --package-path apple/Packages/RectoVim
RECTO_RUN_PERF=1 swift test --package-path apple/Packages/RectoEditor -c release --filter Perf
```

Required evidence:

- RectoEditor and fork build with zero warnings under the CI gate;
- every window-backed suite passes three consecutive runs;
- corpus rich/source visible snapshots and accessibility projection match;
- 10k-word typing p50 < 8 ms, reveal < 16 ms, viewport work stays within a
  16.67 ms frame on the reference M3 Max;
- no retained attachment observers, Find clients, timers or notification
  tokens after teardown;
- Writing Tools accepts one change, emits one scalar-safe mutation and does not
  absorb a concurrent external patch;
- manual VoiceOver, Full Keyboard Access and visual pass in the first W12 app
  window before W9b is marked complete.

GitHub Actions billing currently prevents hosted jobs from starting. Until that
is fixed, record the exact local commands and counts; do not call blocked CI
green.

## Files and ownership

| Area | Owner |
|---|---|
| Engine parser/layout/projection/fragment/scroll fixes | `bhekanik/swift-markdown-engine` fork, pinned revision update here |
| Recto behavior models, typed commands, protocols, theme | `apple/Packages/RectoEditor` |
| Vim engine/adapters | reuse `apple/Packages/RectoVim`; edit only for a proven adapter gap |
| History/session implementation | W12 composes `RectoCore.DocumentSession`; editor sees a protocol |
| Popover/panel/status-bar chrome | W12 Mac app, not this package |
| Upload/network/persistence | host protocols; no Convex import in RectoEditor |

## STOP conditions

- Any approach needs a second editable display string or AST-canonical model.
- Any code touches `NSTextView.layoutManager`, `NSTextContainer.layoutManager`
  or calls `scrollRangeToVisible`.
- Source↔visible mapping cannot round-trip every corpus case.
- A proposed marker-hiding change alters persisted Markdown or copy output.
- Typewriter still needs more than three settle passes on the 10k-word fixture.
- A new dependency duplicates `RectoVim`, `RectoCoreJS`, AppKit or an existing
  engine feature.
- A feature cannot be tested without the W12 shell: expose the protocol/model,
  defer the chrome, and continue with independently testable work.

## References

- Apple: [NSTextFinder](https://developer.apple.com/documentation/appkit/nstextfinder),
  [NSTextView](https://developer.apple.com/documentation/appkit/nstextview),
  [NSTextLayoutManager.ensureLayout](https://developer.apple.com/documentation/appkit/nstextlayoutmanager/ensurelayout(for:)-3duae),
  [NSTextViewportLayoutController](https://developer.apple.com/documentation/appkit/nstextviewportlayoutcontroller),
  [Writing Tools](https://developer.apple.com/documentation/appkit/customizing-writing-tools-behavior-for-system-views).
- Engine fork pin: `9435fed639363278033725bc6199c75415d3245c`.
- Prior review record: Recto PR #9 and fork PR #1.
- Program/design: plans 023, §1.3 / §4.2 / orchestration learnings.

## Unresolved questions

None before Slice A. Later shell-only visual choices belong to W12.
