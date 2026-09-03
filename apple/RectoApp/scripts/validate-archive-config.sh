#!/bin/zsh
set -euo pipefail

archive_path="${1:?usage: validate-archive-config.sh ARCHIVE_PATH}"
plist="$archive_path/Products/Applications/Recto.app/Contents/Info.plist"

[[ -f "$plist" ]] || { echo "missing archived Info.plist: $plist" >&2; exit 1; }

convex_url=$(/usr/libexec/PlistBuddy -c 'Print :RectoConvexURL' "$plist")
clerk_key=$(/usr/libexec/PlistBuddy -c 'Print :RectoClerkPublishableKey' "$plist")
web_url=$(/usr/libexec/PlistBuddy -c 'Print :RectoWebURL' "$plist")

valid_host() {
  local host=$1
  local label
  (( ${#host} >= 1 && ${#host} <= 253 )) || return 1
  [[ "$host" != .* && "$host" != *. && "$host" != *..* ]] || return 1
  for label in ${(s:.:)host}; do
    (( ${#label} >= 1 && ${#label} <= 63 )) || return 1
    [[ "$label" =~ '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$' ]] || return 1
  done
}

[[ "$convex_url" =~ '^https://([^/:?#]+)(/[^?#]*)?$'
  && "$convex_url" != *'$('* ]] || {
  echo "archive has an empty, unresolved, or non-HTTPS RectoConvexURL" >&2
  exit 1
}
valid_host "$match[1]" || {
  echo "archive RectoConvexURL does not contain a valid host" >&2
  exit 1
}
[[ "$web_url" =~ '^https://([^/:?#]+)(/[^?#]*)?$'
  && "$web_url" != *'$('* ]] || {
  echo "archive has an empty, unresolved, or non-HTTPS RectoWebURL" >&2
  exit 1
}
valid_host "$match[1]" || {
  echo "archive RectoWebURL does not contain a valid host" >&2
  exit 1
}
case "$clerk_key" in
  pk_test_*) encoded=${clerk_key#pk_test_} ;;
  pk_live_*) encoded=${clerk_key#pk_live_} ;;
  *) encoded='' ;;
esac
[[ -n "$encoded" && "$encoded" =~ '^[A-Za-z0-9_-]+$' ]] || {
  echo "archive has an empty, unresolved, or malformed RectoClerkPublishableKey" >&2
  exit 1
}
base64_payload=${encoded//-/+}
base64_payload=${base64_payload//_/\/}
while (( ${#base64_payload} % 4 != 0 )); do base64_payload+='='; done
decoded=$(printf '%s' "$base64_payload" | base64 -D 2>/dev/null) || {
  echo "archive has an invalid Clerk publishable-key payload" >&2
  exit 1
}
[[ "$decoded" == *'$' ]] || {
  echo "archive Clerk publishable key does not contain a valid host" >&2
  exit 1
}
valid_host "${decoded%\$}" || {
  echo "archive Clerk publishable key does not contain a valid host" >&2
  exit 1
}

echo "archived Recto public configuration is present"
