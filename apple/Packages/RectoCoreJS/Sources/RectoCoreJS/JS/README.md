# JS

`recto-core.js` belongs here and is **not committed**. Produce it with:

```sh
bun install --frozen-lockfile
bun run core:build
apple/scripts/copy-js-bundles.sh
```

The copy script verifies the bundle's sha256 against its package's
`manifest.json` and refuses to install a stale one.

This README keeps the directory in git. SwiftPM copies the whole directory, so a
missing bundle is a runtime error that names the command above rather than a
confusing SwiftPM resource error. The directory is `JS/` rather than
`Resources/` because on iOS a resource bundle is flat, and a top-level
`Resources` directory inside one makes `codesign` reject it.

`js-yaml.min.js` is the browser build from the `js-yaml` version pinned in
`bun.lock`. It is committed because native title derivation loads it directly.
Its MIT license is beside it.
