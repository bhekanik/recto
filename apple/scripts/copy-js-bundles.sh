#!/bin/bash
#
# Installs the built JS bundles into the Swift packages that ship them, and
# refuses to install one that does not match its manifest.
#
# This is the Xcode "Run Script" build phase target (plan 023 §2). It also runs
# standalone, which is how `swift test` and CI get their resources:
#
#     bun install --frozen-lockfile
#     bun run core:build && bun run vim:build
#     apple/scripts/copy-js-bundles.sh
#
# Why a copy and not a symlink: SwiftPM does not follow symlinks when it stages
# resources, and Xcode's resource copier does not either.
#
# Why the hash check: the bundles are gitignored build output, so a stale one in
# `Resources/` is invisible in a diff. Comparing against the manifest that
# `build.ts` wrote makes "you edited lib/ and forgot to rebuild" a build error
# instead of a native app running last week's markdown semantics.
#
# In an Xcode run-script phase, declare the inputs and outputs so Xcode does not
# skip it:
#   Input Files:  $(SRCROOT)/../packages/recto-core-js/manifest.json
#                 $(SRCROOT)/../packages/recto-vim-js/manifest.json
#   Output Files: $(SRCROOT)/Packages/RectoCoreJS/Sources/RectoCoreJS/JS/recto-core.js
#                 $(SRCROOT)/Packages/RectoVim/Sources/RectoVim/JS/recto-vim.js
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

fail() {
	echo "error: $*" >&2
	echo "note: run \`bun install --frozen-lockfile && bun run core:build && bun run vim:build\` from $repo" >&2
	exit 1
}

# A bundle that ships inside the app must not carry any of these (plan 023 §2:
# "no localhost, no source maps, no secrets").
#
# Each pattern is deliberately narrower than the word it guards, because the
# bare words do occur innocently in a megabyte of bundled dependencies and a
# gate that cries wolf gets switched off. `//localhost` or `localhost:` is an
# endpoint, where the word alone is `node:url`'s "File URL host must be
# \"localhost\" or empty" message. `sourceMappingURL=` is the pragma, not the
# name. `sk_test_`/`sk_live_`/`pk_live_` are the Clerk and Stripe key shapes;
# a bare `sk_` matches minified identifiers.
FORBIDDEN=(
	"(//|[[:space:]\"'])localhost([:/]|$)"
	"sourceMappingURL="
	"(sk|pk)_(test|live)_[A-Za-z0-9]"
	"OPENROUTER"
)

install_bundle() {
	local package="$1" file="$2" target_dir="$3"
	local source="$repo/packages/$package/dist/$file"
	local manifest="$repo/packages/$package/manifest.json"

	[ -f "$source" ] || fail "$package: $source is missing"
	[ -f "$manifest" ] || fail "$package: $manifest is missing"

	# Read the recorded hash without a JSON parser: the manifest is written by
	# `build.ts` with a fixed shape, and depending on jq would make the Xcode
	# phase fail on a machine that does not have it.
	local expected
	expected="$(sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p' "$manifest")"
	[ -n "$expected" ] || fail "$package: manifest.json has no sha256"

	local actual
	actual="$(shasum -a 256 "$source" | cut -d' ' -f1)"
	if [ "$actual" != "$expected" ]; then
		fail "$package: $file does not match manifest.json (built $expected, found $actual) — rebuild"
	fi

	local hit
	for pattern in "${FORBIDDEN[@]}"; do
		hit="$(grep -c -E -- "$pattern" "$source" || true)"
		if [ "$hit" != "0" ]; then
			fail "$package: $file has $hit line(s) matching /$pattern/, which must not ship"
		fi
	done

	mkdir -p "$target_dir"
	# `cp` only when the bytes differ, so an unchanged bundle does not touch the
	# file and invalidate everything downstream of it in an incremental build.
	if ! cmp -s "$source" "$target_dir/$file"; then
		cp "$source" "$target_dir/$file"
		echo "installed $file ($(wc -c <"$source" | tr -d ' ') bytes, sha256 ${actual:0:16}…) -> ${target_dir#"$repo"/}"
	else
		echo "up to date $file (sha256 ${actual:0:16}…)"
	fi
}

install_bundle recto-core-js recto-core.js \
	"$repo/apple/Packages/RectoCoreJS/Sources/RectoCoreJS/JS"
install_bundle recto-vim-js recto-vim.js \
	"$repo/apple/Packages/RectoVim/Sources/RectoVim/JS"
