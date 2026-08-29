# Recto app icon sources

These are the approved 1024 x 1024 folded-leg R rasters recovered from the
2026-08-29 design scratchpad at:

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

Dark, accent and mono switching is intentionally deferred. Shipping guessed
Icon Composer layers would change the mark.
