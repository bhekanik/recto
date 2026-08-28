# Plan 023: Native Swift/SwiftUI Recto for macOS, iPadOS and iPhone (App Store), with AI moved to Convex (BYOK, metering, LangSmith)

> **Executor instructions**: This is a program-level plan. It is cut into
> milestones N0–N10; each milestone becomes its own numbered plan (024+) when
> it is started, written in the usual self-contained format. Do not start a
> milestone before its predecessor's acceptance criteria hold. When a
> milestone plan lands, add its row to `plans/README.md` and link it here.
> Design companion: `plans/023-native-apple-apps-design.md`.
>
> **Drift check (run first)**:
> ```
> git diff --stat 7b09172..HEAD -- convex/schema.ts convex/documents.ts convex/review.ts \
>   convex/embeddings.ts convex/auth.config.ts lib/markdown lib/history lib/sync lib/ai \
>   lib/lint lib/outline lib/studio/use-studio-settings.ts app/api/ai app/globals.css
> ```
> If any in-scope file changed since this plan was written, compare the
> "Current state" section below against the live code before proceeding; on a
> material mismatch, STOP and re-plan the affected milestone.

## Status

- **Priority**: P1 (product direction; Mac becomes the primary writing surface)
- **Effort**: XL (≈50–64 engineer-weeks; see §9)
- **Risk**: HIGH (new platform, custom TextKit 2 editor, 0.x SDKs, App Review)
- **Depends on**: 022 (must be fixed before any history code is ported)
- **Category**: feature (direction)
- **Planned at**: commit `7b09172`, 2026-08-27
- **Inputs**: three codebase sweeps, five web-research sweeps (Apple platform
  state, stack options, App Store rules, AI infra, native text stack), an
  independent plan from Codex (gpt-5.6-sol, xhigh), and BK's decisions of
  2026-08-27 (fully native, public listing, AI + review in v1, BYOK or pay).

## Why this matters

BK does most writing on a Mac and wants a first-class native app there, plus
iPad/iPhone apps on the App Store. The web app is feature-complete for v1 but
is desktop-web, dark-only, and keeps every preference in `localStorage`. A
public App Store listing also changes the product: strangers can sign up, so
account deletion, privacy disclosures, AI consent, comment moderation and
per-user AI cost control stop being optional.

## Decisions

| # | Decision | Why |
|---|---|---|
| D-N1 | **Fully native Swift + SwiftUI** apps (AppKit/UIKit text views under SwiftUI; no Catalyst; no WKWebView for editing). The editor is a TextKit 2 "hybrid" editor: **the Markdown string is the document**, TextKit styles it in place and hides syntax markers (Bear / iA Writer / Ulysses model). Rich, Raw and Vim are three presentations of one `NSTextContentStorage`; Preview is the rich presentation with editing off and every marker hidden. | BK's direction (2026-08-27). The string-is-the-document model is lossless by construction (nothing is re-serialized on the device) and makes the live rich↔raw bridge free: two views over one storage. Cost: the editor engine is the bulk of the program (§9). |
| D-N2 | Native owns data. `clerk-ios` + `convex-swift`, GRDB SQLite mirror, ordered mutation outbox, one `DocumentSession` actor per open document. | Offline, widgets, Spotlight, share extension and crash recovery need data outside the UI layer; the Convex WebSocket drops on suspend. |
| D-N3 | **Shared JS core in JavaScriptCore.** The pure, DOM-free parts of `lib/` that must match the web byte-for-byte run as a bundled script (`packages/recto-core-js`) inside `JSContext`: canonical parse/normalize/stringify (`lib/markdown`), word count, outline, smart paste (HTML→Markdown), prose lint, HTML export. The vim engine is `@replit/codemirror-vim`'s keymap core running in the same `JSContext` behind a Swift-implemented adapter (spike, §1.4). Nothing is downloaded (guideline 2.5.2 allows bundled JS). | One losslessness contract instead of two parsers drifting; vim fidelity without a rewrite; no WKWebView anywhere in the editing path. |
| D-N4 | Backend gets additive changes before native beta: atomic `documents.commitEdit`, `settings` table, per-device `workspaces`, account deletion, server-side `.docx` export, AI on Convex (D-N10). Plan 022 is fixed first. | Porting the current history path copies the P1 race into two more clients. |
| D-N5 | Light + dark. Twilight dark unchanged, new "Paper" light, appearance follows system with override; **on the web too** from the same token source. Other dark palettes get light twins later. Reverses D13 (ADR-20). | One designed light palette beats four undesigned ones; one design system. |
| D-N6 | Vim and desktop chords are gated on hardware-keyboard presence (`GCKeyboard`), not device class. | iPad + Magic Keyboard is a desktop; iPad on the sofa is not. |
| D-N7 | Mac App Store first (free app, universal purchase with iOS, sandbox is trivial for a Convex-only app). Developer ID + Sparkle only if a reason appears. | One channel to maintain in year one. |
| D-N8 | Native v1 scope = writing, history, versions, stats, focus modes, export, **review/comments/sharing, and AI**. Review ships with guideline 1.2 controls (report, block, filter, contact); AI ships with 5.1.2 consent. | BK wants parity; the cost/abuse concern is solved by D-N10. |
| D-N9 | Floors: **iOS/iPadOS 26, macOS 26**, arm64 only, Xcode 26 SDK now, Xcode 27 SDK when GA (mandatory ~April 2027). TextKit 2 only (never touch `layoutManager`). | Launch lands ~mid-2027 when 27 is current, so 26 is n-1; one code path (Liquid Glass, `WebPage`, no icon fallback). Decided by the orchestrator 2026-08-27 on BK's delegation. |
| D-N10 | AI moves from Next.js routes to Convex actions/HTTP actions. Keys never leave Convex. Credential resolution: user's BYOK (paste or OpenRouter OAuth PKCE, encrypted at rest) → house key only for owner-allowlisted accounts or paid entitlement holders. Non-owner house allowance is **zero**: BYOK or pay. Every call is metered into `aiUsage`, rate-limited with `@convex-dev/rate-limiter`, and traced to LangSmith with full inputs/outputs (for evals), disclosed in consent. | One backend for web and native; the house key was never exposed (server-side only), the risk was strangers' spend. Zero allowance removes it entirely. |
| D-N11 | App icon: Didone "R" whose leg terminal folds over as a page corner (recto = right-hand page), periwinkle accent, layered Icon Composer `.icon`. | Distinctive at every size; page-only icons read as Notes/Pages. Renders in the 2026-08-27 session scratchpad; rebuild as vectors. |
| D-N12 | Login: Google OAuth + email + Sign in with Apple + passkeys (Clerk). | BK's choice; Google forces SIWA under 4.8, and Clerk iOS does SIWA natively. |
| D-N13 | Public App Store listing. Paid AI access ("pay" path) is an `AI Pro` entitlement sold via StoreKit 2 on Apple platforms and Stripe on the web, reconciled into a Convex `entitlements` table; sequenced **after** launch (v1 ships BYOK-only). | 3.1.1 requires IAP for in-app unlocks; 3.1.3(b) allows honoring a web purchase only if the same tier is also sold via IAP. Ship writing first, add billing when there are users. |
| D-N14 | The web app keeps Milkdown + CodeMirror. Cross-client losslessness is guaranteed by the shared JS core (D-N3) and the corpus tests, not by a shared editor. | The web editor is proven; nothing in `lib/editor` or `lib/bridge` changes semantics. |

## Current state (evidence)

- Backend: 9 Convex tables (`convex/schema.ts`), Clerk via JWT template
  `convex` (`convex/auth.config.ts`), no HTTP actions, no users table, no
  webhooks, no account deletion, no settings table. `identity.subject` is the
  `userId` string everywhere.
- Web editor: four lenses (`lib/modes/types.ts`), Milkdown + one CodeMirror 6
  instance (vim via Compartment), preview. Live rich↔raw bridge in
  `lib/bridge/`. Vim `u`/`C-r` remapped to the model-level undo tree
  (`lib/editor/codemirror/index.tsx`). The only MDAST↔string crossing is
  `lib/markdown/` with `CANONICAL_STRINGIFY` (`stringify-options.ts`), gated
  by `lib/markdown/corpus.test.ts` (25 cases × 5 assertions).
- `@replit/codemirror-vim` 6.3.0: the vim core (~7,200 lines of
  `dist/index.js`) talks to a `CodeMirror` adapter class (~640 lines, ~60
  methods: `getCursor`, `getLine`, `replaceRange`, `listSelections`,
  `getSearchCursor`, `charCoords`, …); only 7 references to CodeMirror 6
  types exist in the whole bundle, all inside that adapter. Verified
  2026-08-27 from the bun cache.
- History: append-only DAG (`docNodes`), client ULIDs, contiguous text
  patches, snapshot every 50, `GroupingController`, pointer LWW on 1200 ms.
  Pure and portable: `lib/history/{patch,materialize,ulid,grouping}.ts`,
  `lib/stats/streak.ts`, `lib/outline/extract.ts`, `lib/history/diff.ts`
  (already duplicated in `convex/history.ts` with a parity test).
- DOM-free JS suitable for JavaScriptCore: `lib/markdown/*` (remark/unified,
  `count-words`, `from-html` uses rehype-parse, no DOM), `lib/lint/*` (retext,
  runs in a Worker today), `lib/outline/extract.ts`, `lib/export/html` render
  (`lib/preview/render.ts`), `lib/stats/streak.ts`. DOM-bound: `lib/editor`,
  `lib/bridge`, components.
- Sync: 500 ms debounced `documents.updateMarkdown` with `expectedUpdatedAt`
  stale guard (`lib/sync/use-document-sync.ts`), `localStorage` draft buffer,
  no offline queue. All 23 settings are device-local `localStorage`
  (`lib/studio/use-studio-settings.ts`).
- AI: three Next.js routes (`app/api/ai/{transform,review,embed}`) using the
  OpenAI SDK against OpenRouter with `OPENROUTER_API_KEY` from the Vercel env
  (`lib/ai/server.ts`), guarded by `lib/ai/route-guard.ts`. `runReviewLoop`
  (`lib/ai/review-loop.ts`) takes an injectable `ReviewChatClient`.
  `convex/embeddings.ts#reindexSweep` already calls OpenRouter from a Convex
  action with the Convex-side key. Model constants in `lib/ai/config.ts`.
- Review: `convex/review.ts` (shares, branches, comments, per-hunk accept
  server-authoritative). Comment anchors are quote/prefix/suffix/offsetHint.
- Design: dark-only (D13), four dark OKLCH palettes in `app/globals.css`
  (Twilight default: `--color-bg-app oklch(0.18 0.028 280)`, accent
  `oklch(0.74 0.13 288)`), Figtree / Source Serif 4 / JetBrains Mono, 43.5em
  measure, luminance elevation, film-grain atmosphere. No brand assets in the
  repo. `components/providers.tsx` themes Clerk with a stale coral palette.
- Native text stack (researched 2026-08-27): Apple `swift-markdown` 0.8.0
  has no footnotes/frontmatter/bare-autolinks and byte-column ranges with
  open inline-range bugs (#205, #183, #279); fine for nothing on the editing
  path. `nodes-app/swift-markdown-engine` (Apache-2.0, macOS 14+, AppKit,
  TextKit 2, 966★, active Aug 2026) is a hybrid marker-hiding editor with an
  incremental UTF-16-range parser, fragment-drawn bullets/checkboxes, overlay
  tables, attachment images. `I7T5/Edmund` (Apache-2.0) has a working TextKit 2
  typewriter-scroll implementation. `STTextView` is GPL/commercial. TextKit 2
  falls back to TextKit 1 when `NSTextTable` is used; iOS 27 adds
  `NSTextTable` to UIKit (TK2 behaviour unverified). No open-source Swift vim
  layer exists for text views; neovim cannot embed on iOS (no fork/exec).
- Open P1: plan 022.
- Blueprint says "no light theme" (D13) and "no mobile-native apps" (v1
  non-goals). Both reversed by this plan on purpose.

## 1. Architecture

### 1.1 Alternatives (recorded; BK chose full native)

| Option | Verdict |
|---|---|
| Native shell + WKWebView editor runtime (Raycast/Notion shape) | Rejected by BK 2026-08-27 after being the first draft's pick. Lower effort (~34–44 wks) but the prose canvas stays web. |
| Tauri 2 / Capacitor 8 / Expo `'use dom'` / Electron | Rejected: web chrome, open iOS keyboard bugs, no Apple-native feel, or no iOS path. |
| **Fully native, string-is-the-document hybrid TextKit 2 editor + JavaScriptCore core** | **Chosen.** Native feel everywhere, TextKit gives Writing Tools, dictation, Find, accessibility, Genmoji-free plain text for free; the JS core keeps parity with the web. |
| Fully native with a separate WYSIWYG document model (AST-canonical editor) | Rejected: reintroduces the round-trip problem ADR-01/02 exist to avoid, and needs a Swift serializer that matches `remark-stringify` exactly. |

### 1.2 Layers

```
SwiftUI app (windows, scenes, navigation, sheets, settings, commands)
  ├─ RectoEditor (AppKit NSTextView / UIKit UITextView subclasses, TextKit 2)
  │    ├─ RectoTextStorage: NSTextContentStorage holding the Markdown string
  │    ├─ MarkdownStyler: incremental block/inline parser → attribute ranges (UTF-16)
  │    ├─ Presentations: Rich (markers hidden, caret-reveal), Source (markers visible,
  │    │    highlighted), Vim (Source + modal layer), Preview (Rich, read-only)
  │    ├─ Blocks: fragment-drawn bullets/checkboxes/code backgrounds, overlay tables,
  │    │    image attachments (view providers), footnote popovers, frontmatter header
  │    └─ Behaviours: typewriter, focus dim, slash menu, format bar, find
  ├─ RectoVim: JSContext running codemirror-vim's core; Swift CodeMirror-adapter
  ├─ RectoCoreJS: JSContext running packages/recto-core-js (markdown, lint, outline,
  │    smart paste, word count, html render, streak)
  ├─ RectoHistory: Swift ports of patch/materialize/ulid/grouping/diff (+ fixtures)
  ├─ RectoStore (GRDB) · RectoSync (convex-swift, outbox, conflicts) · RectoAuth (ClerkKit)
  └─ RectoDesign (tokens, type, components) · RectoFeatures (library, palette, inspectors, AI, review)
```

### 1.3 The editor engine (RectoEditor)

- Base: evaluate forking `swift-markdown-engine` (Apache-2.0) for macOS in
  N0; keep its approach either way: markers stay in the string, inactive
  markers are shrunk to a tiny font size (not deleted), the active block
  reveals them; bullets, task boxes and code-block backgrounds are drawn in an
  `NSTextLayoutFragment` subclass; tables are overlay views positioned from
  fragment frames; images are `NSTextAttachmentViewProvider`s; caret
  workarounds live in one file. Port the styler and fragment drawing to
  UIKit for iOS (same TextKit 2 API surface; `UITextView` differences are
  selection, input accessory, keyboard geometry, and FB22523964 fragment
  view scale).
- The styler's parser exists only to compute attribute ranges; it is not
  the canonical parser. Correctness of what is persisted never depends on
  it. Canonical normalization (`serialize(parse(md))`) runs in RectoCoreJS on
  commit boundaries (mode switch, save version, export), and its result is
  applied as a text patch only when it differs (which the corpus guarantees
  is idempotent), so a native edit and a web edit of the same document
  produce the same string.
- Frontmatter (title, subtitle, newsletter subject/preview) renders as the
  document header, not YAML, in Rich and Preview; visible in Source/Vim.
- Preview = Rich presentation with `isEditable = false`, all markers hidden,
  caret hidden. Email preview (inbox card + rendered HTML) uses the JS core's
  HTML render inside a read-only `WKWebView` (display only; not the editor).
- Writing Tools, dictation, spell/grammar, Find (`NSTextFinder` /
  `UIFindInteraction`), Speak, Look Up, Services come free from the system
  text views; `writingToolsBehavior = .limited` so Apple Intelligence rewrites
  plain text without injecting attributes.
- Typewriter and focus dim: Edmund's `centerViewportOnCaret` pattern
  (`textLayoutFragment(for:)` + `ensureLayout` + settle passes) and
  `setRenderingAttributes(_:for:)` for dimming (no relayout).
- Tables: overlay views over an aligned monospace fallback in the string;
  editing cells edits the pipes. Re-evaluate native TK2 tables on the iOS 27
  SDK.

### 1.4 RectoVim (spike in N0)

- Bundle `@replit/codemirror-vim`'s vim core (built with Bun from the package
  source, without the CM6 adapter) into `recto-vim.js`. Implement the adapter
  interface in Swift (`RectoVimAdapter: JSExport`): line/char cursor model,
  `getLine`, `lineCount`, `getRange`, `replaceRange`, `listSelections`,
  `setSelections`, `getSearchCursor`, `charCoords`/`coordsChar`,
  `scrollIntoView`, `setOption`, `openDialog`/`openNotification` (ex line in
  the status bar), `on`/`off` change events.
- Key events: in the Vim presentation, `keyDown`/`pressesBegan` go to the JS
  keymap first; unhandled keys fall through to the text view. Mode changes
  drive the caret shape and the status bar (`-- INSERT --`, `-- VISUAL --`).
  `u`/`Ctrl-r` map to the undo tree, as on the web.
- Fallback if the spike fails (adapter cost or latency > 2 ms per key on an
  M-series iPad): native subset in Swift (motions, operators, text objects,
  visual, counts, registers, search, dot-repeat) using `pilyang/vim-action`'s
  engine as a reference. Estimated +4 weeks over the JS route.

### 1.5 RectoCoreJS

- `packages/recto-core-js`: a single IIFE bundle exposing
  `normalize(md)`, `parseOutline(md)`, `countWords(md)`, `htmlFromMarkdown(md)`,
  `markdownFromHtml(html)`, `lint(md, categories)`, `streak(days, today)`.
  Built with `bun build --target=browser` (no DOM APIs used); loaded once per
  process in a `JSContext` on a background queue. **Measured 2026-08-28 (W3):**
  ~9 ms per kB of Markdown per whole-document call in the system `JSContext`
  (927 kB → 9 s), so calls run off the main thread at document boundaries
  (open, paste, save, mode switch, export), not per keystroke; `countWords`,
  `parseOutline` and `streak` are ported to Swift with fixture parity for the
  per-keystroke paths. iOS in-process JavaScriptCore may lack a JIT for
  third-party apps: the N3 go/no-go is a device measurement (50 kB
  `normalize` < 1 s on an iPhone). Parity: the same fixture corpus the web runs.
- Not in JS: editing, rendering, history (Swift ports with fixtures), sync.

### 1.6 Auth flow

ClerkKit → `ConvexClientWithAuth(deploymentUrl:, authProvider:
ClerkConvexAuthProvider())` (`clerk-convex-swift` 0.1.0; inline it if it
lags). Verify in N0 that the token carries `aud: convex` matching the JWT
template; otherwise implement `AuthProvider` with
`clerk.auth.getToken(template: "convex")`. `convex/auth.config.ts` unchanged.

### 1.7 Fallback for convex-swift (decided at the end of N0)

If convex-swift blocks (no optimistic updates #19, no cache #20, auth-bridge
thread-safety #21/#26, macOS release build #10): `RectoSync` implements the
Convex WebSocket protocol directly (subscriptions + mutations, ~1.5k lines,
documented protocol) or uses HTTP `POST /api/query|mutation|action` with
polling for the few reactive lists. The SQLite mirror + outbox design does
not change.

## 2. Repository, build, CI, release

```
packages/recto-core-js/      entry.ts → dist/recto-core.js (bun build), fixtures runner
packages/recto-vim-js/       codemirror-vim core → dist/recto-vim.js
packages/design-tokens/      tokens.json → Style Dictionary → globals.css vars + Colors.xcassets + RectoTokens.swift
packages/editor-fixtures/    markdown corpus, history + diff fixtures, outline/word-count/lint parity JSON
apple/Recto.xcworkspace
apple/Apps/Recto-macOS, apple/Apps/Recto-iOS
apple/Packages/RectoCore, RectoStore (GRDB), RectoSync, RectoAuth, RectoEditor, RectoVim,
               RectoCoreJS, RectoHistory, RectoDesign, RectoFeatures
apple/Design/Recto.icon      Icon Composer source
```

- Web-side refactors: `lib/markdown`, `lib/lint`, `lib/outline`, `lib/stats`
  gain a DOM-free entry (`packages/recto-core-js/entry.ts` re-exports them);
  `lib/lint/use-prose-lint.ts` keeps its Worker. Settings move to Convex
  (§4.1) for the web too.
- Build gate: Xcode run-script copies `packages/*/dist/*.js` into
  `RectoCoreJS/Resources` and fails on a stale manifest hash. Bundle scan: no
  localhost, no source maps, no secrets.
- CI (GitHub Actions, `macos-26`): existing typecheck/biome/vitest/build +
  `core:build` + parity tests (JS and Swift on the same fixtures) + `swift
  test` + `xcodebuild test` (Mac, iPad Pro 13", iPhone 17 simulators) +
  editor snapshot tests (rich/source rendering of the corpus).
- Signing/TestFlight: Xcode Cloud (25 h/month free); post-clone installs
  pinned Bun and builds the JS bundles. Internal TestFlight from `main`,
  external from tags.
- Mac channel: MAS. Entitlements `app-sandbox`, `network.client`,
  `files.user-selected.read-write`. Direct build (Developer ID, hardened
  runtime, `notarytool`, Sparkle 2) documented as a later option.

## 3. Feature matrix and keyboard modes

| Capability | Mac | iPad + hardware keyboard | iPad touch | iPhone |
|---|---|---|---|---|
| Rich lens | primary | primary | primary | primary |
| Raw lens | full | full | in mode menu | under "More" |
| Vim lens | full | while keyboard attached | hidden (Advanced override) | hidden unless keyboard |
| Preview / email preview | full | full | full | full-screen |
| Command palette | floating panel ⌘K | ⌘K | sheet from toolbar | sheet |
| App chords | 62-action map via menus | `UIKeyCommand` + discoverability | none | when attached |
| Split panes | up to 4 in one window (same storage when same doc) | 2 in regular width | 2 regular / 1 compact | 1 |
| Multiple windows | `WindowGroup` per document | scenes, Stage Manager, external display | same | one scene |
| Typewriter | full | full | off while soft keyboard visible | same |
| Outline / history / versions / comments / review | trailing inspector | trailing inspector | sheet | sheet |
| Share + invite | native sheet | same | same | same |
| AI transform / review / related | inspector + inline pending replacement | same | sheet | sheet, selection or document |
| Export | save panel, Services, copy rich+plain | document picker + share sheet | same | share sheet |
| Handoff / Spotlight / Intents / Focus filter | yes | yes | yes | yes |
| Widgets | macOS 14+ | yes | yes | yes |

Keyboard-mode rules (native decides):
- `hardwareKeyboard = GCKeyboard.coalesced != nil`, updated on
  `GCKeyboardDidConnect/Disconnect`; subscribe once at app level.
- Disconnect while in Vim: switch the presentation to Source in place (same
  storage, caret preserved), toast "Vim paused", restore on reconnect.
- Esc on iPad: "Esc" key in the native `inputAccessoryView`; document Caps
  Lock → Esc remap; ship a `jk` → Esc insert-mode toggle. Held h/k/l/w open
  the accent popup on iPadOS 26 in any text view; mitigate by setting
  `UITextInputTraits` where possible and document the rest.
- Touch: the system edit menu carries formatting; the accessory bar carries
  Undo/Redo/Bold/Italic/Heading/List/Link/Image/Esc; typewriter off while the
  keyboard is up; 44 pt targets.

## 4. Data, sync, offline, undo

### 4.1 Backend changes (additive; web migrates first)

1. `documents.commitEdit {documentId, node, markdown, wordCount, expectedHeadNodeId, clientMutationId}`:
   verifies ownership + size, idempotently inserts the node, checks the
   expected head, updates `currentNodeId` + `markdown` + `wordCount` +
   `updatedAt` in one transaction; returns `{committed, headNodeId, updatedAt}`
   or `{diverged, remoteHeadNodeId}`. Replaces the three writes implicated in
   plan 022.
2. `settings` table `{userId, json, updatedAt}` + `settings.get/save`.
3. `workspaces` keyed by `(userId, deviceId)` with `deviceClass`; "Resume
   from Mac layout" is an explicit action.
4. `account.deleteEverything` action: purge every user-keyed table and
   storage blobs; delete the Clerk user (backend API); revoke Sign in with
   Apple tokens (TN3194). Idempotent.
5. `documents.create` accepts a client `documentUuid` for idempotent offline
   creation.
6. `export.docx` Node action running `remark-docx` from the canonical
   Markdown (one renderer for web and native); `.md` and `.html` stay local.
7. AI on Convex (§8), review moderation (§8.6).

### 4.2 Local store (GRDB, WAL, actor-wrapped)

`documents` (local uuid, convex id?, markdown, title, wordCount, localHead,
remoteHead, syncState) · `doc_nodes` (+ materialized markdown for recent
nodes) · `versions` · `comments` · `review_branches` · `writing_stats` ·
`settings` · `ai_runs` (cached) · `outbox` (ordered, idempotency key, base
head, payload, attempts, lastError) · `window_state`. iOS data protection
`completeUntilFirstUserAuthentication`. No SQLCipher without a threat model.

### 4.3 Edit path

`NSTextStorage` change → `RectoHistory.GroupingController` (Swift port; 500
ms grouping, structural boundaries) → `commitNode` → one SQLite transaction
(node + head + outbox job) → `RectoSync` drains the outbox in order via
`commitEdit` → "Synced". The draft row is written on every change (debounced
250 ms) so a crash loses nothing. Flush on background, window close, scene
disconnect, mode switch.

### 4.4 Conflicts (no CRDT; ADR-06 stands)

- remote head == local base → upload, fast-forward.
- remote head is an ancestor of local head → upload missing nodes, advance.
- no pending local work, remote newer → adopt when idle, keep caret.
- diverged → keep both branches (the DAG allows it); compare sheet: keep
  local / keep remote / edit merged; resolution appends a node parented to
  the cloud head.

### 4.5 Parity

Swift ports of `patch`, `materialize`, `ulid`, `grouping`, `streak`,
`diffRuns` run the same JSON fixtures as the web (`packages/editor-fixtures`).
RectoCoreJS outputs are compared against the web on the same corpus in CI.

## 5. Design system and icon

See `plans/023-native-apple-apps-design.md` for the full design plan
(direction, IA, screen specs, native token mapping, states, iconography,
accessibility, icon and store page). Summary:

- Principles carried over: typography-first, the tool disappears, luminance
  not shadow, one restrained accent, motion only in chrome, contrast 7:1 /
  4.5:1 / 3:1. The sheet on the atmosphere is the signature.
- Paired palette v1 (Twilight dark unchanged; "Paper" light: bg-app
  oklch(0.975 0.008 85), ink oklch(0.22 0.02 285), accent oklch(0.52 0.15
  288)); verify contrast numerically in the token pipeline. Web gets the
  light theme at the same time; drop the forced `className="dark"` and the
  coral Clerk palette.
- Type: chrome SF Pro; prose Source Serif 4 19 pt / 1.6 (Figtree option);
  source JetBrains Mono 17.5 pt; fonts bundled (OFL).
- Icon: rebuild the folded-leg "R" as vectors → Icon Composer `.icon`
  (Default, Dark, Mono); asset-catalog fallback for iOS 18/macOS 15.

## 6. Mac spec (this is where it must be excellent)

- Window: `NSWindow` full-size content, transparent titlebar; library as
  `NSSplitViewItem.sidebar`; editor column; trailing inspector (outline /
  history / versions / comments / review / AI). Toolbar: editable title,
  mode segmented control, inspector toggle. Focus mode uses native
  `toggleFullScreen`.
- Menu bar mirrors `lib/keyboard/actions.ts` one-to-one (File, Edit, View,
  AI, Window, Help; the full chord table is in the design plan). Existing
  Ctrl+Shift chords stay as secondary equivalents.
- Command palette: ⌘K floating non-activating `NSPanel` over the same
  registry as menus; ⌘P documents; go-to-heading.
- Status bar: native, same contents as `components/status-bar.tsx`.
- System integration: Spotlight via `IndexedEntity`, Handoff
  `NSUserActivity` per document, App Intents (New Document, Append to
  Document, Today's Word Count, Set Mode), Services ("New Recto document
  with selection"), Focus filter, Quick Look extension for `.md`, Settings
  scene ⌘, (Appearance / Writing / Editor / Vim & shortcuts / Sync & storage
  / AI / Account / About).
- Onboarding: first launch opens a bundled sample document; "Write locally"
  / "Sign in to sync"; no permission prompts; AI consent only on first
  enable.

## 7. iPad and iPhone spec

- Layout: `NavigationSplitView` (library / editor / inspector) regular,
  stack compact. All orientations, resizable (`UIRequiresFullScreen` is
  gone), `UISceneSizeRestrictions.minimumSize`, multiple scenes. Size classes
  only.
- iPadOS 26 menu bar: SwiftUI `.commands` render on iPad; same command tree.
- Text view: `UITextView` (TextKit 2) subclass from RectoEditor; keyboard
  avoidance via `keyboardLayoutGuide`; native `inputAccessoryView`;
  `inputAssistantItem` groups cleared; `UIFindInteraction` for find.
- Hardware keys: app commands as `UIKeyCommand`,
  `wantsPriorityOverSystemBehavior` for arrows/Tab/Esc in Vim; `pressesBegan`
  feeds RectoVim before the text view.
- Smart punctuation: `smartQuotesType`/`smartDashesType = .no` in Source and
  Vim, `.default` in Rich prose, `.no` inside code spans (trait switch on
  caret move).
- Export: `UIDocumentPickerViewController` / `ShareLink` + `Transferable`.
- Share extension "Save to Recto" (App Group + outbox). Widgets: daily goal
  ring, streak.

## 8. AI on Convex: BYOK, metering, LangSmith (D-N10)

### 8.1 Why move

The key was never exposed (`lib/ai/server.ts` reads it server-side). Moving
the calls into Convex gives one backend for web and native, one auth path
(`ctx.auth`), the same shared-doc gate as `convex/review.ts`, and puts
credential resolution, metering and tracing in one place.

### 8.2 Functions

- `convex/ai/credentials.ts`: `resolveCredential(ctx, userId)` (internal) →
  `{apiKey, source: "byok" | "house"}`.
- `convex/ai/transform.ts`: `httpAction POST /ai/transform` streams plain
  text via `TransformStream` and persists the run in `aiRuns`; the Swift app
  calls it with `URLSession` bytes streaming and the Clerk token, and can
  subscribe to `aiRuns.get` for resilience. Plus an `action` for
  non-streaming callers.
- `convex/ai/review.ts`: `action` running `runReviewLoop` with the OpenRouter
  client injected; writes comments (`review.addComment`, author = AI
  reviewer) and the suggestion branch (`review.aiSuggestBranch`) via internal
  mutations. Removes the client-mediated apply path.
- `convex/ai/embed.ts`: on-demand embeddings; `reindexSweep` unchanged.
- Guards in every function: `requireUserId`, `rejectIfDocumentShared`,
  consent flag, rate limit, credential.
- Default Convex runtime (no `"use node"`): the OpenAI SDK and streaming
  `fetch` work there. Delete `app/api/ai/*`, `lib/ai/server.ts`,
  `lib/ai/route-guard.ts` once the web client calls Convex.

### 8.3 BYOK

- Two ways to add a key: paste an OpenRouter key, or OpenRouter OAuth PKCE
  (Proof Key for Code Exchange: the app generates a random `code_verifier`,
  sends its SHA-256 `code_challenge` to the authorize page, the user approves,
  OpenRouter returns a one-time `code`, the app exchanges `code` +
  `code_verifier` for a user-scoped API key; no client secret, nothing to
  paste). Native: `ASWebAuthenticationSession` with a universal-link callback.
- Storage: `aiCredentials {userId, provider: "openrouter", ciphertext, iv,
  last4, createdAt}`. AES-256-GCM via WebCrypto in an action, key from the
  Convex env `AI_CREDENTIAL_KEY` (32 bytes, base64), random 96-bit IV per
  row. Decrypt only inside the calling action; never returned to a client.
- Validation on save: one `GET /api/v1/key` call; surface OpenRouter errors
  as a settings state.

### 8.4 Metering and limits

- Ledger `aiUsage {userId, runId, kind, model, promptTokens,
  completionTokens, reasoningTokens, costMicros, keySource, latencyMs,
  langsmithRunId?, documentId?, createdAt}` from the response `usage`
  (OpenRouter always returns `usage.cost`; in streams it is in the final
  chunk). Index `by_user_created`.
- Limits with `@convex-dev/rate-limiter`: `aiRequests` token bucket per user
  (20/min) for everyone; `houseSpend` fixed daily window with `count` = cost
  in micro-dollars, allowance `AI_HOUSE_DAILY_MICROS` = **0** for non-owners.
  Without BYOK or an entitlement the client never calls the model; it shows
  "Add your own OpenRouter key" (v1) and, once billing ships, the IAP
  paywall. Owner allowlist `AI_UNMETERED_USER_IDS`.
- Paid path (post-launch, D-N13): `entitlements {userId, product: "ai-pro",
  source: "appstore" | "stripe", expiresAt, originalTransactionId?}` written
  by an App Store Server Notifications v2 HTTP action and a Stripe webhook
  HTTP action; the resolver treats an active entitlement as house key with
  a monthly cap (`AI_PRO_MONTHLY_MICROS`). StoreKit 2 in the apps, Stripe
  Checkout on the web, price parity.
- Usage UI: Settings › AI shows today/month spend, per-kind breakdown, key
  source; monthly aggregation cron.

### 8.5 LangSmith

- `langsmith` 0.9.x in the default Convex runtime: needs `node:async_hooks`,
  available since convex 1.39 (repo on 1.45). N0 includes a smoke action.
  ALS context does not cross `ctx.run*`; keep each traced call in one
  action and pass `runId` manually to child mutations.
- `wrapOpenAI(new OpenAI({baseURL: OPENROUTER_BASE_URL, apiKey}))` for LLM
  spans; `traceable` around `runReviewLoop`. Metadata: hashed userId,
  `kind`, `keySource`, `documentId`, `platform`. Set `usage_metadata`
  (`input_tokens`, `output_tokens`, `total_cost` from OpenRouter's
  `usage.cost`).
- Flush: `finally { await client.awaitPendingTraceBatches() }`. Env
  `LANGSMITH_TRACING=true`, `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT`.
- Content policy (BK): full inputs and outputs traced so traces can feed
  datasets and evals; disclosed in consent and privacy policy; tracing
  opt-out in Settings › AI.
- Evals: datasets `transform-golden` and `review-golden` from annotated
  traces (annotation queue); `scripts/ai-evals.ts` runs `evaluate()` on
  prompt or model changes (LLM-as-judge for edit fidelity + deterministic
  checks: valid canonical Markdown, comments quote verbatim text). Prompts
  stay versioned in `lib/ai/instructions.ts`.

### 8.6 Review/comments in native v1 with guideline 1.2 controls

- New: `commentReports`, `review.reportComment`, `review.blockUser` (revokes
  shares both ways, hides that user's content), `userBlocks`, moderation
  contact in Settings › Account, documented 24 h response process.
- Native UI: comments inspector (threads, resolve, report), review surface
  (open branches, diff via the Swift `diffRuns` port, per-hunk accept via
  server-authoritative `review.acceptHunks`), share sheet, reviewer mode for
  shared documents (`review.getReviewerDocument`, `reviewerAppend` via the
  outbox). Anchors computed natively from the selection (quote/prefix/suffix
  from the string) with the same relocation rules as the web.

### 8.7 Consent (guideline 5.1.2(i))

First enable of AI shows what is sent, to whom (OpenRouter → model provider
named from `AI_CHAT_MODEL`; LangSmith for tracing), the key source, and
Decline. Stored as `settings.aiConsent {version, acceptedAt}`; re-prompt on
version change. "Delete AI index" clears `docChunks`.

## 9. Roadmap

Effort assumes one engineer with Codex doing the typed-out work from frozen
specs; the editor engine is serial and dominates.

| # | Milestone | Deliverable | Acceptance | Effort |
|---|---|---|---|---|
| N0 | Spikes (go/no-go) | (a) clerk-ios + convex-swift on Mac and iPad incl. a macOS Release archive; (b) fork/evaluate `swift-markdown-engine`: open the corpus, hide/reveal markers, caret stability, 10k-word document scroll; (c) RectoVim: codemirror-vim core in `JSContext` behind a Swift adapter, `dw`/`ciw`/`v`/`/` working on an `NSTextView`; (d) RectoCoreJS: `normalize`/`countWords` in `JSContext` matching the web corpus; (e) `traceable` in a Convex action | Auth + subscription on both platforms; typing p50 < 8 ms and marker reveal < 16 ms on a 10k-word doc (M1 iPad); vim keystroke round-trip < 2 ms; corpus parity 25/25; LangSmith run visible | 3 wks |
| N1 | Web invariants + backend | Fix 022; `commitEdit`; `settings`; per-device `workspaces`; account deletion; `documentUuid`; `export.docx` action; "Paper" theme + appearance toggle on the web; DOM-free entries for `lib/markdown`/`lint`/`outline`/`stats`; ADR-19 (commitEdit), ADR-20 (light theme), ADR-21 (settings on Convex) | 5× repeated undo-after-AI e2e green; web on `commitEdit`; parity fixtures published | 3–4 wks |
| N2 | AI on Convex | §8.2–8.5 and §8.7: actions/HTTP action, credentials, metering, rate limits, LangSmith, consent; web client migrated; Next AI routes deleted; §8.6 moderation backend | Web AI features work through Convex; `aiUsage` rows carry OpenRouter cost; allowance error path exercised; LangSmith shows cost | 3 wks |
| N3 | JS cores | `packages/recto-core-js`, `packages/recto-vim-js`, Swift wrappers (`RectoCoreJS`, `RectoVim`), fixtures in CI | Parity green in CI for both JS and Swift; vim adapter passes a keystroke script suite (100 commands) | 2–3 wks |
| N4 | Native core | RectoStore (GRDB, migrations), RectoSync (outbox, transport, conflicts), DocumentSession actor, RectoHistory ports with fixtures, RectoAuth | Create/edit/undo offline, kill app, relaunch, reconnect: zero loss; two-client fast-forward and divergence flows pass | 4–5 wks |
| N5 | Editor engine (Mac) | RectoEditor on AppKit: styler, four presentations, blocks (lists, tasks, code, quotes, images, footnotes, tables overlay, frontmatter header), slash menu, format bar, find, typewriter, focus dim, smart paste, image upload, comment + lint decorations, undo-tree integration | Corpus renders identically to web snapshots (rich + source); 10k-word doc at 60 fps; VoiceOver reads structure; Writing Tools works | 8–10 wks |
| N6 | Mac alpha | Window/sidebar/inspector, menus, palette, status bar, splits, appearance + palettes, settings, import/export, history + versions UI | Daily-driver usable by BK; every action reachable by keyboard; Spotlight/Handoff working | 5–6 wks |
| N7 | Mac beta | Stats/goals/streak, outline, comments + review + share UI, AI panels (transform preview, review, related, usage, BYOK via PKCE), App Intents, Services, Quick Look, accessibility pass, sandbox, internal TestFlight | Full Keyboard Access + VoiceOver pass; AI + review flows verified against prod Convex; no crash in 1 week of use | 5–6 wks |
| N8 | Editor engine (iOS) + iPad | UIKit port of RectoEditor (styler shared, view layer ported), accessory bar, keyboard modes, adaptive layout, pointer, Stage Manager, scenes, share sheet, iPadOS menu bar | Corpus snapshot parity with Mac; vim on/off with keyboard; TestFlight | 6–7 wks |
| N9 | iPhone | Compact navigation, rich-first, touch formatting, share extension, widgets | TestFlight | 2–3 wks |
| N10 | Release | Icon Composer icon, screenshots, privacy manifest/labels, review account, metadata, external TestFlight, submission (iOS + Mac) | Approved | 2–3 wks |
| Later | AI Pro billing (StoreKit 2 + Stripe + entitlements); light twins for Aurora/Dawn/Moonlit; direct Mac build + Sparkle; native TK2 tables on iOS 27 | | |

Total ≈ 50–64 engineer-weeks; Mac daily-driver (N6) around week 30–34. For
comparison, the WKWebView-runtime plan was 34–44 weeks; the difference is
N5 + N8. Delegate to Codex: N1/N2 backend + tests, N3 bundles + adapter
plumbing, Swift ports with fixtures, GRDB layer, UIKit port of the view
layer, screenshot automation. Keep in Claude: editor architecture and
styler rules, vim adapter contract, conflict rules, credential/metering
review, menu and palette IA, design tokens, review of every Codex diff.

## 10. App Store compliance checklist

- [ ] Xcode 26 / iOS 26 SDK (required since 2026-04-28); Xcode 27 SDK +
  Liquid Glass compatibility before ~April 2027; UIScene lifecycle; launch
  screen.
- [ ] 4.8: Google login is enabled, so native Sign in with Apple is
  required and equally prominent (D-N12).
- [ ] 5.1.1(v): in-app account deletion (Settings › Account) that deletes
  data + Clerk user, worldwide; SIWA token revocation (TN3194).
- [ ] 5.1.1: privacy policy URL in ASC and in-app; support URL; contact
  in-app. Labels: Contact info (name, email), Identifiers (user ID), User
  Content ("Other User Content" = documents; photos if image upload;
  comments), Diagnostics only if crash reporting is added. No tracking, no
  ATT, `NSPrivacyTracking=false`.
- [ ] `PrivacyInfo.xcprivacy` in every target: `UserDefaults` CA92.1 (Clerk
  uses UserDefaults; clerk-ios 1.5.0, convex-swift 0.8.1 and
  clerk-convex-swift ship no manifest), FileTimestamp C617.1 if file
  attributes are read. Run Xcode's privacy report.
- [ ] 4.2: fully native, local-first; no web views except the read-only
  email preview, scoped to own content (no "Unrestricted Web Access").
- [ ] 2.5.2: bundled JavaScriptCore scripts only; never fetched.
- [ ] 2.1: review account with seeded documents, a shared document with
  comments, AI enabled with an owner-allowlisted key; Convex/Clerk live;
  notes explain vim gating, offline, history, BYOK.
- [ ] 3.1.1 / 3.1.3(f): v1 is free with BYOK; no in-app CTA or link to buy
  OpenRouter credits; BYOK entry is a key field or OAuth, described as "use
  your own key". When AI Pro ships (D-N13): StoreKit 2 IAP, Restore
  Purchases, same tier on Stripe (3.1.3(b)), no external purchase links
  outside the US storefront.
- [ ] 1.2 UGC: report comment, block user, filter method, moderation
  contact, documented response process, shipped with comments/sharing.
- [ ] 5.1.2(i): explicit consent naming OpenRouter (and model provider) and
  LangSmith before any text leaves the device; "Delete AI index"; tracing
  opt-out.
- [ ] Age rating 4+ (questionnaire incl. social-media question due Sept 2026).
  `ITSAppUsesNonExemptEncryption = NO`. Accessibility Nutrition Labels. EU
  DSA trader status if distributing in the EU.
- [ ] Mac App Store: sandbox, `network.client`, arm64-only, no Sparkle.
- [ ] Assets: Icon Composer `.icon`; screenshots iPhone 6.9" 1320×2868, iPad
  13" 2064×2752, Mac 2880×1800; name ≤30, subtitle ≤30, keywords ≤100.
- [ ] Licences: OFL fonts, `swift-markdown-engine` Apache-2.0 (NOTICE),
  codemirror-vim MIT, remark/retext MIT; acknowledgements screen.

## 11. Risks

| Risk | Mitigation | Fallback |
|---|---|---|
| Editor engine effort and TextKit 2 bugs (extra line fragment, usageBounds jitter, NSTextList, attachment lifecycle, blurry fragment views on iOS) | Build on `swift-markdown-engine`'s workarounds; TK2 only; snapshot tests on the corpus; file radars early | Ship Mac first; iPad/iPhone later if N8 slips |
| Vim via JavaScriptCore adapter | N0(c) spike with a keystroke suite | Native subset (+4 wks) |
| Canonical drift between web (Milkdown) and native (string edits) | RectoCoreJS normalize on commit boundaries; corpus parity in CI | Normalize server-side in `commitEdit` |
| convex-swift immaturity | `SyncTransport` protocol, pinned version | Own WebSocket/HTTP transport (§1.7) |
| Two sync owners | Native is the only network/persistence owner | |
| Same doc in two windows | Shared `NSTextContentStorage` per `DocumentSession`; bring-forward until tested | |
| Offline divergence | Preserve both branches, explicit compare sheet | |
| Schema change breaks web | Additive first; both commit paths during migration | |
| House-key abuse | Zero allowance for non-owners; consent; rate limit; BYOK | |
| LangSmith in Convex runtime untested publicly | N0(e) smoke; OTLP endpoint or OpenRouter Broadcast as alternatives | |
| Encrypted BYOK readable with deploy access | Documented threat model; Convex roles/audit log later | PKCE key kept only in Keychain, sent per request |
| Liquid Glass / SDK 27 deadline (~Apr 2027) | Build on 26 SDK; test 27 betas from N6 | |

## 12. Where the Claude and Codex plans differed, and what BK changed

| Topic | Codex | Claude (first draft) | Final |
|---|---|---|---|
| Editor | WKWebView runtime | WKWebView runtime | **Fully native TextKit 2 + JS core** (BK) |
| Workspace sync | fully device-local geometry | per-device rows + explicit resume | per-device rows |
| Icon | right-hand page + caret | Didone R with folded leg | R |
| AI/review in v1 | defer | defer | **in v1** on Convex with BYOK, metering, LangSmith, moderation (BK) |
| Effort | 29–44 wks | 28–36 wks | 50–64 wks with the native editor |

Adopted from Codex: atomic `commitEdit`, branch-preserving divergence with a
compare sheet, "write locally" onboarding, guideline 1.2/5.1.2 obligations,
Style Dictionary as the token pipeline, one paired palette first.

## 13. Out of scope

Android; CRDT sync; AI credit sales in v1; direct `.md` file editing
(document-based app); replacing the web editor; Aurora/Dawn/Moonlit light
twins (later); direct-download Mac build (later).

## 14. STOP conditions

- N0(b) cannot hide/reveal markers with a stable caret on a 10k-word
  document at 60 fps on an M1 iPad or Apple silicon Mac.
- N0(c) and the native-subset fallback both fail to deliver `dw`, `ciw`,
  visual mode and `/` search within the spike budget.
- N0(d) parity below 25/25 on the corpus after a week of fixes.
- N0(a) fails both convex-swift and the own-transport fallback.
- `traceable` needs `"use node"` for every AI action (then move AI actions
  to Node runtime and re-plan the 10-minute cap for the review loop).
- Apple rejects the BYOK entry as a purchase mechanism (then keep BYOK
  web-only, mirrored into the app by sync).

## 15. Decisions taken by BK (2026-08-27) and what is still open

Taken: fully native Swift/SwiftUI (D-N1); public listing (D-N13); Google +
email + Apple + passkeys (D-N12); house allowance zero for non-owners, BYOK
or pay (D-N10, D-N13); LangSmith traces full content for evals (§8.5); BYOK
by paste and PKCE (§8.3); light + dark on the web too (D-N5). Design plan:
`plans/023-native-apple-apps-design.md`.

Decided by the orchestrator on BK's delegation (see
`plans/023-orchestration.md` §0): iOS/iPadOS 26 + macOS 26 floors; same
document in two Mac windows allowed once N4 tests pass; Source Serif 4
wordmark and the recto/verso story adopted; AI Pro $5.99/month or
$49.99/year in v1.1; fork `swift-markdown-engine`; Twilight + Paper only at
launch; toolbar mode control; sidebar visible by default.
