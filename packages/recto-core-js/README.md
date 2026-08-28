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
| `htmlFromMarkdown` | `(md: string) => string` | `lib/preview/render.ts` — the **sanitized** preview pipeline |
| `markdownFromHtml` | `(html: string) => string` | smart paste; rehype-parse, no DOM |
| `lint` | `(md: string, categories?: string[]) => Promise<LintIssue[]>` | see below |
| `streak` | `(days: {date,words}[], today: string) => number` | dates are local `"YYYY-MM-DD"` |

`htmlFromMarkdown` is the preview renderer, not `lib/export/html.ts`. The export
pipeline is deliberately unsanitized and reads `window.location.origin` to
absolutize URLs, so it is not part of the core; the export flow stays on the web
until a native exporter needs it.

`lint` categories are `"passive" | "readability" | "adverb" | "weasel"`. Omitting
the argument (or passing `null`) enables all of them; passing `[]` enables none
and returns no issues. An unknown name throws.

### Errors

Everything throws a JS `Error`/`TypeError` on bad input — nothing returns an
error value. Install a `JSContext.exceptionHandler`, or check
`context.exception` after each call and clear it before the next one; a call
that threw returns `undefined`, which would otherwise be compared against a
fixture as if it were a result. Wrong argument types are rejected at the
boundary with a message naming the call (`RectoCore.normalize: markdown must be
a string`) rather than failing somewhere inside remark.

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

| | bundle in Bun | bundle in `JSContext` |
|---|---|---|
| load (`evaluateScript`) | — | 20 ms |
| smallest calls (≤ 1 kB doc) | < 0.1 ms | 0.7 ms |
| 927 kB prose document | 460 ms | ~9,000 ms |
| 928 kB adversarial document¹ | 5,300 ms | ~24,000 ms |

¹ the corpus concatenated to size: thousands of duplicate footnote and
link-reference definitions, which remark resolves super-linearly. `core:parity`
`--bench` uses a 250 kB version of it, since it is about shape rather than scale.
The Bun column is the same bundle loaded as a script; `lib/` imported directly
as ES modules is another ~1.5× faster again (313 ms on the prose document).

Cost is linear in document size at roughly **9 ms per kB** of markdown per
whole-document call in `JSContext` (48 kB → 440 ms, 244 kB → 2.2 s, 488 kB →
4.5 s).

The JIT is running: a 10⁸-iteration add loop takes 468 ms in the `JSContext`
(4.7 ns/iteration — an interpreter would be tens of seconds). The same loop is
180 ms in Bun, so the engine gap on pure compute is only ~2.6×; the rest of the
20× on this workload is string and object churn, which Bun's much newer
JavaScriptCore handles better than the system framework. Setting `JSC_useJIT=0`
or `JSC_forceRAMSize` changed nothing — the system framework appears to ignore
`JSC_*` option environment variables, so neither is a tuning knob.

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
