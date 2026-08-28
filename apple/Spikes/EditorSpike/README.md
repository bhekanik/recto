# EditorSpike (plan 023, N0b)

Throwaway harness that measures `nodes-app/swift-markdown-engine` — forked to
[`bhekanik/swift-markdown-engine`](https://github.com/bhekanik/swift-markdown-engine),
pinned at revision `08ff3c07b198ed639f595d0279ebac62c0410bc7` — as the base of
`RectoEditor`. Not shipping code; the branch is not meant to be merged.

## Run it

```sh
cd apple/Spikes/EditorSpike
./measure.sh report.txt          # build Release + full measurement run
```

or by hand:

```sh
swift build -c release
./.build/release/EditorSpike measure "$PWD/Corpus"    # the benchmark
./.build/release/EditorSpike open Corpus/load-10k.md  # look at it in a window
./.build/release/EditorSpike mem Corpus/load-10k.md   # footprint of one document
```

`xcodebuild -scheme EditorSpike -destination 'platform=macOS' -configuration Release build`
works too; the package is the project.

Environment knobs: `SPIKE_WINDOW=1600x1200` (window size — a taller window draws
more lines per frame, which is how the scroll numbers were checked for actually
including the draw), `SPIKE_NOSPELL=1` (turn the system spell/grammar checker
off), `SPIKE_HOLD=1` (keep `mem` alive so `vmmap` can attribute the footprint).

## What it measures

The measurement drives the real AppKit path — synthesised `NSEvent`s through
`NSWindow.sendEvent`, not `insertText:` — and forces the viewport to lay out and
draw before the clock stops. `Measure.swift` is the whole protocol:

- every corpus case opened, timed, and checked for the losslessness invariant
  (the engine must hand back the exact string it was given);
- a dialect probe that prints what the reader actually sees, marking every
  character the styler hid — this is how the unsupported constructs were found;
- proof that markers hide and reveal (font size on the marker characters with
  the caret away from the block, then inside it);
- typing latency in three places, keystroke → drawn;
- marker reveal/hide latency on caret moves;
- caret stability: does the selection land where it was asked, does the caret
  rect at a fixed probe move when markers reveal elsewhere, does `→` visit every
  hidden marker character;
- scroll frame time through the whole document, three ways;
- footprint, sampled at the load-time peak and again after it settles.

## Corpus

`Corpus/` is generated, not hand-written — regenerate with:

```sh
bun apple/Spikes/EditorSpike/Tools/make-corpus.ts
```

It writes the 24 canonical cases from `lib/markdown/corpus/cases.ts` as `.md`
files plus `load-10k.md`, a deterministic 10,145-word document built from the
same vocabulary with headings, nested lists, task lists, blockquotes, code
blocks, tables, images, links and emphasis.
