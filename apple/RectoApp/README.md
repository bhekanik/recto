# Recto for macOS

The app opens, creates, edits, and saves `.md` files through SwiftUI's native
document system and the real `RectoEditor` package. Document windows use native
titles, dirty-state tracking, autosave, Save, Open, New, and error presentation.

V1 reads and writes UTF-8. It preserves a UTF-8 byte-order mark when the opened
file has one. Invalid UTF-8 fails through the native document error UI instead
of becoming an empty or replacement-character document. Existing LF and CRLF
line endings stay unchanged; Recto writes the line endings in the editor string.

The macOS 26 target uses `FileDocument` and
`DocumentGroup(newDocument:editor:)`. Apple's replacement `Document` API is a
macOS 27 beta API. Move this boundary when Recto raises its deployment target
after macOS 27 ships; do not make V1 depend on the beta API.

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

xcodebuild -project apple/RectoApp/Recto.xcodeproj -scheme Recto \
  -configuration Release -destination 'generic/platform=macOS' \
  -derivedDataPath /tmp/recto-derived-data \
  -archivePath /tmp/Recto-unsigned.xcarchive \
  CODE_SIGNING_ALLOWED=NO archive
```

The target uses bundle ID `com.bhekani.recto`, team `WAVMJLFY95`, automatic
signing, hardened runtime and App Sandbox. Unsigned builds override signing on
the command line. A TestFlight archive still needs an Apple Distribution
certificate, a Mac App Store provisioning profile, an App Store Connect app
record and the later N6/N7 product work.
