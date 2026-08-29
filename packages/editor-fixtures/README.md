# editor-fixtures

The parity corpus the web tests and the native ports both run (plan 023 §2).
Generated from `lib/` — **never edit the JSON by hand**:

```sh
bun run fixtures:build
```

They are excluded from `biome check` (`biome.json`): Biome collapses short JSON
arrays onto one line and `JSON.stringify` does not, so a formatted file and a
regenerated one would fight each other forever.

`fixtures.test.ts` regenerates in memory and fails if a committed file differs,
so a behaviour change in `lib/` surfaces as an explicit fixture diff instead of a
silent web/native divergence. It also re-runs `lib/` over the committed JSON, so
each domain fails with a message naming the function rather than "the blob
changed".

| File | Source | Contract |
|---|---|---|
| `markdown-corpus.json` | `lib/markdown/corpus/cases.ts` + `lib/markdown` | `cases`: the 24 round-trip cases with `normalized`, `words`, `outline` and the frontmatter bytes. `normalize(input) === normalized` and `normalize(normalized) === normalized` (the 25th corpus gate). `unicode`: 10 more cases in the same shape, for the traps a byte contract has — see below. |
| `word-count.json` | `lib/markdown/count-words.ts` | markdown in, prose word count out |
| `outline.json` | `lib/outline/extract.ts` | markdown in, `{depth, text, offset, index}[]` out |
| `streak.json` | `lib/stats/streak.ts` | `{date, words}[]` plus a local `"YYYY-MM-DD"` `today`, and the streak length. `today` is a calendar key, so a port must step back a calendar day rather than subtract 86,400,000 ms from an instant — the month-boundary case catches that. |
| `history-patches.json` | `lib/history/{patch,materialize}.ts` | `computePatch`/`encodePatch`/`applyPatch` round trips, and `materialize` chains including snapshot boundaries. `snapshotEveryN` is the production cadence. |
| `diff-runs.json` | `lib/history/diff.ts` (mirrored in `convex/history.ts`) | runs, hunk grouping and the merged markdown for accepted-hunk subsets, at both granularities |
| `slash-entries.json` | `lib/editor/milkdown/slash-entries.ts` | the 17 stable IDs in menu order, with labels, aliases, and the insertion operation the web runtime executes |

## Comparing strings

Offsets and patch indices are **UTF-16 code-unit** offsets, the same units
JavaScript strings and `NSString` use. A Swift port must index with
`String.Index`/`utf16` rather than `Character` counts — `history-patches.json`
carries an emoji case that fails if it does not.

Compare strings the same way. Swift's `String ==` is canonical equivalence
(`"e\u{301}" == "é"` is `true`), so it would accept NFD output where the web
produced NFC; use `a.utf16.elementsEqual(b.utf16)`. The first two entries of
`markdown-corpus.json`'s `unicode` array are exactly that pair, and the parity
spike asserts they are canonically equal and byte-different, so a port that
weakens the comparison fails on the harness's own self-check rather than
silently passing. The rest of the array covers ZWJ emoji, regional-indicator
flags, skin-tone modifiers, astral-plane surrogate pairs, CRLF input,
trailing-newline variants, NBSP and zero-width space.

Every string in these files is well-formed UTF-16: `build.ts` refuses to emit a
lone surrogate, because `JSON.stringify` writes it as a `\udXXX` escape that
`JSONDecoder` rejects — which would fail the whole file, not just that case.

Case inputs live in `src/cases.ts`. Where a web test already asserted a concrete
value, that value is repeated there as `expect*` and the generator fails if
`lib/` disagrees, so the hand-written expectation is not quietly replaced by
whatever the code happens to return today.
