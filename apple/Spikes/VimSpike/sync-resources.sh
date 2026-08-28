#!/bin/bash
# Copies the JS bundle and the shared fixture into the Swift package.
#
# SwiftPM resources have to live inside the target directory and it does not
# follow symlinks, so they are copied. Run after `bun run vim:build`, or
# whenever the fixture changes.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
js="$repo/packages/recto-vim-js"

cp "$js/dist/recto-vim.js" "$here/Sources/RectoVim/Resources/recto-vim.js"
cp "$js/fixtures/keystroke-suite.json" "$here/Sources/VimSpikeSuite/Resources/keystroke-suite.json"
echo "synced recto-vim.js ($(wc -c < "$here/Sources/RectoVim/Resources/recto-vim.js") bytes) and keystroke-suite.json"
