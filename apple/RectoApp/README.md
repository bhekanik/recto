# Recto macOS bootstrap

This is the early W12 app target. It exists so the current `RectoEditor`
package can run in a real app window for the Slice A VoiceOver and Full Keyboard
Access smoke. It is not the N6 app shell. It has no sidebar, persistence, sync,
menus, settings, import/export or App Store metadata.

`project.yml` is the source of truth. XcodeGen 2.46.0 generated the committed
`Recto.xcodeproj`; regenerate it after adding or removing project files:

```sh
cd apple/RectoApp
xcodegen generate
```

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

Open `Recto.xcodeproj`, run the `Recto` scheme, and focus the single editor
window before the manual accessibility smoke. The sample includes headings, a
list, a link, a quote and a fenced code block so navigation checks do not need
test data setup. Full N6 can replace this fixed `Window` with its document
window model.

The target uses bundle ID `com.bhekani.recto`, team `WAVMJLFY95`, automatic
signing, hardened runtime and App Sandbox. Unsigned builds override signing on
the command line. A TestFlight archive still needs an Apple Distribution
certificate, a Mac App Store provisioning profile, an App Store Connect app
record, an app icon and the later N6/N7 product work.
