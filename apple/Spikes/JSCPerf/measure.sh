#!/bin/bash
#
# Runs the same binary in the two signing configurations that decide whether
# JavaScriptCore gets a JIT on macOS, plus the system `jsc` shell with the JIT
# explicitly off — which is the regime an iPhone runs in.
#
#   apple/Spikes/JSCPerf/measure.sh [processes]
#
# Each configuration runs in several **fresh processes** (default 3), because a
# process that has already normalized a document is a different machine from one
# that has not, and only a new process can produce a cold engine. Within a
# process the sizes are re-shuffled each round and the report carries median and
# p95 — see `JSCPerfCore` for why a single fixed-order sample per size measures
# the engine tiering up rather than the document.
#
# Requires `bun run core:build` first.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
bundle="$repo/packages/recto-core-js/dist/recto-core.js"
jsc="/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc"
processes="${1:-3}"

[ -f "$bundle" ] || {
	echo "error: $bundle is missing — run \`bun run core:build\`" >&2
	exit 1
}

swift build -c release --package-path "$here" >/dev/null
binary="$here/.build/release/jsc-perf"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

run_configuration() {
	local label="$1" path="$2"
	echo
	echo "=== $label ==="
	for run in $(seq 1 "$processes"); do
		echo "--- fresh process $run/$processes"
		"$path" "$bundle"
	done
}

cp "$binary" "$work/no-jit"
codesign --force --sign - --options runtime "$work/no-jit" 2>/dev/null
run_configuration \
	"hardened runtime, NO com.apple.security.cs.allow-jit
    (what an unentitled app gets, and the regime iOS is permanently in)" \
	"$work/no-jit"

cp "$binary" "$work/jit"
codesign --force --sign - --options runtime \
	--entitlements "$here/allow-jit.entitlements" "$work/jit" 2>/dev/null
run_configuration \
	"hardened runtime WITH com.apple.security.cs.allow-jit
    (what the Mac app must ship)" \
	"$work/jit"

# The API path and `jsc --useJIT=false` agreeing is what says the unentitled
# number really is the interpreter, rather than a slow JIT tier.
if [ -x "$jsc" ]; then
	echo
	echo "=== system jsc shell, cross-check ==="
	echo "--- --useJIT=false (should match the unentitled runs above) ---"
	"$jsc" --useJIT=false "$here/jsc-bench.js" -- "$bundle"
	echo "--- JIT on (should match the entitled runs above) ---"
	"$jsc" "$here/jsc-bench.js" -- "$bundle"
fi
