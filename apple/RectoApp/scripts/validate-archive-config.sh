#!/bin/zsh
set -euo pipefail

archive_path="${1:?usage: validate-archive-config.sh ARCHIVE_PATH}"
plist="$archive_path/Products/Applications/Recto.app/Contents/Info.plist"

[[ -f "$plist" ]] || { echo "missing archived Info.plist: $plist" >&2; exit 1; }

convex_url=$(/usr/libexec/PlistBuddy -c 'Print :RectoConvexURL' "$plist")
clerk_key=$(/usr/libexec/PlistBuddy -c 'Print :RectoClerkPublishableKey' "$plist")

[[ "$convex_url" == https://* && "$convex_url" != *'$('* ]] || {
  echo "archive has an empty, unresolved, or non-HTTPS RectoConvexURL" >&2
  exit 1
}
[[ "$clerk_key" == pk_test_* || "$clerk_key" == pk_live_* ]] || {
  echo "archive has an empty, unresolved, or malformed RectoClerkPublishableKey" >&2
  exit 1
}

echo "archived Recto public configuration is present"
