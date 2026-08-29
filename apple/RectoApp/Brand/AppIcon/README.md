# Recto app icon sources

These are the approved 1024 x 1024 folded-leg R rasters recovered from the
2026-08-27 Claude design session on 2026-08-29. The recovered scratchpad was:

```text
/private/tmp/claude-501/-Users-bhekanik-code-bhekanik-recto/3e7a1f19-19c2-4786-a26c-371fcf1bd8f0/scratchpad/logo2/
```

`r-dark-paper.png` is the Default/Twilight app icon. The other three files
preserve the approved light, accent and mono variants for later Icon Composer
work.

The files are canonical artwork. Do not resize, recolor or overwrite them.
Verify them from this directory with:

```sh
shasum -a 256 -c SHA256SUMS
```

The macOS target currently uses an asset catalog. The recovered files are
flattened, full-canvas renders, while Icon Composer expects separate artwork
layers and applies its own enclosure and material effects. Its document format
is private and the installed app requires Developer Tools Access authorization
on first launch. Hand-authoring an `AppIcon.icon` package would not preserve the
approved pixels. `Resources/Assets.xcassets/AppIcon.appiconset` contains the
required macOS sizes derived only from `r-dark-paper.png` with macOS `sips`.
Run this exact recipe from the repository root to reproduce the committed
catalog files. The original run used macOS 26.6.2 (`sips-316`).

```sh
APP_ICON_SOURCE=apple/RectoApp/Brand/AppIcon/Sources/r-dark-paper.png
APP_ICON_OUTPUT=apple/RectoApp/Resources/Assets.xcassets/AppIcon.appiconset

sips -z 16 16 "$APP_ICON_SOURCE" --out "$APP_ICON_OUTPUT/Recto-16.png"
sips -z 32 32 "$APP_ICON_SOURCE" --out "$APP_ICON_OUTPUT/Recto-16@2x.png"
cp "$APP_ICON_OUTPUT/Recto-16@2x.png" "$APP_ICON_OUTPUT/Recto-32.png"
sips -z 64 64 "$APP_ICON_SOURCE" --out "$APP_ICON_OUTPUT/Recto-32@2x.png"
sips -z 128 128 "$APP_ICON_SOURCE" --out "$APP_ICON_OUTPUT/Recto-128.png"
sips -z 256 256 "$APP_ICON_SOURCE" --out "$APP_ICON_OUTPUT/Recto-128@2x.png"
cp "$APP_ICON_OUTPUT/Recto-128@2x.png" "$APP_ICON_OUTPUT/Recto-256.png"
sips -z 512 512 "$APP_ICON_SOURCE" --out "$APP_ICON_OUTPUT/Recto-256@2x.png"
cp "$APP_ICON_OUTPUT/Recto-256@2x.png" "$APP_ICON_OUTPUT/Recto-512.png"
cp "$APP_ICON_SOURCE" "$APP_ICON_OUTPUT/Recto-512@2x.png"
```

Dark, accent and mono switching is intentionally deferred. Shipping guessed
Icon Composer layers would change the mark.
