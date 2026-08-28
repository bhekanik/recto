#!/bin/bash
#
# Runs the same binary in the two signing configurations that decide whether
# JavaScriptCore gets a JIT on macOS, plus the system `jsc` shell with the JIT
# explicitly off — which is the regime an iPhone runs in.
#
#   apple/Spikes/JSCPerf/measure.sh
#
# Requires `bun run core:build` first.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
bundle="$repo/packages/recto-core-js/dist/recto-core.js"
jsc="/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc"

[ -f "$bundle" ] || {
	echo "error: $bundle is missing — run \`bun run core:build\`" >&2
	exit 1
}

swift build -c release --package-path "$here" >/dev/null
binary="$here/.build/release/jsc-perf"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "=== hardened runtime, NO com.apple.security.cs.allow-jit ==="
echo "    (what an unentitled app gets, and the regime iOS is permanently in)"
cp "$binary" "$work/no-jit"
codesign --force --sign - --options runtime "$work/no-jit" 2>/dev/null
"$work/no-jit" "$bundle"

echo
echo "=== hardened runtime WITH com.apple.security.cs.allow-jit ==="
echo "    (what the Mac app must ship)"
cp "$binary" "$work/jit"
codesign --force --sign - --options runtime \
	--entitlements "$here/allow-jit.entitlements" "$work/jit" 2>/dev/null
"$work/jit" "$bundle"

# The API path and `jsc --useJIT=false` agreeing is what says the unentitled
# number really is the interpreter, rather than a slow JIT tier.
if [ -x "$jsc" ]; then
	echo
	echo "=== system jsc shell, cross-check ==="
	echo "--- --useJIT=false (should match the unentitled run above) ---"
	"$jsc" --useJIT=false "$here/jsc-bench.js" -- "$bundle"
	echo "--- JIT on (should match the entitled run above) ---"
	"$jsc" "$here/jsc-bench.js" -- "$bundle"
fi
