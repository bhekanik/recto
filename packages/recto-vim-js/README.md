# `@recto/vim-js`

`@replit/codemirror-vim`'s keymap core, bundled DOM-free so it runs in a
`JSContext` behind a Swift adapter instead of a CodeMirror 6 `EditorView`.

Consumed by `apple/Packages/RectoVim` (plan 023 N3). The N0c spike proved the
shape; this is the production build of it, with grapheme clamping added.

## Why this shape

The upstream bundle is already split where we need it. `initVim(CM)` is a
~7,000-line factory whose only argument is the editor adapter *class*, and every
editor call the vim core makes goes through it. All seven CodeMirror 6
references in the package sit below that seam, in the adapter and the view
plugin, both of which we replace.

So the "port" is a cut, not a patch: `scripts/extract-core.ts` copies the factory
out of `dist/index.js` **verbatim**, and we hand it a different adapter. Zero
lines of upstream logic are modified, which is what makes a version bump cheap.

## Build

Run from the repo root:

```sh
bun install --frozen-lockfile      # the extractor reads node_modules
bun run vim:build                  # extract + bundle -> dist/recto-vim.js
bun run vim:test                   # keystroke suite + grapheme unit tests
```

The suites are named `*.bun.test.ts` because they use `bun:test`, which vitest
cannot bundle; that is the same convention `spikes/undo-tree` follows. They are
still typechecked — `tsconfig.json` no longer excludes the pattern, and nothing
else matched it.

`build.ts` re-extracts, bundles, then **evaluates the fresh bundle in a realm
with no DOM** (`bare-realm.ts`) and drives a real keystroke through it. A
dependency that reaches for a browser global fails the build, not the app.

`dist/` and `manifest.json` are build output and are **not committed** — same
policy as `recto-core-js`. `apple/scripts/copy-js-bundles.sh` copies the bundle
into `RectoCoreJS/Resources` and checks its sha256 against `manifest.json`, so a
stale copy is a build error rather than a subtly old vim. A clean clone runs
`bun install && bun run core:build && bun run vim:build` before `swift build` or
Xcode; Xcode Cloud does it in `ci_scripts/ci_post_clone.sh`.

The bundle is **minified** (119 kB against 257 kB), unlike `recto-core.js`, which
is not: the core is unminified because `write-good`'s transitive `adverb-where`
assembles a RegExp from concatenated template literals and minifiers have
corrupted it. Nothing in the vim core does that, and the 128-case keystroke suite
runs against these exact bytes in both Bun and JavaScriptCore, so a minifier bug
fails CI rather than shipping.

### Upgrading `@replit/codemirror-vim`

1. Bump the dependency, `bun install`.
2. `bun run vim:build`. The extractor fails loudly if its anchors are no longer
   unique — that is the signal that upstream moved the seam.
3. Update `EXPECTED_VIM_VERSION` in `scripts/extract-core.ts`.
4. `bun run vim:test`, then `swift test --package-path apple/Packages/RectoVim`.
   Both run `fixtures/keystroke-suite.json`; the Swift side also replays it
   through a headless `NSTextView`.
5. Re-check the three upstream behaviours this package leans on, because none of
   them is covered by upstream's own tests: `initVim(CM)` still takes the adapter
   class as its only argument; `Vim.defineMotion("moveByCharacters", …)` still
   overrides the motion the operators use; `updateSelectionForSurrogateCharacters`
   still only widens by one code unit. The keystroke suite fails loudly if any of
   them changes.

If upstream ever inlines the adapter into the core, this approach dies and the
fallback is a native Swift subset (see the spike report).

## What runs where

The adapter keeps its **own copy of the document** as a line array. The vim core
reads the buffer constantly — dozens of `getLine`/`getRange`/`getCursor` calls
for one keystroke — and writes rarely, so answering reads locally is what keeps
a keystroke to **one bridge crossing each way**:

```
NSEvent → VimKeyEvent → RectoVim.handleKey(key, mods) → JSON string
                                                         ├─ edits[]      → NSTextStorage
                                                         ├─ selections[] → setSelectedRange
                                                         ├─ mode         → caret shape
                                                         └─ prompt/pending/notification → status bar
```

Swift never pushes text in during a keystroke; it replays the edit journal. The
two strings stay identical because both apply the same ops in the same order,
and the Swift suite asserts that they still match after 1,600 keys.

## Coordinates

**Everything is UTF-16 code units.** JS string indices and `NSRange` are both
UTF-16, so an offset from JS drops into an `NSRange` with no conversion. That is
why the wire format is offsets rather than `{line, ch}` pairs, even though the
vim core speaks `{line, ch}` internally — the conversion happens once, inside
the adapter, against its line index.

Swift `String.count` is graphemes and is **never** the right length here. Use
`string.utf16.count` and `NSString` APIs, as `VimTextViewAdapter` does.

## Grapheme clamping

The vim core clips positions to **code points**, not grapheme clusters, and we
do not patch upstream. Left alone that severs anything built from several code
points, silently — `NSTextStorage` stores the wreckage without complaint. The
N0c spike measured it:

| input | `x` on the cluster, unclamped | clamped |
|---|---|---|
| `a🎩b` | `ab` | `ab` |
| `a👨‍👩‍👧‍👦b` | `a‍👩‍👧‍👦b` — ZWJ severed | `ab` |
| `a🇿🇦b` | `a🇦b` — flag loses an indicator | `ab` |
| `a👍🏽b` | `a🏽b` — modifier orphaned | `ab` |
| `aéb` (e + U+0301) | `áb` — mark reattaches to `a` | `ab` |

`src/grapheme.js` wraps `@marijn/find-cluster-break`, the UAX #29 implementation
CodeMirror 6 itself uses (`findClusterBreak` in `@codemirror/state` is a one-line
re-export of it), so the web lens and the native lens break clusters by identical
rules. It is 4 kB, dependency-free and touches no host globals, which is what
lets it into a `JSContext` bundle. It is wired in at four points, all of them
ours:

1. **`Vim.defineMotion("moveByCharacters", …)`** in `src/index.js`. Upstream's is
   `new Pos(cur.line, cur.ch ± repeat)` — plain arithmetic. Replacing the motion
   through a documented extension point fixes `h`, `l`, `x`, `X`, `s`, `~`, `dl`,
   `dh` and every count on them at the source, and operators, dot-repeat and
   macros inherit it. Still **zero upstream lines modified**.
2. **`RectoCM._applyEdit`** widens any range that starts or ends inside a cluster,
   and moves a pure insertion point forward to the end of the cluster it landed
   in (which is where `p` means to be). This is the backstop for the paths that
   do their own arithmetic — `r`, `p`, replace mode.
3. **`RectoCM._snapCaret`**, on `setCursor` and `setSelections`: a caret is a
   boundary, never a position inside a character.
4. **`RectoCM.keys.Backspace`/`Delete`** and `overWriteSelection`, which step one
   cluster in insert and replace mode.

Twenty-one cases in `fixtures/keystroke-suite.json` cover it, and
`test/grapheme.test.ts` pins the boundary maths directly. One known divergence is
recorded in the fixture: after `r` on a multi-codepoint cluster the caret lands
one character past the replacement, because the core computes it from the range
it asked for rather than the range clamping actually replaced.

**Swift does not repeat this.** The JS mirror is the authority; a Swift-side
clamp that disagreed by one code unit would desynchronise the two buffers.
`RectoVim.GraphemeClamp` exists only for positions of *native* origin (a mouse
click, an initial caret, a host `setText`) on their way *into* JS, and
`RectoVimTests` asserts it is the identity on every selection JS produces.

## Threading

`JSContext` is not thread-safe and every call mutates vim state, so the engine is
confined to **one thread, the main one**. That is forced rather than chosen:
`keyDown` has to know synchronously whether vim consumed the key before it
returns, so it cannot await a background actor.

It is affordable because a keystroke is one call with no I/O — p50 0.05 ms, p95
0.11 ms on a 10k-word document (measured; see the spike report). Do not move this
off-main "for safety": you would gain nothing and lose the synchronous answer.

`RectoVimHost`'s exported methods are `nonisolated` because `JSExport` cannot
express isolation, and use `MainActor.assumeIsolated` to state the invariant
where the runtime can check it.

## The adapter contract

The vim core calls ~60 members on the adapter. Almost all are answered from the
JS-side mirror. Only these reach Swift:

| Host method | Reached by | Notes |
|---|---|---|
| `geometry({kind:"lineHeight"})` | `zz`, `<C-d>`, `<C-u>` | falls back to fixed metrics if absent |
| `geometry({kind:"charCoords"})` | `H`/`M`/`L`, `gj`/`gk` | |
| `geometry({kind:"coordsChar"})` | `gj`/`gk` | |
| `geometry({kind:"scrollInfo"})` | `<C-d>`, `<C-f>`, `zz` | |
| `geometry({kind:"findPosV"})` | `j`/`k` over wrapped lines, `<C-f>` | return `null` to fall back to document lines |
| `historyCommand("undo"\|"redo")` | `u`, `<C-r>` | host performs it, returns `{text, anchor, head}` |
| `clipboardRead` / `clipboardWrite` | `"+`/`"*` registers | NSPasteboard |

All arguments and replies are JSON strings: reading a field off a `JSValue` is a
bridge crossing of its own, so one string beats five property reads.

### Result payload

`handleKey` returns JSON with `handled`, `edits[]`, `selections[]`, `mainIndex`,
`mode`, `subMode`, `modeChanged`, `pending`, `insertMode`, `visualMode`,
`prompt`, `notification`, `scroll`, `search`, `resynced`. Swift decodes it as
`VimResult`. Every offset in it is already on a grapheme boundary.

Two flags matter:

- **`handled`** — false means vim declined the key and the text view should have
  it (system shortcuts, IME, anything vim does not bind).
- **`resynced`** — the host's own undo came back through JS. The edits were
  already applied by the host; replaying them would double-apply.

## Undo

`u` and `<C-r>` never run vim's own history. On the web they are remapped to the
document's undo tree (`lib/editor/codemirror/index.tsx`, `ensureVimHistoryRemap`);
natively the host owns undo for the same reason, so `CM.commands.undo` calls out
to `historyCommand` and JS resyncs to whatever comes back.

`Vim.defineAction` / `Vim.mapCommand` are exposed on `RectoVim` so N5 can run the
web's remap code verbatim if it prefers that route.

**Known gap for N5:** the host must return a *vim-shaped* caret. Vim puts the
cursor at the start of the restored change; `NSUndoManager` restores whatever
selection it recorded, which in the spike's proof landed two lines away. The
undo tree should compute the caret from the patch it applied, not from the text
view.

The spike also had to set `undoManager.groupsByEvent = false` and call
`breakUndoCoalescing()`: AppKit groups undo per run-loop pass and coalesces
typing, both of which are wrong for vim, where the unit is one command.

## Divergences from real vim

These come from upstream and are what the web lens does today, so matching them
is *correct* for parity — do not "fix" them without changing the web too.

- `dG` at the end of a buffer leaves a trailing empty line. The core asks to
  delete past the last line and the out-of-range position clamps to end of
  document. Recorded in `fixtures/keystroke-suite.json`.
- `getTokenTypeAt` returns `""` (no syntax tree), so `%` will match a bracket
  inside a string or comment, and the quote text objects lose a code-editor
  nicety. Irrelevant for Markdown prose.
- `findEnclosingTag` is stubbed, so the `it`/`at` HTML tag objects do nothing.
  `findMatchingTag` returns `null` upstream too.
- `j`/`k` move by document line, not display line, until a host implements
  `geometry({kind:"findPosV"})`. With soft wrapping on, that is visible.

## Coexisting with the rich lens

The vim lens uses the **raw/source presentation**: markers are visible, the
string is what you see. That is what makes the mirror sound — JS and the text
view agree on offsets because nothing is hidden or substituted.

Do not run the vim layer over the rich presentation. Marker hiding shrinks
markers to a tiny font rather than deleting them, so offsets still line up, but
`$`, `0` and visual selections would land on characters the reader cannot see.
Switching lenses should `setText` the engine and let it re-derive state.

## DOM shim

JavaScriptCore has no DOM and no timers. The core touches exactly four host
things, so `src/dom-shim.js` provides exactly four and nothing more — an
unexpected reach for the DOM should throw during the keystroke suite, not be
absorbed by a fake:

1. `document.createElement`/`createTextNode`, used by the core's `dom()` helper
   to build the `:`/`/` prompt and the message line. Both become status-bar text.
2. `window.setTimeout`/`clearTimeout`, for the insert-mode escape-key timeout
   (`jk` mappings). Queued and drained after each key.
3. `navigator.clipboard`, for the `"+`/`"*` registers. `readText` returns a
   promise, so a system-clipboard paste lands one turn late.
4. `navigator.platform`, read once for Mac-style key names.

## Layout

```
build.ts                  extract -> bundle -> DOM-free gate -> manifest.json
bare-realm.ts             the DOM-free gate: node:vm realm with no host globals
scripts/extract-core.ts   verbatim slices of upstream; fails loudly on drift
src/generated/            output of the above (gitignored)
src/document.js           line-array mirror, UTF-16 offsets
src/adapter.js            RectoCM — the ~60-member adapter
src/grapheme.js           cluster boundaries (@marijn/find-cluster-break)
src/prompt.js             the `:` / `/` line
src/dom-shim.js           the four host things the core needs
src/host.js               Swift-side contract, JSON wire
src/index.js              the RectoVim global
fixtures/                 shared with the Swift suite
test/*.bun.test.ts        Bun runner over dist/recto-vim.js
```
