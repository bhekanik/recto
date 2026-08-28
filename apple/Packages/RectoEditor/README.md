# RectoEditor

Recto's Markdown editor for macOS. TextKit 2 only. The Markdown string is the
document — there is no parallel model, and syntax markers are hidden rather than
removed, so selection, copy, find and undo all operate on real source text.

The styling and layout engine is a fork of
[`nodes-app/swift-markdown-engine`](https://github.com/nodes-app/swift-markdown-engine),
Apache-2.0, at
[`bhekanik/swift-markdown-engine`](https://github.com/bhekanik/swift-markdown-engine)
on branch `recto`, pinned by revision in `Package.swift`. Parser and dialect
work lands in the fork. This package is Recto's *configuration* of it: the type
scale, the colour slots, the three presentations, and the document-scoped
storage that `DocumentSession` drives.

## Using it

```swift
let storage = RectoTextStorage(documentId: document.id, markdown: document.markdown)
storage.onEdit = { mutation in undoTree.record(mutation) }

var styler = MarkdownStyler(presentation: .rich, theme: .twilight)

RectoEditorView(storage: storage, styler: styler)
```

Switching lens:

```swift
styler = styler.presenting(.raw)   // keeps the reader's text-size setting
```

Applying someone else's edit — a sync change, a history jump, a canonicalisation
pass — never by assigning the whole string to the text view:

```swift
storage.apply(MarkdownTextPatch(range: range, replacement: text))
// or, equivalently, assign and let the storage diff it:
storage.markdown = canonicalised
```

Reaching the AppKit layer (find, a key layer, typewriter scroll, a
caret-anchored popover):

```swift
let seam = storage.textView          // RectoTextView
seam.nsTextView                      // the live NSTextView
seam.scrollView                      // NSTextFinderBarContainer
seam.textLayoutManager               // TextKit 2 only; layoutManager is never touched
seam.caretRect()
```

## The pieces

| Type | What it is |
| --- | --- |
| `Presentation` | `.rich`, `.raw`, `.preview`. `.vim` is reserved until the N0c spike reports. |
| `MarkdownStyler` | Recto's opinion in one value; `engineConfiguration()` turns it into the engine's `MarkdownEditorConfiguration`. Nothing else should build one by hand. |
| `RectoTypography` | The design plan's two scales: prose (Source Serif 4, 19 pt) and source (JetBrains Mono, 17.5 pt), both at 1.6 line height, headings 1.7/1.42/1.22/1.08/1/1 em at 700, tracking −0.015 em. `scale` is the reader's text-size control, clamped 0.8–2.0. |
| `RectoEditorTheme` | Semantic colour slots — `canvas`, `sheet`, `raised`, `ink`/`ink2`/`ink3`, `line`, `accent`, `accent2`, `selection`, `caret` — with Twilight (dark) and Paper (light) defaults converted from the design plan's OKLCH values. When `packages/design-tokens` ships `RectoTokens.swift`, the Mac app maps those into this and the defaults become the fallback for tests and previews. |
| `RectoTextStorage` | One open document: the string, the frontmatter, the edit path, and (through the engine) one `NSTextContentStorage`. One instance per document, not per view — two windows on the same document share it. |
| `RectoTextView` | The AppKit seam. A facade over the engine's `MarkdownEditorController`, not an `NSTextView` subclass: the engine builds and owns the text view because it needs its own TextKit 2 stack and layout-fragment subclass. |
| `RectoEditorView` | The SwiftUI view. Composes the engine's `NativeTextViewWrapper` (which is the `NSViewRepresentable`) rather than re-implementing it. |
| `Frontmatter` | The leading `---` block as data for the document header. Top-level scalar keys only — full YAML is the canonical parser's job. |
| `RectoFonts` | Registers the bundled Source Serif 4 and JetBrains Mono faces with the process at first use. Both SIL OFL 1.1; the licences ship in `Resources/Fonts`. |

## Presentations

**Rich.** Markdown rendered in place. Markers hide except on the block or the
inline run the caret is in — heading `#`s reappear when the caret enters the
heading line, `**` when it enters that emphasis run, and revealing an outer span
reveals everything nested in it. Bullets, ordered numbers and task boxes are
drawn in an `NSTextLayoutFragment` subclass; the authored characters stay in the
string, kerned to zero width. Tables render as a cached bitmap over collapsed
source, and the pipes come back when the caret enters the table (plan §0b took
this over the design's overlay views for v1).

**Raw.** The source, monospace, no hiding and no styling. Smart input is off —
what you type is what the file gets.

**Preview.** Rich with editing off. The engine passes no caret location to the
styler when the view is not editable, so every marker in the document stays
hidden and the caret is not drawn. Selection and copy still work.

## Testing

```sh
swift test                                    # everything except perf
RECTO_UPDATE_SNAPSHOTS=1 swift test --filter Corpus   # re-record the snapshots
RECTO_RUN_PERF=1 swift test --filter Perf -c release  # measure
```

`Tests/RectoEditorTests/Corpus/` holds the 24 canonical dialect cases from
`lib/markdown/corpus/cases.ts`, written out by
`Tools/make-corpus.ts` (`bun apple/Packages/RectoEditor/Tools/make-corpus.ts`).
Regenerate them whenever a case changes. When
`packages/editor-fixtures/markdown-corpus.json` (W3) lands, point the script at
that instead; the output contract stays.

`Tests/RectoEditorTests/Snapshots/` holds, per case, what the reader actually
sees in each presentation: `·` for a character the styler hid, `⏎` for a
newline, plus a compact per-run style summary. **That diff is the review of the
rendering rules** — a change to what is hidden or how something is set shows up
as readable text rather than an attribute dictionary.

The perf suite is opt-in on purpose. Wall-clock thresholds are a property of the
machine, and a shared runner would make them flaky enough to teach people to
ignore red. It measures parse → style → apply, not keystroke-to-pixels; the N0b
spike measured the drawing half end to end and is the reference for it.

## Engine behaviour worth knowing

- **Never touch `layoutManager`.** One reference to the TextKit 1 property drops
  the whole editor into compatibility mode. The engine has none, uses no
  `NSTextTable`, and `RectoTextView` exposes only `textLayoutManager`.
- **The styler's parser is not the canonical parser.** It computes attribute
  ranges. Nothing it gets wrong can change what is persisted; canonicalisation
  is `serialize(parse(md))` in RectoCoreJS on commit boundaries, applied as a
  patch when it differs.
- **External edits go through `applyPatch`, never through the string.**
  Assigning `textView.string` rebuilds the whole storage, and AppKit resets the
  selection to `{0, 0}` on that assignment — the caret lands at the top of the
  document. `RectoTextStorage` routes every external change through the fork's
  `MarkdownEditorController.applyPatch`, which runs the engine's own
  `shouldChangeText → replaceCharacters → didChangeText` path: only the touched
  paragraphs restyle, and the caret is transformed through the edit.
- **Recto owns undo.** `MarkdownStyler` sets the engine's undo policy to
  `.external`, so the text view registers nothing and ⌘Z reaches Recto's undo
  tree. External patches are additionally bracketed in
  `disableUndoRegistration()`, so someone else's edit can never become a local
  undo step.
- **`onEdit` is the edit feed.** Every accepted edit arrives as a
  `MarkdownTextMutation` (a UTF-16 range plus its replacement) in display
  coordinates. Multi-step smart-input transformations and ambiguous IME batches
  are deliberately omitted, so every callback is exact.
- **The engine lays out the whole document on open**, not just the viewport — it
  needs the content height for overscroll. That is most of the open cost and of
  the transient memory peak. Re-measure at the plan's 950 kB ceiling before
  assuming it scales.
- **`NSTextView.scrollRangeToVisible` can kill the process** on large TextKit 2
  documents. Anything that scrolls must go through fragment geometry instead.
  Stage 2 overrides it.
- **TextKit 2 returns estimated fragment heights** for content it has not laid
  out, so any scroll target computed from geometry above the caret needs settle
  passes (`layoutViewport()`, re-measure, up to three times).
- **Focus dimming cannot use `setRenderingAttributes`.** Task boxes, ordered
  numbers and table bitmaps are drawn by the fragment; a colour attribute cannot
  recolour them. Stage 2 wraps the fragment draw in a CGContext transparency
  layer.

## What stage 2 (W9b) adds

Images with captions through an `NSTextAttachmentViewProvider`; the code-block
language tag; the slash menu; the selection format bar; find
(`NSTextFinder`); typewriter scrolling with settle passes and the
`scrollRangeToVisible` override; focus dimming via the fragment transparency
layer; smart paste (HTML → Markdown); image upload on drop and paste; comment
and lint decorations; and the undo-tree integration that consumes `onEdit` and
drives `applyPatch` for undo and redo.

`.vim` joins `Presentation` after the N0c spike; it is a key-handling layer over
`.raw`, not a fourth rendering path.
