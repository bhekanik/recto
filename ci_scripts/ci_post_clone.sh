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
# Xcode Cloud images have no Bun, so install one — the same version
# `.github/workflows/ci.yml` pins, because the bundles CI tests and the bundles
# this ships have to come from the same bundler.
#
# A versioned release artefact rather than `curl | bash`: the install script is a
# moving target that resolves whatever it likes, which is the thing being pinned
# against. The checksum is published in the release's `SHASUMS256.txt`; verifying
# it means a compromised or truncated download fails here rather than producing a
# quietly different bundle.
#
# `sh`, not bash: `ci_post_clone.sh` runs under `/bin/sh` on the image.
set -eu

BUN_VERSION="1.3.14"
BUN_TARGET="bun-darwin-aarch64"
BUN_BASE="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}"

echo "--- installing bun ${BUN_VERSION} (${BUN_TARGET})"
work="$(mktemp -d)"
curl -fsSL -o "$work/${BUN_TARGET}.zip" "${BUN_BASE}/${BUN_TARGET}.zip"
curl -fsSL -o "$work/SHASUMS256.txt" "${BUN_BASE}/SHASUMS256.txt"
(cd "$work" && grep " ${BUN_TARGET}.zip\$" SHASUMS256.txt | shasum -a 256 -c -) ||
	{
		echo "error: bun ${BUN_VERSION} download failed its published checksum" >&2
		exit 1
	}
unzip -q "$work/${BUN_TARGET}.zip" -d "$work"
export BUN_INSTALL="$HOME/.bun"
mkdir -p "$BUN_INSTALL/bin"
mv "$work/${BUN_TARGET}/bun" "$BUN_INSTALL/bin/bun"
chmod +x "$BUN_INSTALL/bin/bun"
rm -rf "$work"
export PATH="$BUN_INSTALL/bin:$PATH"
bun --version

# CI_PRIMARY_REPOSITORY_PATH is set by Xcode Cloud; the fallback lets this
# script be run by hand from a checkout to reproduce a CI failure.
repo="${CI_PRIMARY_REPOSITORY_PATH:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$repo"

echo "--- installing dependencies"
bun install --frozen-lockfile

# The copy script builds both bundles itself, checks each against its manifest
# and scans it, then installs it into the Swift package that ships it.
echo "--- building and installing the JS bundles"
./apple/scripts/copy-js-bundles.sh
