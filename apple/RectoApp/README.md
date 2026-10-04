# Recto for macOS

The app's main window is a signed-in, local-first document library backed by
Recto's SQLite mirror. It also opens, creates, edits, and saves standalone `.md`
files through SwiftUI's native document system and the real `RectoEditor`
package. Document windows keep native titles, dirty-state tracking, autosave,
Save, Open, New, and error presentation.

V1 reads and writes UTF-8. It preserves a UTF-8 byte-order mark when the opened
file has one. Invalid UTF-8 fails through the native document error UI instead
of becoming an empty or replacement-character document. Existing LF and CRLF
documents keep their line-ending convention through native typing and paste.
New and newline-free documents use LF. Recto preserves unchanged text bytes,
Unicode and an existing UTF-8 byte-order mark.

The macOS 26 target uses `FileDocument` and
`DocumentGroup(newDocument:editor:)`. Apple's replacement `Document` API is a
macOS 27 beta API. Move this boundary when Recto raises its deployment target
after macOS 27 ships; do not make V1 depend on the beta API.

Rich editors share one native writing-controls path. Typing `/` at a source-line
command position opens the 17-entry caret popover. A non-empty selection opens
the floating bold, italic, strikethrough, inline-code and link panel. Standalone
and synced documents both send those edits through their existing history
owners as structural boundaries.

Keep unused material beside a library draft with [Overflow](../../docs/how-to/keep-notes-in-overflow.md). Open it through `Toggle Overflow` in the command palette or Review menu, or use the tray button beside the formatting toolbar.

`project.yml` is the source of truth. XcodeGen 2.46.0 generated the committed
`Recto.xcodeproj`; regenerate it after adding or removing project files:

```sh
cd apple/RectoApp
xcodegen generate
```

The `AppIcon` asset catalog packages the folded-leg R. Its default artwork and
the three reserved appearance variants live under `Brand/AppIcon`; see that
directory's README for provenance and hashes.

Run the unsigned local gates from the repository root:

```sh
xcodebuild -project apple/RectoApp/Recto.xcodeproj -scheme Recto \
  -configuration Debug -destination 'platform=macOS' \
  -derivedDataPath /tmp/recto-derived-data CODE_SIGNING_ALLOWED=NO build

xcodebuild -project apple/RectoApp/Recto.xcodeproj -scheme Recto \
  -configuration Debug -destination 'platform=macOS' \
  -derivedDataPath /tmp/recto-derived-data CODE_SIGNING_ALLOWED=NO test

xcodebuild -project apple/RectoApp/Recto.xcodeproj -scheme Recto \
  -configuration Release -destination 'generic/platform=macOS' \
  -derivedDataPath /tmp/recto-derived-data CODE_SIGNING_ALLOWED=NO build

lipo /tmp/recto-derived-data/Build/Products/Release/Recto.app/Contents/MacOS/Recto \
  -verify_arch arm64

xcodebuild -project apple/RectoApp/Recto.xcodeproj -scheme Recto \
  -configuration Release -destination 'generic/platform=macOS' \
  -derivedDataPath /tmp/recto-derived-data \
  -archivePath /tmp/Recto-unsigned.xcarchive \
  CODE_SIGNING_ALLOWED=NO archive \
  RECTO_CONVEX_URL='https://example.convex.cloud' \
  RECTO_CLERK_PUBLISHABLE_KEY='pk_test_bW9jay5jbGVyay5hY2NvdW50cy5kZXYk' \
  RECTO_WEB_URL='https://example.test'

apple/RectoApp/scripts/validate-archive-config.sh /tmp/Recto-unsigned.xcarchive
```

Inject the three public client values at build or archive time; do not put them in
source control:

```sh
xcodebuild -project apple/RectoApp/Recto.xcodeproj -scheme Recto \
  -configuration Release -destination 'generic/platform=macOS' \
  -archivePath /tmp/Recto.xcarchive archive \
  RECTO_CONVEX_URL='https://example.convex.cloud' \
  RECTO_CLERK_PUBLISHABLE_KEY='pk_test_bW9jay5jbGVyay5hY2NvdW50cy5kZXYk' \
  RECTO_WEB_URL='https://example.test'

apple/RectoApp/scripts/validate-archive-config.sh /tmp/Recto.xcarchive
```

Xcode build settings must trail the `archive` action. Shell environment
variables with these names are not imported automatically by the generated
project.

The target uses bundle ID `com.bhekani.recto`, team `WAVMJLFY95`, automatic
signing, hardened runtime, App Sandbox, outbound network access and
user-selected file access. Unsigned builds override signing on the command line.
Convex 0.8.1 ships a macOS arm64 binary only, so the synced app is arm64-only;
CI verifies that Release slice.

Before a deployment, archive once unsigned and once with Apple Development
signing. Run `codesign --verify --deep --strict --verbose=2` on the signed app,
inspect `codesign -d --entitlements :-`, and confirm hardened runtime, App
Sandbox, and user-selected read/write access. Then run the native document
attack: LF and CRLF open/edit/save/relaunch, immediate quit after the last edit,
two windows, a non-writable save, and an external-write conflict. These remain
deployment gates because CI has neither a signing identity nor a logged-in
WindowServer session. TestFlight also needs an Apple Distribution certificate,
a Mac App Store provisioning profile, an App Store Connect app record and the
later N6/N7 product work.
