#!/bin/zsh
#
# Build, notarize and publish Recto for Mac as a GitHub release:
#
#     apple/scripts/release-mac.sh 0.1.0
#
# The web app's download links point at releases/latest/download/Recto.dmg,
# so a release made here is what they serve. Needs, once per machine:
#   - the "Developer ID Application" certificate for team WAVMJLFY95
#   - notary credentials in the keychain:
#       xcrun notarytool store-credentials recto-notary \
#         --apple-id <apple-id> --team-id WAVMJLFY95
#   - RECTO_CONVEX_URL, RECTO_CLERK_PUBLISHABLE_KEY and RECTO_WEB_URL in the
#     environment: the same public client values the installed app uses
# Run from a clean checkout of main; the tag is made on HEAD.
set -euo pipefail

version="${1:?usage: release-mac.sh VERSION (e.g. 0.1.0)}"
[[ "$version" =~ '^[0-9]+\.[0-9]+\.[0-9]+$' ]] || { echo "version must be MAJOR.MINOR.PATCH" >&2; exit 64; }
: "${RECTO_CONVEX_URL:?set RECTO_CONVEX_URL}"
: "${RECTO_CLERK_PUBLISHABLE_KEY:?set RECTO_CLERK_PUBLISHABLE_KEY}"
: "${RECTO_WEB_URL:?set RECTO_WEB_URL}"
notary_profile="${RECTO_NOTARY_PROFILE:-recto-notary}"
team=WAVMJLFY95

repo="$(cd "$(dirname "${(%):-%x}")/../.." && pwd)"
cd "$repo"
[[ -z "$(git status --porcelain)" ]] || { echo "working tree is not clean" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/v$version" >/dev/null && { echo "v$version already exists" >&2; exit 1; }

work="$(mktemp -d "${TMPDIR:-/tmp}/recto-release.XXXXXX")"
echo "working in $work"
archive="$work/Recto.xcarchive"
export_dir="$work/export"
app="$export_dir/Recto.app"
dmg="$work/Recto.dmg"

# The version counts builds: one per release commit is enough to keep macOS
# from treating two releases as the same bundle.
build_number="$(git rev-list --count HEAD)"

./apple/scripts/copy-js-bundles.sh

xcodebuild -project apple/RectoApp/Recto.xcodeproj -scheme Recto \
  -configuration Release -destination 'generic/platform=macOS' \
  -derivedDataPath "$work/dd" -archivePath "$archive" archive \
  MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$build_number" \
  RECTO_CONVEX_URL="$RECTO_CONVEX_URL" \
  RECTO_CLERK_PUBLISHABLE_KEY="$RECTO_CLERK_PUBLISHABLE_KEY" \
  RECTO_WEB_URL="$RECTO_WEB_URL"
apple/RectoApp/scripts/validate-archive-config.sh "$archive"

# Re-sign for distribution outside the App Store: Developer ID, hardened runtime.
cat > "$work/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>developer-id</string>
  <key>teamID</key><string>$team</string>
  <key>signingStyle</key><string>automatic</string>
</dict>
</plist>
PLIST
xcodebuild -exportArchive -archivePath "$archive" \
  -exportOptionsPlist "$work/ExportOptions.plist" -exportPath "$export_dir"
codesign --verify --deep --strict "$app"
lipo "$app/Contents/MacOS/Recto" -verify_arch arm64

# Notarize the app and staple the ticket, so it opens offline too.
ditto -c -k --keepParent "$app" "$work/Recto.zip"
xcrun notarytool submit "$work/Recto.zip" --keychain-profile "$notary_profile" --wait
xcrun stapler staple "$app"

# A disk image with the app and a link to /Applications, signed and
# notarized in its own right.
stage="$work/dmg"
mkdir -p "$stage"
ditto "$app" "$stage/Recto.app"
ln -s /Applications "$stage/Applications"
hdiutil create -volname "Recto" -srcfolder "$stage" -fs HFS+ -format UDZO "$dmg"
identity="$(security find-identity -v -p codesigning | awk -F'"' "/Developer ID Application: .*\\($team\\)/ {print \$2; exit}")"
[[ -n "$identity" ]] || { echo "no Developer ID Application identity for $team" >&2; exit 1; }
codesign --sign "$identity" --timestamp "$dmg"
xcrun notarytool submit "$dmg" --keychain-profile "$notary_profile" --wait
xcrun stapler staple "$dmg"
spctl --assess --type open --context context:primary-signature --verbose "$dmg"

git tag -a "v$version" -m "Recto for Mac $version"
git push origin "v$version"
gh release create "v$version" "$dmg" \
  --title "Recto for Mac $version" \
  --notes "Recto for Mac $version. Requires macOS 26 or later on Apple silicon. Open Recto.dmg and drag Recto to Applications."
echo "published: https://github.com/bhekanik/recto/releases/tag/v$version"
