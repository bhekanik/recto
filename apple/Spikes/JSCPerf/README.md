# JSCPerf — how fast is the JS core, and on what

The N3 go/no-go (plan 023 §1.5, orchestration §0b): **50 kB `normalize` under one
second on an iPhone.** This measures it, and in getting there it found that the
number the plan was budgeting against was measuring the wrong thing.

```sh
apple/scripts/copy-js-bundles.sh          # builds the core and stages it here
apple/Spikes/JSCPerf/measure.sh           # macOS, both signings, pooled
xcodebuild test -scheme JSCPerf -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
xcodebuild test -scheme JSCPerf -destination "id=$(xcrun devicectl list devices | …)"
```

**The device run has not happened.** It needs BK's iPhone; there is none on this
machine. Everything else is done — the target compiles for iOS, carries the
bundle as a resource, prints machine-readable samples, and fails the 50 kB
budget when the JIT is off. The last section has the exact command.

## The finding: the JIT entitlement is worth ~14× on macOS

A hardened-runtime macOS process that does not carry
`com.apple.security.cs.allow-jit` cannot map JIT pages, so JavaScriptCore runs
the interpreter. Nothing reports this — no API, no warning, no crash — it just
runs an order of magnitude slower.

**Conditions**, because a performance number without them is a rumour: M-series
Mac, macOS 26 / Xcode 26.6, `swift build -c release`, the same
`dist/recto-core.js` in every column, `measure.sh 2` — two fresh processes per
configuration, five rounds per process, the four sizes reshuffled each round,
and the samples from **all** processes pooled before the median is taken (n=10
per size). Entitlements are printed by each run. The machine was otherwise idle.

| document | JSContext, no entitlement | JSContext, `allow-jit` | ratio | `jsc --useJIT=false` | `jsc` |
|---|---|---|---|---|---|
| 10⁸ add loop | 479 ms | **76 ms** | 6.3× | 976 ms | 151 ms |
| load (`evaluateScript`) | 20.5 ms | 20.1 ms | — | 18 ms | 17 ms |
| 8 kB | 89.4 ms | **7.2 ms** | 12.4× | 88 ms | 6 ms |
| 50 kB | 538.7 ms | **43.9 ms** | 12.3× | 554 ms | 36 ms |
| 64 kB | 702.3 ms | **54.2 ms** | 13.0× | 708 ms | 45 ms |
| 250 kB | 3253.0 ms | **773.2 ms** | 4.2× | 2723 ms | 174 ms |
| per kB | 10.8–13.0 ms | 0.8–3.1 ms | | 10.9–11.1 ms | 0.7 ms |

So: **12–13× between 8 kB and 64 kB, and 4.2× at 250 kB**, where the entitled
run becomes allocation-bound rather than execution-bound. Quoting a single "13×"
without the size is wrong, and an earlier version of this file did.

The unentitled column and `jsc --useJIT=false` agree to within a few percent at
every size. That is the cross-check that makes the claim safe: the unentitled
process is not on a slow JIT tier, it has no JIT at all.

An earlier version of this harness took one sample per size in a fixed order and
reported 64 kB as *faster* than 50 kB — the signature of the engine tiering up
during the run rather than of the documents differing. Hence the reshuffling and
the percentiles. It then printed a separate report per process and called that
an aggregate; `measure.sh` pools the raw `sample …` lines now and takes one
median over all of them. `jsc-bench.js` had the matching problem: its "is the
JIT on" threshold was 3000 ms, so it labelled the 976 ms `--useJIT=false` run as
"JIT" and the cross-check asserted nothing. It is 400 ms now, between the two
measured regimes.

**Consequences:**

1. **Plan §1.5's "~10 ms per kB in the system `JSContext`" is the
   interpreter-only figure.** With the entitlement it is ~0.8 ms/kB up to 64 kB,
   which is *faster* than Bun's `node:vm` realm on the same bundle (~1.6 ms/kB).
   The engine was never the problem.
2. **Plan §2's Mac entitlement list is missing `com.apple.security.cs.allow-jit`.**
   It lists `app-sandbox`, `network.client` and
   `files.user-selected.read-write`. Without the JIT exception, opening a 250 kB
   document costs 3.5 s instead of 0.8 s. It is a hardened-runtime exception, not
   a sandbox escape — `app-sandbox` stays — and Mac App Store apps may ship it.
   It applies to macOS only; there is no iOS equivalent (see below).
3. **Swift⇄JS string marshalling is not a factor.** A 50 kB document built inside
   JavaScript and normalized from JavaScript costs the same as one handed in as a
   Swift `String` (520 ms unentitled, 38 ms entitled). The bridge is not where
   the time goes.

`JSC_useJIT=0` and friends are ignored by the system framework, and the hardened
runtime flag alone changes nothing — only the entitlement does. The `jsc` shell
inside the framework *does* honour `--useJIT=false`, which is what makes the
cross-check above possible.

## iOS: no entitlement exists, so the interpreter is permanent

**This conclusion is source-based, not device-measured.** No iPhone was
available; what follows is read from WebKit's own source, and it is the reason
the device measurement below still has to happen.

`isJITEnabled()` in
[`Source/JavaScriptCore/jit/ExecutableAllocator.cpp`](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/jit/ExecutableAllocator.cpp)
gates the JIT, under `HAVE(IOS_JIT_RESTRICTIONS)`, on the process holding
`dynamic-codesigning` or `com.apple.developer.cs.allow-jit`.
`Source/JavaScriptCore/Scripts/process-entitlements.sh` grants the latter only to
Apple's own WebContent targets, paired with the private
`com.apple.private.verified-jit`. The mechanism landed in March 2024 (bug 270723,
the EU-DMA browser-engine work) and has not changed since. BrowserEngineKit and
`com.apple.developer.embedded-web-browser-engine` are EU/Japan-gated,
approval-only, and are about hosting an *alternative* engine — the wrong shape
for an app that just wants its own scripting to be fast.

**The simulator has the JIT** — `HAVE_IOS_JIT_RESTRICTIONS` is explicitly not
defined for `PLATFORM(IOS_FAMILY_SIMULATOR)` in `wtf/PlatformHave.h`, because a
simulator process is an ordinary Mac process. Measured on the iOS 26.2 simulator
(iPhone 17 Pro), 2026-08-28:

```
JIT probe   10^8 add loop: 99 ms  →  JIT is running
load        evaluateScript: 174.5 ms
normalize   8 kB     55.7 ms
normalize   50 kB    61.4 ms
normalize   64 kB    66.3 ms
normalize   250 kB   454.6 ms
```

Those match the entitled Mac column, as they must. **They are not the go/no-go.**

## What a device will show, and how to run it

If the source reading holds, the device regime is the unentitled column:
~11.3 ms/kB. Scaling that by an iPhone's single-core deficit against this Mac
(roughly 1.3–2×) puts **50 kB at 0.75–1.15 s** — on the budget line, not
comfortably inside it. 250 kB would be 4.5–7 s. That is an extrapolation from an
extrapolation and has to be measured.

### BK: the one command

The bundle is a **test-target resource**, staged by
`apple/scripts/copy-js-bundles.sh`, so nothing reads from the checkout at
runtime and the target runs unmodified on a phone. It is **not committed** — the
version string carries the git sha, so a committed copy names a commit that is
no longer HEAD and a device run would quietly measure it. Stage it first; the
test fails with that exact instruction if you forget.

```sh
apple/scripts/copy-js-bundles.sh                # builds and stages the bundle
xcrun devicectl list devices                    # copy the identifier
cd apple/Spikes/JSCPerf
xcodebuild test -scheme JSCPerf \
  -destination 'id=<UDID>' \
  DEVELOPMENT_TEAM=WAVMJLFY95 CODE_SIGN_STYLE=Automatic
```

What to look at, in order:

1. **`JIT probe`.** If a device ever prints "JIT is running", this whole section
   is obsolete and every number below gets ten times better.
2. **The `sample …` lines.** One per measurement:
   `sample <pid> <size> <kilobytes> <milliseconds> jit=<0|1>`. Paste them into
   `measure.sh`'s aggregator, or just read the median block underneath.
3. **The test result.** When the JIT is off, the suite *fails* if 50 kB p95
   exceeds 1,000 ms — the go/no-go is an assertion, not a number to interpret.
   When the JIT is on it prints a note saying so and skips that assertion, so a
   green simulator run cannot be mistaken for a green device run.

Running it several times gives the fresh-process spread; the harness reshuffles
sizes within each run on its own.

## Layout

```
Sources/JSCPerfCore/       the measurement, shared by every runner
Sources/jsc-perf/          macOS CLI; sign it two ways to see both regimes.
                           `--samples` emits machine-readable lines
Tests/JSCPerfTests/        the same measurement under xcodebuild
Tests/JSCPerfTests/JS/     the bundle, staged as a resource (not committed)
jsc-bench.js               the cross-check, for the system `jsc` shell
allow-jit.entitlements     the one key that matters
measure.sh                 every column of the table above, pooled over N
                           fresh processes
```
