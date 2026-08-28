#!/bin/bash
#
# Builds the JS bundles, installs them into the Swift packages that ship them,
# and refuses to install one that must not go out.
#
# This is the Xcode "Run Script" build phase target (plan 023 §2). It also runs
# standalone, which is how `swift test` and CI get their resources:
#
#     bun install --frozen-lockfile
#     apple/scripts/copy-js-bundles.sh
#
# **It builds; it does not merely check.** Comparing a bundle against the
# manifest written beside it only proves the bundle has not been corrupted since
# it was built — edit `lib/`, keep the matching pair, and the check passes, which
# is exactly the case that matters. The alternative to building would be hashing
# every build input here and again in `build.ts`, two implementations of one hash
# that have to agree byte for byte forever. Running the build is cheaper to
# maintain and cannot be wrong: `build.ts` is deterministic, so an unchanged tree
# reproduces the same bytes, and `cmp` below keeps an unchanged bundle from
# touching the file and invalidating the rest of the build.
#
# Without `bun` on PATH it **fails**. Verifying the existing bundle against its
# own manifest would prove only that nobody corrupted it since it was built,
# which is not the question — and a gate that passes when it cannot check is
# worse than no gate, because it reads as a check. Xcode Cloud installs a pinned
# bun in `ci_scripts/ci_post_clone.sh` before this runs; a developer machine has
# one because the repo is a Bun project.
#
# Why a copy and not a symlink: SwiftPM does not follow symlinks when it stages
# resources, and Xcode's resource copier does not either.
#
# In an Xcode run-script phase, leave "Based on dependency analysis" unchecked so
# it runs every build, and declare:
#   Output Files: $(SRCROOT)/Packages/RectoCoreJS/Sources/RectoCoreJS/JS/recto-core.js
#                 $(SRCROOT)/Packages/RectoVim/Sources/RectoVim/JS/recto-vim.js
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

fail() {
	echo "error: $*" >&2
	exit 1
}

# A bundle that ships inside the app must not carry any of these (plan 023 §2:
# "no localhost, no source maps, no secrets"). Matched case-insensitively, so
# `LOCALHOST` and `SK-OR-V1-` are caught too.
#
# Each pattern is narrower than the word it guards, because the bare words do
# occur innocently in a megabyte of bundled dependencies and a gate that cries
# wolf gets switched off. `//localhost` or `localhost:` is an endpoint; the word
# alone is `node:url`'s "File URL host must be \"localhost\"" message.
#
# The key shapes are the ones this repo handles or could plausibly be pasted into
# a source file: Clerk and Stripe, OpenRouter, OpenAI, GitHub, Convex deploy
# keys, AWS, Google, Slack, and PEM private-key headers. `scan-samples.sh` runs
# every pattern against a positive and a negative sample, so one that stops
# matching fails CI instead of going quiet.
#
# Deliberately not gitleaks: it would put a network download inside a build phase
# that has to work offline and inside Xcode Cloud's sandbox. Narrower coverage,
# no new dependency, and tested — that is the trade.
RECTO_FORBIDDEN=(
	'(//|[[:space:]"'"'"'])localhost([:/]|$)'
	'(//|[[:space:]"'"'"'])127\.0\.0\.1([:/]|$)'
	'(//|[[:space:]"'"'"'])0\.0\.0\.0([:/]|$)'
	'\[::1\]'
	'sourceMappingURL='
	'(sk|pk)_(test|live)_[A-Za-z0-9]{8}'
	'sk-(or-v1|proj|svcacct)-[A-Za-z0-9_-]{8}'
	'(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16}'
	'github_pat_[A-Za-z0-9_]{16}'
	'AKIA[0-9A-Z]{12}'
	'AIza[0-9A-Za-z_-]{16}'
	'xox[baprs]-[0-9A-Za-z-]{10}'
	'BEGIN [A-Z ]*PRIVATE KEY'
	'OPENROUTER'
	'CONVEX_DEPLOY_KEY'
)

recto_scan_file() {
	local label="$1" path="$2" hits
	for pattern in "${RECTO_FORBIDDEN[@]}"; do
		hits="$(grep -c -E -i -- "$pattern" "$path" || true)"
		if [ "$hits" != "0" ]; then
			echo "error: $label has $hits line(s) matching /$pattern/, which must not ship" >&2
			return 1
		fi
	done
	return 0
}

# `scan-samples.sh` sources this file for the patterns and the scanner.
if [ "${RECTO_SCAN_PATTERNS_ONLY:-}" = "1" ]; then
	return 0 2>/dev/null || exit 0
fi

read_manifest_sha() {
	# The manifest has a fixed shape written by `build.ts`; depending on jq would
	# make the Xcode phase fail on a machine that does not have it.
	sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p' "$1"
}

stage_copy() {
	local source="$1" target_dir="$2" name
	name="$(basename "$source")"
	mkdir -p "$target_dir"
	if ! cmp -s "$source" "$target_dir/$name"; then
		cp "$source" "$target_dir/$name"
		echo "installed $name -> ${target_dir#"$repo"/}"
	else
		echo "up to date $name in ${target_dir#"$repo"/}"
	fi
}

install_bundle() {
	local package="$1" file="$2" script="$3" target_dir="$4"
	local source="$repo/packages/$package/dist/$file"
	local manifest="$repo/packages/$package/manifest.json"

	if command -v bun >/dev/null 2>&1; then
		# Quiet on success, and the build's own output on failure — `bun run`
		# echoes the command it runs to stderr, which is noise in a build log
		# until something goes wrong.
		local log
		log="$(cd "$repo" && bun run "$script" 2>&1)" ||
			fail "\`bun run $script\` failed:
$log"
	else
		# No silent acceptance of a bundle nobody can prove is current. Without
		# bun there is no way to tell a matching pair that is up to date from a
		# matching pair built before someone edited `lib/`, and shipping the
		# second one is the failure this script exists to prevent.
		fail "$package: bun is not on PATH, so $file cannot be proven current.
Install it and re-run, or run \`bun install && bun run $script\` from $repo first.
Xcode Cloud installs a pinned bun in ci_scripts/ci_post_clone.sh before this runs."
	fi

	[ -f "$manifest" ] || fail "$package: $manifest is missing"
	local expected actual
	expected="$(read_manifest_sha "$manifest")"
	[ -n "$expected" ] || fail "$package: manifest.json has no sha256"
	actual="$(shasum -a 256 "$source" | cut -d' ' -f1)"
	[ "$actual" = "$expected" ] ||
		fail "$package: $file does not match manifest.json (built $expected, found $actual)"

	recto_scan_file "$package/$file" "$source" || exit 1

	mkdir -p "$target_dir"
	if ! cmp -s "$source" "$target_dir/$file"; then
		cp "$source" "$target_dir/$file"
		echo "installed $file ($(wc -c <"$source" | tr -d ' ') bytes, sha256 ${actual:0:16}…) -> ${target_dir#"$repo"/}"
	else
		echo "up to date $file (sha256 ${actual:0:16}…)"
	fi
}

install_bundle recto-core-js recto-core.js core:build \
	"$repo/apple/Packages/RectoCoreJS/Sources/RectoCoreJS/JS"
install_bundle recto-vim-js recto-vim.js vim:build \
	"$repo/apple/Packages/RectoVim/Sources/RectoVim/JS"

# The device perf spike bundles the core as a test resource: on a phone there
# is no checkout to read it from, and the device number is the point of the
# spike. Already verified and scanned above.
stage_copy "$repo/packages/recto-core-js/dist/recto-core.js" \
	"$repo/apple/Spikes/JSCPerf/Tests/JSCPerfTests/JS"
