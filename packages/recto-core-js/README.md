# recto-core-js

The DOM-free half of `lib/`, bundled as one IIFE that the native apps load into
a `JSContext` (plan 023 D-N3, §1.5). It is the same code the web runs, so
losslessness is a property of the build, not of two implementations agreeing.

```sh
bun run core:build            # → dist/recto-core.js + manifest.json (sha256)
bun run core:parity           # fixtures in a DOM-free realm, then in a real JSContext
bun run core:parity --bench   # …and the whole-document timings below (~1 min)
```

CI runs `core:parity` without `--bench`: the parity checks and the small-call
timing take about a second, while the ~950 kB benchmarks take tens of seconds
and are noise on a shared runner. The numbers below are the record.

`dist/` and `manifest.json` are build output and are not committed. The Xcode
copy-resources script compares the copied bundle's sha256 against
`manifest.json` and fails on a mismatch.

## API

Evaluating the bundle defines one global, `RectoCore`:

| Member | Signature | Notes |
|---|---|---|
| `version` | `string` | `<package version>+<git short sha>` of the build |
| `normalize` | `(md: string) => string` | `serialize(parse(md))` with `CANONICAL_STRINGIFY` — the only MDAST↔string crossing |
| `countWords` | `(md: string) => number` | prose words, markdown syntax excluded |
| `parseOutline` | `(md: string) => { depth, text, offset, index }[]` | flat, document order; `offset` is a UTF-16 index into `md` |
| `findFlags` | `(md: string) => { from, to, tokenFrom, note }[]` | writing flags in document order; UTF-16 offsets, `from` includes a line-start guard |
| `htmlFromMarkdown` | `(md: string) => string` | `lib/preview/render.ts` — the **sanitized** preview pipeline |
| `markdownFromHtml` | `(html: string) => string` | smart paste; rehype-parse, no DOM |
| `lint` | `(md: string, categories?: string[]) => Promise<LintIssue[]>` | see below |
| `streak` | `(days: {date,words}[], today: string) => number` | dates are local `"YYYY-MM-DD"` and are validated |

`htmlFromMarkdown` is the preview renderer, not `lib/export/html.ts`. The export
pipeline is deliberately unsanitized and reads `window.location.origin` to
absolutize URLs, so it is not part of the core; the export flow stays on the web
until a native exporter needs it.

`lint` categories are `"passive" | "readability" | "adverb" | "weasel"`. Omitting
the argument (or passing `null`) enables all of them; passing `[]` enables none
and returns no issues. An unknown name throws.

`streak` validates every record: `date` and `today` must match `YYYY-MM-DD` and
`words` must be a finite number. That is not ceremony — the streak walk steps
backwards by string key, so a malformed key matches nothing and would quietly
return a streak of 0 instead of failing.

### Errors

Everything throws a JS `Error`/`TypeError` on bad input — nothing returns an
error value. Install a `JSContext.exceptionHandler`, or check
`context.exception` after each call and clear it before the next one; a call
that threw returns `undefined`, which would otherwise be compared against a
fixture as if it were a result. Wrong argument types are rejected at the
boundary with a message naming the call (`RectoCore.normalize: markdown must be
a string`) rather than failing somewhere inside remark.

Be equally strict reading results back. `JSValue` coercion is lossy in the
direction that hides bugs: `undefined.toInt32()` is `0`, `undefined.toArray()`
is `nil`, and a dropped malformed element just makes an array shorter — each of
which reads as "empty document" rather than "the bridge is broken". Check
`isString` / `isNumber` / `isArray` and treat `undefined` as an error;
`jsc/Sources/RectoCoreParity/main.swift` shows the shape.

### Comparing strings

Compare results by **UTF-16 code unit**, never with Swift's `String ==`, which
is canonical equivalence: `"e\u{301}" == "é"` is `true`, so `==` would accept
NFD output where the web produced NFC. Use `a.utf16.elementsEqual(b.utf16)`.
`markdown-corpus.json` carries a `unicode` array whose first two entries are
exactly that pair, and the spike asserts they are canonically equal and
byte-different — which fails loudly if the comparison ever weakens. The same
array covers ZWJ emoji, regional-indicator flags, skin-tone modifiers,
astral-plane surrogate pairs, CRLF input, trailing-newline variants, NBSP and
zero-width space.

Fixture strings are guaranteed well-formed: the generator refuses to emit a lone
surrogate, because `JSONDecoder` rejects the `\udXXX` escape `JSON.stringify`
would produce and the whole fixture file would fail to load.

### Threading

The bundle keeps module-level state (frozen unified processors, a memoised
`write-good` import) but no mutable per-call state, so calls are re-entrant
within one context. `JSContext` itself is **not** thread-safe: confine one
context to one queue, or give each queue its own `JSVirtualMachine`. Loading the
bundle costs ~20 ms, so per-queue contexts are affordable; sharing one context
across queues is not.

### `lint` and the microtask queue

`lint` is the one async entry point: `lib/lint/analyze.ts` imports `write-good`
lazily (its transitive `adverb-where` builds a RegExp from concatenated template
literals, which minifiers have corrupted). The import target is inside the
bundle, so the promise is already resolved by the time it is returned. JSC
drains the microtask queue before returning to native code, which means a `then`
callback registered from Swift has already run when `invokeMethod` returns — no
run-loop spin and no continuation are needed. `jsc/Sources/RectoCoreParity/main.swift`
does exactly this and asserts it.

### Host requirements

A bare `JSContext` is all that is needed, with two caveats the bundle already
handles or the host must know:

- **`console`**: the bundle's prelude installs a no-op `console` if the realm has
  none (`debug`, reached through `write-good`, reads `console.debug` at module
  scope). Install your own before evaluating the bundle to route logging.
- **Strings only**: pass `String`, never `Data`. The vfile path that would decode
  bytes uses `TextDecoder`, which a bare `JSContext` does not have.

No DOM, `fetch`, timers or storage are used on any API path — `bun run
core:parity` proves it by running every entry point in a realm that has none.

## Performance (measured 2026-08-28, M-series Mac, macOS 26 / Xcode 26.6)

Every number here is one `bun run core:parity --bench` run on an idle machine —
same bundle, same document bytes, both realms. `normalize` is quoted;
`countWords` and `parseOutline` are within a few percent of it throughout.

| document | `node:vm` realm (Bun) | `JSContext` (Swift) | ratio |
|---|---|---|---|
| load (`evaluateScript`) | — | 23.7 ms | |
| 106 B corpus case | < 0.1 ms | 0.75 ms | |
| 63 kB prose | 103 ms | 616 ms | 6.0× |
| 250 kB prose | 393 ms | 2,459 ms | 6.3× |
| 500 kB prose | 787 ms | 4,966 ms | 6.3× |
| 928 kB prose | 1,492 ms | 9,316 ms | 6.2× |
| 245 kB adversarial¹ | 1,247 ms | 5,160 ms | 4.1× |

¹ the corpus concatenated to size: thousands of duplicate footnote and
link-reference definitions, which remark resolves super-linearly. Kept at 250 kB
because it is about shape, not scale.

Cost is linear in document size: **~10 ms per kB** of markdown per
whole-document call in `JSContext` (9.9, 9.8, 9.9 and 10.0 ms/kB across the four
prose sizes), against ~1.6 ms/kB in the `node:vm` realm. The engine gap is a
steady **~6×**, not the 20× an earlier draft of this table claimed — that number
came from a one-off run that `import`ed the bundle as a module under Bun instead
of evaluating it in a realm, which is not what the harness or the app does.

The JIT is running: a 10⁸-iteration add loop takes 468 ms in a `JSContext`
(4.7 ns/iteration — an interpreter would be tens of seconds), against 180 ms in
Bun. So ~2.6× of the ~6× is raw engine speed and the rest is string and object
churn, which Bun's much newer JavaScriptCore handles better than the system
framework. (That loop is a one-off measurement, not part of the harness.)
Setting `JSC_useJIT=0` or `JSC_forceRAMSize` changed nothing — the system
framework appears to ignore `JSC_*` option environment variables, so neither is
a tuning knob. Marshalling is not the cost either: handing a Swift `String` to a
JS function costs 0.015 ms at 244 kB and 0.051 ms at 927 kB, four orders of
magnitude below the call itself.

**Unverified and worth measuring before N3 commits:** in-process JavaScriptCore
on iOS has historically had no JIT for third-party apps (the entitlement is
WebKit's). If that still holds on iOS 26, these numbers get dramatically worse on
iPhone/iPad and only the "small documents, at boundaries" shape survives. Measure
on a device early.

**Consequence for callers**: these are not "small sync calls" for long
documents. Call them off the main thread, debounce them, and treat whole-document
`normalize`/`countWords`/`parseOutline` as an operation you do on open, paste and
save — not per keystroke. Incremental word/outline updates on the Swift side, with
the JS core as the authority at document boundaries, is the shape that fits these
numbers.

## Fixtures

`packages/editor-fixtures/*.json` is the shared parity corpus, generated from
`lib/` by `bun run fixtures:build` and guarded by a stale-check test. Native
ports run the same JSON.
