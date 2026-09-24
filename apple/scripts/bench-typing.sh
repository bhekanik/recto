#!/bin/bash
#
# Milliseconds per keystroke in the real editor, for a Markdown file you pick:
#
#     apple/scripts/bench-typing.sh ~/Desktop/long-essay.md [keys]
#
# Runs TypingLatencyBench twice over the same text: BENCH is a file document
# (EditorHostView), CLOUD the synced library's document view. Each prints
# p50/p90/p99/max. Built with -O, because a Debug build's numbers are mostly
# the cost of Debug. A 120 Hz display has 8.3 ms per frame; stay under it.
#
# Needs the JS bundles (copy-js-bundles.sh) like the rest of the app tests.
set -euo pipefail

[ $# -ge 1 ] || { echo "usage: $0 <markdown-file> [keys]" >&2; exit 64; }
doc="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
keys="${2:-300}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
derived="${RECTO_BENCH_DERIVED_DATA:-${TMPDIR:-/tmp}/recto-bench-dd}"
out="$(mktemp)"
trap 'rm -f "$out"' EXIT

TEST_RUNNER_RECTO_BENCH_DOC="$doc" TEST_RUNNER_RECTO_BENCH_KEYS="$keys" TEST_RUNNER_RECTO_BENCH_OUT="$out" \
xcodebuild -project "$repo/apple/RectoApp/Recto.xcodeproj" -scheme Recto -configuration Debug \
	-destination 'platform=macOS' -derivedDataPath "$derived" \
	CODE_SIGNING_ALLOWED=NO SWIFT_OPTIMIZATION_LEVEL=-O SWIFT_COMPILATION_MODE=wholemodule \
	test -only-testing:RectoTests/TypingLatencyBench >/dev/null 2>&1 || true
[ -s "$out" ] || { echo "error: the bench produced no result; run it in Xcode to see why" >&2; exit 1; }
cat "$out"
