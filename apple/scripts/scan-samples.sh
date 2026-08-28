#!/bin/bash
#
# Checks the bundle scanner in `copy-js-bundles.sh` against samples.
#
# A scanner nobody tests is a scanner that quietly stops matching. Every pattern
# gets a string it must reject and a string it must accept; the "accept" half
# matters as much, because the reason these patterns are narrow is that the bare
# words appear all over a megabyte of bundled dependencies and a gate that cries
# wolf gets switched off.
#
#     apple/scripts/scan-samples.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RECTO_SCAN_PATTERNS_ONLY=1 source "$here/copy-js-bundles.sh"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0

# Deliberately assembled at runtime so this file does not itself contain
# anything a real secret scanner would flag.
key() { printf '%s%s' "$1" "$2"; }

must_reject() {
	local name="$1" sample="$2"
	printf '%s\n' "$sample" >"$work/sample"
	if recto_scan_file "sample" "$work/sample" 2>/dev/null; then
		echo "FAIL: $name was not caught: $sample" >&2
		failures=$((failures + 1))
	fi
}

must_accept() {
	local name="$1" sample="$2"
	printf '%s\n' "$sample" >"$work/sample"
	if ! recto_scan_file "sample" "$work/sample" 2>/dev/null; then
		echo "FAIL: $name was flagged but is benign: $sample" >&2
		failures=$((failures + 1))
	fi
}

# --- must be caught ---------------------------------------------------------
must_reject "http localhost"        'fetch("http://localhost:3000/api")'
must_reject "uppercase localhost"   'const H = "HTTP://LOCALHOST:8080"'
must_reject "bare localhost host"   "  host: 'localhost:5173',"
must_reject "loopback v4"           'const url = "http://127.0.0.1:1234/"'
must_reject "wildcard bind"         'listen("http://0.0.0.0:80")'
must_reject "loopback v6"           'const url = "http://[::1]:8080/"'
must_reject "source map pragma"     '//# sourceMappingURL=recto-core.js.map'
must_reject "clerk secret"          "$(key sk_test_ 4Qk2mNpXvR7wLb1aZc)"
must_reject "stripe live publishable" "$(key pk_live_ 51H8xKpQrStUvWxYz0)"
must_reject "openrouter key"        "$(key sk-or-v1- 9f3c1e77ab2d4c6e8091)"
must_reject "openai project key"    "$(key sk-proj- Ab3Cd4Ef5Gh6Ij7Kl8Mn)"
must_reject "openai service key"    "$(key sk-svcacct- Qw2Er4Ty6Ui8Op0As1Df)"
must_reject "github classic token"  "$(key ghp_ 16CharsOfEntropy0000)"
must_reject "github oauth token"    "$(key gho_ 16CharsOfEntropy0000)"
must_reject "github fine-grained"   "$(key github_pat_ 11ABCDEFG0abcdefghij)"
must_reject "aws access key"        "$(key AKIA IOSFODNN7EXAMPLE)"
must_reject "google api key"        "$(key AIza SyD-abc123_DEF456ghi789)"
must_reject "slack bot token"       "$(key xoxb- 123456789012-abcdef)"
must_reject "pem header"            '-----BEGIN RSA PRIVATE KEY-----'
must_reject "openrouter env name"   'process.env.OPENROUTER_API_KEY'
must_reject "convex deploy key"     'const k = process.env.CONVEX_DEPLOY_KEY'

# --- must not be flagged ----------------------------------------------------
# The first is the line that actually lives in `recto-core.js`, and the reason
# every pattern here is narrower than its bare word.
must_accept "node:url message" \
	'const error = new TypeError('"'"'File URL host must be "localhost" or empty on darwin'"'"');'
must_accept "prose about local hosts" '// resolve the local host name first'
must_accept "version-like digits"   'const version = "127.0.0";'
must_accept "minified identifier"   'function sk_(a,b){return a+b}'
must_accept "sourcemap word"        'const sourceMappingURLComment = "//#";'
must_accept "aws in prose"          '// AKIA keys are not used by this app'
must_accept "short sk- word"        'const sk = "sk-or"; // too short to be a key'
must_accept "markdown link"         '[docs](https://example.com/localhost-guide)'
must_accept "ipv6 prose"            '// IPv6 addresses look like 2001:db8::1'

if [ "$failures" -ne 0 ]; then
	echo "$failures scanner sample(s) failed" >&2
	exit 1
fi
echo "bundle scanner: all samples behaved"
