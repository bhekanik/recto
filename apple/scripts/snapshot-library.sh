#!/bin/bash
#
# Screenshots of the synced library window with sample documents, dark and
# light, into a directory:
#
#     apple/scripts/snapshot-library.sh /tmp/recto-shots
#
# SnapshotHarness renders the window inside the test host and asks for each
# capture through the directory; this script's loop takes it with
# screencapture, which needs the terminal's screen-recording permission (the
# test host never asks for one). A window appears on screen while it runs.
set -euo pipefail

[ $# -eq 1 ] || { echo "usage: $0 <output-dir>" >&2; exit 64; }
mkdir -p "$1"
dir="$(cd "$1" && pwd)"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
derived="${RECTO_SNAPSHOT_DERIVED_DATA:-${TMPDIR:-/tmp}/recto-snapshot-dd}"
rm -f "$dir"/*.req "$dir"/*.done

capture_loop() {
	while true; do
		for request in "$dir"/*.req; do
			[ -e "$request" ] || continue
			name="$(basename "$request" .req)"
			screencapture -x -o -l "$(cat "$request")" "$dir/$name.png"
			rm -f "$request"
			touch "$dir/$name.done"
		done
		sleep 0.1
	done
}
capture_loop &
loop=$!
trap 'kill $loop 2>/dev/null; wait $loop 2>/dev/null; rm -f "$dir"/*.done' EXIT

TEST_RUNNER_RECTO_SNAPSHOT_DIR="$dir" \
xcodebuild -project "$repo/apple/RectoApp/Recto.xcodeproj" -scheme Recto -configuration Debug \
	-destination 'platform=macOS' -derivedDataPath "$derived" CODE_SIGNING_ALLOWED=NO \
	test -only-testing:RectoTests/SnapshotHarness 2>&1 | grep -E "error:|✘|Test run with|BLUR" || true
ls "$dir"/*.png
