# apple/Packages

Swift packages for the native apps (plan 023 §1.2). This file covers the two
that N3 delivers: **RectoCoreJS** (the shared markdown core) and **RectoVim**
(the vim layer). `RectoEditor`, `RectoStore`, `RectoSync`, `RectoHistory` and
`RectoAuth` are documented by the phases that build them.

## Before anything builds

Both packages ship a JavaScript bundle, and neither bundle is committed:

```sh
bun install --frozen-lockfile
apple/scripts/copy-js-bundles.sh    # builds both bundles, checks and installs
swift test --package-path apple/Packages/RectoCoreJS
swift test --package-path apple/Packages/RectoVim
```

**Why not commit them.** They are 1.0 MB and 126 kB of generated JavaScript.
Committed, every change to `lib/` would produce a diff no reviewer can read, and
the copy in `Sources/` could silently disagree with the source it was built from.

**`copy-js-bundles.sh` builds; it does not merely check.** Comparing a bundle
against the manifest written beside it only proves the bundle has not been
corrupted since — edit `lib/`, keep the matching pair, and it passes, which is
exactly the case that matters. Running the build makes staleness impossible:
`build.ts` is deterministic, so an unchanged tree reproduces the same bytes, and
the script only copies when they differ. Without `bun` on PATH it falls back to
verifying what is in `dist/` and says out loud that it could not check staleness.

It also refuses to install a bundle carrying a loopback URL, a
`sourceMappingURL=` pragma, or anything shaped like a Clerk, Stripe, OpenRouter,
OpenAI, GitHub, AWS, Google, Slack or Convex key (plan 023 §2). Matching is
case-insensitive, and every pattern is deliberately narrower than the word it
guards, because the bare words occur all over a megabyte of dependencies and a
gate that cries wolf gets switched off — `recto-core.js` really does contain
`node:url`'s "File URL host must be \"localhost\"" message.
`apple/scripts/scan-samples.sh` runs each pattern against a positive and a
negative sample, so one that stops matching fails CI instead of going quiet.

In Xcode it is a run-script phase; on Xcode Cloud it runs from
`ci_scripts/ci_post_clone.sh`, which first installs the **same pinned Bun** the
GitHub workflow pins, downloaded as a versioned release artefact and verified
against its published checksum.

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

**The contract is "agrees with the gate", not "agrees with remark".** It is
checked four ways: against `word-count.json` and `outline.json`; against the 24
corpus cases and 10 unicode cases; against `RectoCore.countWords`/`parseOutline`
themselves on a named list of adversarial documents
(`SwiftPortAdversarialTests`); and against the core again on **256 seeded
generated documents** (`SwiftPortDifferentialTests`) composed from every block
and inline construct the dialect has, including CRLF, lone CR, NBSP, ZWSP and the
corpus's emoji. A divergence is a red test, not a wrong number in a status bar —
and a divergence found in the wild is a new case for the gate, not a reason to
soften this paragraph.

Everything the gate does not reach is unproven. The round-2 review found six
real divergences outside the corpus — unclosed frontmatter, `alpha\n2. beta`
(only `1.` may interrupt a paragraph), `&amp;` decoding, HTML block types 3–5,
link definitions inside fenced code, and shortcut images — all now fixed and in
the gate, which is the shape of how the next one will be found. `Outline` offsets
are UTF-16 code units, the same units `NSRange` and `NSTextContentStorage` use,
so a heading offset scrolls to without conversion.

## Latency, and the entitlement that decides it

Median of 10 samples over 2 fresh processes, sizes reshuffled each round;
M-series, macOS 26 / Xcode 26.6, release build, `apple/Spikes/JSCPerf`,
2026-08-28:

| document | no `allow-jit` | with `allow-jit` | ratio |
|---|---|---|---|
| 8 kB `normalize` | 92.7 ms | 6.0 ms | 15.5× |
| 50 kB | 570.5 ms | 40.8 ms | 14.0× |
| 64 kB | 724.6 ms | 54.1 ms | 13.4× |
| 250 kB | 3450.1 ms | 760.5 ms | 4.5× |

**A hardened-runtime macOS process without `com.apple.security.cs.allow-jit`
gets no JIT from JavaScriptCore.** Nothing reports this; it just runs 13–15×
slower up to 64 kB (4.5× at 250 kB, where the entitled run turns
allocation-bound), and the unentitled numbers match `jsc --useJIT=false` at every
size. **The Mac app must ship that entitlement** — plan 023 §2's list
(`app-sandbox`, `network.client`, `files.user-selected.read-write`) is missing
it. It is a hardened-runtime exception, not a sandbox escape; `app-sandbox`
stays, and Mac App Store apps may carry it. macOS only — there is no iOS
equivalent.

**iOS appears to have no such entitlement**, on 17, 18 or 26. That conclusion is
read from WebKit's source (`isJITEnabled()` in `ExecutableAllocator.cpp` and
`process-entitlements.sh`), **not measured on a device**, and the device
measurement is still the N3 go/no-go. The iOS *simulator* does have the JIT (it
is a Mac process), so simulator numbers are an upper bound and never the answer.
Evidence, citations and the device invocation are in
`apple/Spikes/JSCPerf/README.md`.

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

**Line endings are never normalised.** The mirror holds `\r\n` and lone `\r`
exactly as the document has them. A normalising mirror reported `x` on line 2 of
`a\r\nb` as `{from: 2, to: 3}`, which against the real storage deletes the `\n`
of the CRLF rather than the `b`; both sides have to be indexing the same string.
Text vim inserts itself (`o`, `O`, `<CR>`) takes the nearest line's ending, which
is what `fileformat` means in vim, so a CRLF document does not end up mixed.

**Text input comes from the text view, not from key names.** A `keyDown` event
carries one key name; real input does not — NFD arrives as a base letter plus a
combining mark, an emoji as several scalars, a dead key as a composition, an IME
as marked text rewritten before it commits. So the engine runs with
`setExternalInput(true)`: it declines printable keys in insert mode, and
`BlockCaretTextView` routes `insertText(_:replacementRange:)` back through
`VimTextViewAdapter.insertText`, which is one transaction — the mirror, the
edit, and the change the core needs for `.` to replay it. **A custom text view
must forward `insertText(_:replacementRange:)` the same way.** IME composition is
the exception: AppKit owns the storage while marked text is up, and the adapter
resyncs when it ends.

**Replay is transactional.** The engine has already committed every edit to its
mirror by the time the journal arrives, so a partial replay leaves the two
disagreeing and every later range pointing at the wrong text. If a delegate
vetoes a change or a range does not fit the document, the adapter stops, resyncs
the engine *from the storage*, and reports `VimReplayFailure` through
`onReplayFailure`. Surface it; do not swallow it.

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
- `undoManager.groupsByEvent` must be off **for our own writes and only those**.
  It groups per run-loop pass, and with no run loop turning it swallows a whole
  session into one group — but leaving it off breaks IME, because
  `setMarkedText` reaches `-[NSUndoManager _prepareEventGrouping]` through
  AppKit's coalescing path, which raises when event grouping is disabled. The
  adapter turns it off around the batch and restores it afterwards.

**The caret after `u` is vim's, not the undo manager's.** Vim puts it at the
start of the change it restored; `NSUndoManager` restores whatever selection it
recorded, which in the spike's proof was two lines away. `performHistory`
derives it as the first offset at which the two versions differ, which needs no
cooperation from whoever owns undo — the same derivation `RectoHistory` will use
from its own patch.

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
- `getTokenTypeAt` returns `""` (no syntax tree), so `%` matches brackets inside
  strings, and the `it`/`at` tag objects do nothing.
- `<C-q>` is an alias for `<C-v>` upstream — "looks unbound" is not unbound.

`r` is the one action this package **replaces** rather than adapts
(`Vim.defineAction`), because upstream computes both its range and its resulting
caret in code units and there is no way to correct the caret afterwards — "one
character before the end" is character arithmetic, not an offset mapping. The
replacement counts grapheme clusters and is otherwise upstream's behaviour,
including clamping a too-large count to the end of the line. It is the first
thing to re-check on an upstream bump.

## Tests

`RectoVimTests` runs `packages/recto-vim-js/fixtures/keystroke-suite.json` —
143 cases, 21 of them grapheme cases and 6 CRLF — twice: once headless through
`JSContext`, and once replayed through a real `NSTextView`, asserting the storage
stays byte for byte equal to the engine's mirror. The text-view pass drives keys
the way `keyDown` does, so everything vim declines goes through the real
`insertText` path rather than a synthetic one. `AdapterContractTests` covers what
is not a keystroke: CRLF replay, NFD, emoji and ZWJ input, an IME composition,
dot-repeat through the input system, a vetoing delegate, an out-of-bounds range,
the undo caret, and the `gj`/`gk` goal column across a soft wrap. The same
fixture file runs in Bun (`bun run vim:test`), so a case that passes there and
fails here is a bridge bug, which is a much smaller place to look.

`RectoVimPerfTests` and `RectoCoreJSPerfTests` are opt-in
(`RECTO_VIM_PERF=1`, `RECTO_CORE_PERF=1`) and measure CPU time, not wall clock —
the spike saw wall-clock p99 swing 0.5 ms → 42 ms across runs of identical code
purely because of other work on the machine.
