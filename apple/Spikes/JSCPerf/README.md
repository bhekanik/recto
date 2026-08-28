# JSCPerf — how fast is the JS core, and on what

The N3 go/no-go (plan 023 §1.5, orchestration §0b): **50 kB `normalize` under one
second on an iPhone.** This measures it, and in getting there it found that the
number the plan was budgeting against was measuring the wrong thing.

```sh
bun run core:build
apple/Spikes/JSCPerf/measure.sh                          # macOS, both signings
xcodebuild test -scheme JSCPerf \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro'   # simulator
```

## The finding: `com.apple.security.cs.allow-jit` is worth 13×

A hardened-runtime macOS process that does not carry
`com.apple.security.cs.allow-jit` cannot map JIT pages, so JavaScriptCore runs
the LLInt interpreter. Nothing reports this — no API, no warning, no crash — it
just runs an order of magnitude slower.

Measured 2026-08-28, M-series, macOS 26 / Xcode 26.6, the same
`dist/recto-core.js` in all four columns:

| document | JSContext, no entitlement | JSContext, `allow-jit` | `jsc --useJIT=false` | `jsc` |
|---|---|---|---|---|
| 10⁸ add loop | 490 ms | **79 ms** | 936 ms | 134 ms |
| load (`evaluateScript`) | 20.8 ms | 18.5 ms | 16 ms | 15 ms |
| 8 kB | 89.7 ms | **21.6 ms** | 88 ms | 19 ms |
| 50 kB | 525.0 ms | **53.6 ms** | 519 ms | 45 ms |
| 64 kB | 669.4 ms | **51.9 ms** | 662 ms | 49 ms |
| 250 kB | 3244.8 ms | **731.5 ms** | 2566 ms | 167 ms |
| per kB | 10.4–13.0 ms | 0.8–2.9 ms | 10.3–11.0 ms | 0.7–2.4 ms |

The unentitled column and `jsc --useJIT=false` agree to within noise at every
size. That is the cross-check that makes the claim safe: the unentitled process
is not on a slow JIT tier, it has no JIT at all.

**Consequences:**

1. **Plan §1.5's "~10 ms per kB in the system `JSContext`" is the
   interpreter-only figure.** With the entitlement it is ~1 ms/kB, which is
   *faster* than Bun's `node:vm` realm on the same bundle (~1.6 ms/kB). The
   engine was never the problem.
2. **Plan §2's Mac entitlement list is missing `com.apple.security.cs.allow-jit`.**
   It lists `app-sandbox`, `network.client` and
   `files.user-selected.read-write`. Without the JIT exception, opening a 250 kB
   document costs 3.2 s instead of 0.7 s. It is a hardened-runtime exception,
   not a sandbox escape, and Mac App Store apps may ship it.
3. **Swift⇄JS string marshalling is not a factor.** A 50 kB document built
   inside JavaScript and normalized from JavaScript costs the same as one handed
   in as a Swift `String` (520 ms unentitled, 38 ms entitled). The bridge is not
   where the time goes.

`JSC_useJIT=0` and friends are ignored by the system framework, and the hardened
runtime flag alone changes nothing — only the entitlement does. The `jsc` shell
inside the framework *does* honour `--useJIT=false`, which is what makes the
cross-check above possible.

## iOS: no entitlement exists, so the interpreter is permanent

Third-party in-process JavaScriptCore on iOS has no JIT, on 17, 18 and 26 alike.
This is in WebKit's own source, not folklore — `isJITEnabled()` in
`Source/JavaScriptCore/jit/ExecutableAllocator.cpp` gates on
`processHasEntitlement("dynamic-codesigning")` or
`com.apple.developer.cs.allow-jit` under `HAVE(IOS_JIT_RESTRICTIONS)`, and
`Source/JavaScriptCore/Scripts/process-entitlements.sh` only grants the latter to
Apple's own WebContent targets, paired with the private
`com.apple.private.verified-jit`. The mechanism landed in March 2024 (bug 270723,
the EU-DMA browser-engine work) and has not changed since. BrowserEngineKit and
`com.apple.developer.embedded-web-browser-engine` are EU/Japan-gated, approval-only,
and are about hosting an *alternative* engine — the wrong shape for an app that
just wants its own scripting to be fast.

**The simulator has the JIT** — `HAVE_IOS_JIT_RESTRICTIONS` is explicitly not
defined for `PLATFORM(IOS_FAMILY_SIMULATOR)` in `wtf/PlatformHave.h`, because a
simulator process is an ordinary Mac process. Measured on the iOS 26.2 simulator
(iPhone 17 Pro), 2026-08-28:

```
JIT probe   10^8 add loop: 99 ms  →  JIT is running
load        evaluateScript: 174.5 ms
normalize   8 kB     55.7 ms  (6.8 ms/kB)
normalize   50 kB     61.4 ms  (1.2 ms/kB)
normalize   64 kB     66.3 ms  (1.0 ms/kB)
normalize   250 kB   454.6 ms  (1.8 ms/kB)
```

Those match the entitled Mac column, as they must. **They are not the go/no-go.**

## What a device will show, and how to run it

The device regime is the unentitled column: ~10.4 ms/kB. Scaling that by an
iPhone's single-core deficit against this Mac (roughly 1.3–2×) puts **50 kB at
0.7–1.1 s** — on the budget line, not comfortably inside it. 250 kB would be
4–6 s. That has to be measured, not extrapolated.

BK: to run it on an iPhone,

```sh
xcrun devicectl list devices                    # copy the identifier
cd apple/Spikes/JSCPerf
xcodebuild test -scheme JSCPerf -destination 'id=<UDID>' \
  DEVELOPMENT_TEAM=WAVMJLFY95 \
  CODE_SIGN_STYLE=Automatic
```

The test reads `packages/recto-core-js/dist/recto-core.js` by absolute path,
which works in the simulator but **not** on a device — for a device run, copy the
bundle into the test target's resources first, or paste the four numbers from a
`jsc-perf` run into a scratch app. The simplest path is:

```sh
bun run core:build
cp packages/recto-core-js/dist/recto-core.js \
   apple/Spikes/JSCPerf/Tests/JSCPerfTests/recto-core.js
# add `resources: [.copy("recto-core.js")]` to the JSCPerfTests target
```

Then read the console output of the test run, or

```sh
xcrun devicectl device process launch --device <UDID> --console <bundle-id>
```

Report the `JIT probe` line first: if a device ever prints "JIT is running", this
whole section is obsolete and the numbers get 10× better.

## Layout

```
Sources/JSCPerfCore/   the measurement, shared by every runner
Sources/jsc-perf/      macOS CLI; sign it two ways to see both regimes
Tests/JSCPerfTests/    the same measurement under xcodebuild (simulator, device)
jsc-bench.js           the cross-check, for the system `jsc` shell
allow-jit.entitlements the one key that matters
measure.sh             runs all four columns of the table above
```
