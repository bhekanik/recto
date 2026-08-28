#!/usr/bin/env bash
# Build the spike in Release and run the full N0b measurement.
#   ./measure.sh            report to stdout
#   ./measure.sh out.txt    report to stdout and out.txt
set -euo pipefail
cd "$(dirname "$0")"

swift build -c release
if [ $# -gt 0 ]; then
  ./.build/release/EditorSpike measure "$PWD/Corpus" | tee "$1"
else
  ./.build/release/EditorSpike measure "$PWD/Corpus"
fi
