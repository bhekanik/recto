# `@recto/vim-js`

`@replit/codemirror-vim`'s keymap core, bundled DOM-free so it runs in a
`JSContext` behind a Swift adapter instead of a CodeMirror 6 `EditorView`.

This is N0c spike output. It is not merged; it exists so N3 (JS cores + Swift
wrappers) and N5 (the editor engine) can start from a working contract instead
of a design sketch.

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

```sh
bun install --frozen-lockfile      # the extractor reads node_modules
bun run vim:build                  # extract + bundle -> dist/recto-vim.js
bun run vim:test                   # 64-case keystroke suite against the bundle
```

`dist/recto-vim.js` is committed so the Swift package builds without a JS
toolchain.

### Upgrading `@replit/codemirror-vim`

1. Bump the dependency, `bun install`.
2. `bun run vim:build`. The extractor fails loudly if its anchors are no longer
   unique — that is the signal that upstream moved the seam.
3. Update `EXPECTED_VIM_VERSION` in `scripts/extract-core.ts`.
4. `bun run vim:test`, then the Swift suite. Both run the same fixtures.

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

Where this still bites (all verified against the built bundle, not assumed):

- The core clips to **code points**, not grapheme clusters. A single-codepoint
  emoji is safe — `x` on `a🎩b` gives `ab`, and `l` steps over it as one
  position. Anything built from *several* code points is deleted one code point
  at a time and left broken:

  | input | `x` on the cluster | |
  |---|---|---|
  | `a🎩b` | `ab` | correct |
  | `a👨‍👩‍👧‍👦b` | `a‍👩‍👧‍👦b` | ZWJ sequence severed, stray ZWJ left |
  | `a🇿🇦b` | `a🇦b` | flag loses one regional indicator |
  | `a👍🏽b` | `a🏽b` | skin-tone modifier orphaned |
  | `aéb` (e + U+0301) | `áb` | combining mark reattaches to `a` |

  **N5 must add grapheme clamping** in `clipPos`/`moveH`, the way CodeMirror 6
  does it in `EditorState` with `findClusterBreak`. `NSTextStorage` stores the
  broken cluster without complaint, so this fails silently and only shows up as
  mangled text.
- Swift `String.count` is graphemes and is **never** the right length here. Use
  `string.utf16.count` and `NSString` APIs, as `VimTextViewController` does.

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
`VimResult`.

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
scripts/extract-core.ts   verbatim slices of upstream; fails loudly on drift
src/generated/            output of the above (gitignored)
src/document.js           line-array mirror, UTF-16 offsets
src/adapter.js            RectoCM — the ~60-member adapter
src/prompt.js             the `:` / `/` line
src/dom-shim.js           the four host things the core needs
src/host.js               Swift-side contract, JSON wire
src/index.js              the RectoVim global
fixtures/                 shared with the Swift suite
test/                     Bun runner over dist/recto-vim.js
```
