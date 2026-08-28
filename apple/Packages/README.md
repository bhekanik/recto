# apple/Packages

Swift packages for the native apps (plan 023 §1.2). This file covers the two
that N3 delivers: **RectoCoreJS** (the shared markdown core) and **RectoVim**
(the vim layer). `RectoEditor`, `RectoStore`, `RectoSync`, `RectoHistory` and
`RectoAuth` are documented by the phases that build them.

## Before anything builds

Both packages ship a JavaScript bundle, and neither bundle is committed:

```sh
bun install --frozen-lockfile
bun run core:build          # packages/recto-core-js/dist/recto-core.js
bun run vim:build           # packages/recto-vim-js/dist/recto-vim.js
apple/scripts/copy-js-bundles.sh
swift test --package-path apple/Packages/RectoCoreJS
swift test --package-path apple/Packages/RectoVim
```

**Why not commit them.** They are 1.0 MB and 120 kB of generated JavaScript.
Committed, every change to `lib/` would produce a diff no reviewer can read, and
the copy in `Sources/` could silently disagree with the source it was built
from. `copy-js-bundles.sh` compares each bundle's sha256 against the
`manifest.json` its build wrote, so a stale copy is a build error instead. In
Xcode it is a run-script phase; on Xcode Cloud it runs from
`ci_scripts/ci_post_clone.sh`, which installs a pinned Bun first (the images
have none). The same script also refuses to install a bundle containing a
localhost URL, a `sourceMappingURL=` pragma, an `sk_`/`pk_live_` key or the
string `OPENROUTER` (plan 023 §2).

Without the bundle the packages still compile; `RectoCore.init` and
`VimEngine.init` throw an error naming the command to run. That is deliberate —
a SwiftPM "missing resource" failure would not.

---

# RectoCoreJS

The DOM-free half of `lib/`, running in a `JSContext`, plus two Swift ports of
the parts that have to run on every keystroke.

## `RectoCore` — the JS core

```swift
let core = try RectoCore()                       // ~20 ms, throws if unbuilt
let canonical = try await core.normalize(markdown)
let words     = try await core.countWords(markdown)
let outline   = try await core.parseOutline(markdown)      // [OutlineHeading]
let html      = try await core.htmlFromMarkdown(markdown)  // sanitized preview
let pasted    = try await core.markdownFromHtml(html)      // smart paste
let issues    = try await core.lint(markdown, categories: [.passive])
let streak    = try await core.streak(days, today: "2026-08-28")
core.version                                     // "0.1.0+<sha>"
```

**This is the authority, not a utility.** Everything here has to match the web
byte for byte, because a document written on the Mac and reopened on the web
must round-trip identically. It is also **not a per-keystroke API** — see the
latency section. Call it at document boundaries: open, paste, save, mode switch,
export.

**Threading.** `RectoCore` owns a serial `DispatchQueue` and a `JSVirtualMachine`
of its own, and confines the `JSContext` to that queue. Every method is `async`
and no `JSValue` escapes. Loading costs ~20 ms, so a second instance for a second
queue is affordable; sharing one across queues is what the design forbids, and
the `async` surface makes that hard to do by accident.

**Errors.** Everything throws `RectoCoreError` on bad input; nothing returns a
sentinel. The bridge is equally strict reading results back, because `JSValue`
coercion fails in the direction that hides bugs — `undefined.toInt32()` is `0`
and `undefined.toArray()` is `nil`, both of which read as "empty document"
rather than "the bridge is broken". `context.exception` is cleared before and
after every call, so one failure is never reported against the next.

**Strings.** Compare results with `a.utf16.elementsEqual(b.utf16)`, never with
`==`. Swift's `==` is canonical equivalence — `"e\u{301}" == "é"` is `true` — so
it would accept NFD output where the web produced NFC. The corpus carries that
exact pair and the test suite asserts the comparison can still tell them apart.

**`lint` is the one async entry point** in the bundle (`write-good` is imported
lazily). JSC drains the microtask queue before returning to native code, so the
promise has already settled when `invokeMethod` returns — no run-loop spin, no
continuation.

## `WordCount` and `Outline` — the Swift ports

```swift
WordCount.count(markdown)   // Int
Outline.parse(markdown)     // [OutlineHeading], UTF-16 offsets
```

Synchronous, pure, no JavaScript. These are what the typing path calls; the JS
core is the authority that corrects them at the next document boundary.

They are not a second markdown parser. `MarkdownProse` is a scanner that
reproduces exactly two things: `lib/markdown/count-words.ts` (visit every MDAST
`text` node, join with one space, split on `\s+`) and `lib/outline/extract.ts`
(every `heading`, flattened by `"value" in node`, at `position.start.offset`).
Its rule is "emit the characters of every `text` node and one space in place of
everything else", which reproduces remark's join without building a tree.

It is checked three ways: against `word-count.json` and `outline.json`, against
the 24 corpus cases and 10 unicode cases, and — where the bundle is built —
against `RectoCore.countWords`/`parseOutline` themselves, on 49 adversarial
documents that the shared fixtures do not cover (`SwiftPortAdversarialTests`).
A divergence is a red test, not a wrong number in a status bar.

Known limits, all deliberate: link reference definitions are recognised by shape
rather than resolved through a full parse (an over-collected label can only turn
a bare `[x]` into a link, which changes no word count); HTML blocks implement
CommonMark types 1, 2, 6 and 7; nothing outside the Recto dialect is supported.
`Outline` offsets are UTF-16 code units — the same units `NSRange` and
`NSTextContentStorage` use — so a heading offset scrolls to without conversion.

## Latency, and the entitlement that decides it

Measured 2026-08-28, M-series, macOS 26 / Xcode 26.6, `apple/Spikes/JSCPerf`:

| document | no `allow-jit` | with `allow-jit` |
|---|---|---|
| 8 kB `normalize` | 89.7 ms | 21.6 ms |
| 50 kB | 525.0 ms | 53.6 ms |
| 64 kB | 669.4 ms | 51.9 ms |
| 250 kB | 3244.8 ms | 731.5 ms |

**A hardened-runtime macOS process without `com.apple.security.cs.allow-jit`
gets no JIT from JavaScriptCore.** Nothing reports this; it just runs ~13×
slower, and the unentitled numbers match `jsc --useJIT=false` exactly. **The Mac
app must ship that entitlement** — plan 023 §2's list (`app-sandbox`,
`network.client`, `files.user-selected.read-write`) is missing it. It is a
hardened-runtime exception, not a sandbox escape, and Mac App Store apps may
carry it.

**iOS has no such entitlement**, on 17, 18 or 26, so the interpreter column is
permanent there. The iOS *simulator* does have the JIT (it is a Mac process), so
simulator numbers are an upper bound and never the go/no-go. Full evidence,
sources and the device invocation are in `apple/Spikes/JSCPerf/README.md`.

Either way, `WordCount` and `Outline` are what the keystroke path calls: both are
well under a millisecond on a 64 kB document.

---

# RectoVim

`@replit/codemirror-vim`'s keymap core in a `JSContext`, behind a Swift adapter,
with grapheme clamping. Zero lines of upstream logic are modified; see
`packages/recto-vim-js/README.md` for how the core is extracted and updated.

```swift
let host = VimHost()
let engine = try VimEngine(host: host)                 // ~3 ms
let adapter = VimTextViewAdapter(textView: textView, engine: engine, host: host)
adapter.onStatusChange = { status in statusBar.render(status) }
try adapter.start()

// in keyDown, before super:
if adapter.handle(event) { return }
```

## The adapter contract

**JS owns a mirror of the document.** The vim core reads the buffer dozens of
times per keystroke and writes rarely, so the adapter answers reads from its own
line array. A keystroke is **one call in and one JSON payload out**, and Swift
*replays an edit journal* rather than pushing text in. Do not "simplify" this
into per-call reads across the bridge — it is the whole performance story
(p50 0.05 ms, p95 0.10 ms on a 10k-word document; budget is 2 ms).

**Coordinates are UTF-16 code units, everywhere.** JS string indices and
`NSRange` are both UTF-16, so an offset from JS drops into an `NSRange` with no
conversion. `{line, ch}` never leaves the JS adapter. Swift's `String.count` is
graphemes and is **never** the right length here — use `utf16.count` and
`NSString`.

**Grapheme clamping lives in JS, and Swift must not repeat it.** The vim core
clips to code points, which severs ZWJ families, flags, skin tones and combining
marks; `packages/recto-vim-js/src/grapheme.js` clamps with the same UAX #29 code
CodeMirror 6 uses. Every offset in a `VimResult` is already on a cluster
boundary, and the adapter applies edit ranges **verbatim** — re-clamping against
ICU could disagree by a code unit and desynchronise the two buffers.
`GraphemeClamp` exists for the other direction only: positions of *native*
origin (a mouse click, an initial caret, a host `setText`) on their way into the
engine. A debug assertion and `RectoVimTests` check that the clamp is the
identity on everything JS produces.

**Threading: main, and forced rather than chosen.** `JSContext` is not
thread-safe, and `keyDown` must know synchronously whether vim consumed the key
before it returns, so it cannot await a background actor. Affordable at
0.05 ms/key. This is the opposite of `RectoCoreJS`, whose calls are
whole-document and slow and which therefore lives on its own queue.

**What reaches Swift** (all rare; editing commands never leave JS):
`VimGeometryProvider` — `lineHeight`, `charCoords`, `offsetAtCoords`,
`scrollInfo`, `verticalMove` (for `H`/`M`/`L`, `zz`, `<C-d>`, `gj`, and `j`/`k`
over soft-wrapped lines); `VimHistoryProvider.performHistory` (`u`/`<C-r>`);
`VimHost.pasteboardRead`/`Write` (the `"+`/`"*` registers only).

**Undo belongs to the host.** `u` and `<C-r>` never run vim's own history — on
the web they are remapped to the document's undo tree, and natively the host owns
undo for the same reason. `VimTextViewAdapter` routes them to
`NSTextView.undoManager`; the product routes them to `RectoHistory`, which is why
it is a protocol. Three things this cost the spike, in case they bite again:

- `NSTextView.allowsUndo` is **off by default**, and a text view with no window
  has no undo manager at all. Either one makes `u` do nothing, silently.
- Edits must go through `shouldChangeText`/`didChangeText`. Writing to
  `textStorage` directly is invisible to undo.
- `undoManager.groupsByEvent` must be **off**: it groups per run-loop pass, and
  with no run loop turning it swallows a whole session into one group.

**Known gap for the undo tree (W9b):** after `u`, vim puts the caret at the start
of the restored change, while `NSUndoManager` restores whatever selection it
recorded. The undo tree must compute a vim-shaped caret from the patch it
applied rather than read it back off the text view.

**Coexisting with the rich lens.** The vim lens uses the raw/source presentation,
which is what makes the mirror sound: nothing is hidden, so JS and the text view
agree on offsets. Do not run vim over marker-hiding rich presentation — `$`, `0`
and visual selections would land on characters the reader cannot see. Switching
lenses should `setText` the engine.

## Configuration and persistence

```swift
engine.noremap("jk", to: "<Esc>", context: .insert)
engine.setOption("ignorecase", true)
let saved = engine.saveState()      // named registers + marks, as JSON
engine.restoreState(saved)
```

`saveState` is deliberately not the whole vim state: mode, pending keys and
search history are session-scoped, and restoring them would resume the user
mid-command. Registers are global to the `JSContext` — that is vim's own model,
and it is why two documents sharing a context share their registers.

## Platforms

`VimTextViewAdapter` is AppKit; `VimUITextViewAdapter` is UIKit, behind
`#if canImport(UIKit)`, and is compile-checked in CI by building the package for
the iOS simulator. Two things differ there, both forced by UIKit: edits go
through `UITextInput.replace(_:withText:)` because `UITextView` has no
`shouldChangeText`, and the block caret is an overlay the app layer draws
because there is no `drawInsertionPoint` seam. Vim is gated on a hardware
keyboard being attached (`GCKeyboard`), not on device class — plan 023 D-N6.

## Divergences from real vim

These come from upstream and are what the web lens does today, so matching them
is *correct* for parity. Do not "fix" them without changing the web too.

- `dG` at the end of a buffer leaves a trailing empty line.
- After `r` on a multi-codepoint cluster the caret lands one position past the
  replacement; the text is right. Recorded in the fixture with a note.
- `getTokenTypeAt` returns `""` (no syntax tree), so `%` matches brackets inside
  strings, and the `it`/`at` tag objects do nothing.
- `<C-q>` is an alias for `<C-v>` upstream — "looks unbound" is not unbound.

## Tests

`RectoVimTests` runs `packages/recto-vim-js/fixtures/keystroke-suite.json` —
128 cases, 21 of them grapheme cases — twice: once headless through `JSContext`,
and once replayed through a real `NSTextView`, asserting the storage stays byte
for byte equal to the engine's mirror. The same file runs in Bun
(`bun run vim:test`), so a case that passes there and fails here is a bridge bug,
which is a much smaller place to look.

`RectoVimPerfTests` and `RectoCoreJSPerfTests` are opt-in
(`RECTO_VIM_PERF=1`, `RECTO_CORE_PERF=1`) and measure CPU time, not wall clock —
the spike saw wall-clock p99 swing 0.5 ms → 42 ms across runs of identical code
purely because of other work on the machine.
