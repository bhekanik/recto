#!/bin/bash
#
# Runs the same binary in the two signing configurations that decide whether
# JavaScriptCore gets a JIT on macOS, plus the system `jsc` shell with the JIT
# explicitly off — which is the regime an iPhone runs in.
#
#   apple/Spikes/JSCPerf/measure.sh [processes]
#
# Each configuration runs in several **fresh processes** (default 3) and the
# samples from all of them are pooled before the median and p95 are taken. A
# process that has already normalized a document is a different machine from one
# that has not, so only a new process gives a cold engine — and reporting each
# process separately, as this used to, is not the aggregate it claimed to be.
# Within a process the sizes are re-shuffled each round; see `JSCPerfCore` for
# why a single fixed-order sample per size measures the engine tiering up rather
# than the document.
#
# Builds and stages the bundle itself; nothing to do first.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
bundle="$repo/packages/recto-core-js/dist/recto-core.js"
jsc="/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc"
processes="${1:-3}"

# Build and stage the bundle rather than asking the caller to remember. The
# copy script checks it against its manifest and scans it on the way through.
"$repo/apple/scripts/copy-js-bundles.sh" >/dev/null

swift build -c release --package-path "$here" >/dev/null
binary="$here/.build/release/jsc-perf"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# `sample <run> <label> <kilobytes> <milliseconds> jit=<0|1>` lines from every
# process, pooled per size.
aggregate() {
	awk '
		$1 == "sample" {
			label = $3; kb[label] = $4; jit[label] = $6
			values[label, count[label]++] = $5
		}
		END {
			printf "%-8s %10s %10s %10s %8s %6s\n", "size", "median", "p95", "best", "ms/kB", "n"
			split("8kB 50kB 64kB 250kB", order, " ")
			for (o = 1; o <= 4; o++) {
				label = order[o]
				n = count[label]
				if (n == 0) continue
				for (i = 0; i < n; i++) sorted[i] = values[label, i]
				for (i = 1; i < n; i++) {
					v = sorted[i]; j = i - 1
					while (j >= 0 && sorted[j] > v) { sorted[j + 1] = sorted[j]; j-- }
					sorted[j + 1] = v
				}
				median = sorted[int((n - 1) * 0.5 + 0.5)]
				p95 = sorted[int((n - 1) * 0.95 + 0.5)]
				printf "%-8s %10.1f %10.1f %10.1f %8.1f %6d\n", \
					label, median, p95, sorted[0], median / kb[label], n
			}
		}
	'
}

run_configuration() {
	local label="$1" path="$2"
	echo
	echo "=== $label ==="
	local pooled="$work/samples.txt"
	: >"$pooled"
	for _ in $(seq 1 "$processes"); do
		"$path" "$bundle" --samples >>"$pooled"
	done
	# The entitlements and the JIT probe come from the last process; they are a
	# property of the binary, not of the run.
	grep -E '^(entitlements|JIT probe)' "$pooled" || true
	echo "pooled over $processes fresh processes:"
	aggregate <"$pooled"
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
