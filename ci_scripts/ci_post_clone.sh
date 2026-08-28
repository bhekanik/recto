#!/bin/sh
#
# Xcode Cloud runs this after cloning, before resolving packages (plan 023 §2).
#
# The JS bundles the Swift packages ship are build output and are not committed,
# so this is where they get built. Committing them instead would mean every
# change to `lib/` produced a 1 MB binary diff that a reviewer cannot read and
# that can silently disagree with the source it was built from — the manifest
# hash exists precisely so that disagreement is a build error.
#
# Xcode Cloud images have no Bun, so install a pinned one. `sh`, not bash:
# `ci_post_clone.sh` runs under `/bin/sh` on the image.
set -eu

BUN_VERSION="1.3.14"

echo "--- installing bun ${BUN_VERSION}"
export BUN_INSTALL="$HOME/.bun"
curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
export PATH="$BUN_INSTALL/bin:$PATH"
bun --version

# CI_PRIMARY_REPOSITORY_PATH is set by Xcode Cloud; the fallback lets this
# script be run by hand from a checkout to reproduce a CI failure.
repo="${CI_PRIMARY_REPOSITORY_PATH:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$repo"

echo "--- installing dependencies"
bun install --frozen-lockfile

echo "--- building the JS bundles"
bun run core:build
bun run vim:build

echo "--- installing them into the Swift packages"
./apple/scripts/copy-js-bundles.sh
