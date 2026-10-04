# Turbopack rejected a generated Google font query

Status: production builds use Webpack to avoid the observed parser failure; the precise malformed query remains unknown.

At source `fb3daa3eb35e1e6fb1e377da7f1a64b1b0702c43`, [CI run 37241765486](https://github.com/bhekanik/recto/actions/runs/37241765486) passed typing, formatting and 1,219 JavaScript tests, then failed the Next 16.2.7 production build. `NextFontGoogleFontFileReplacer` reported `next/font/google queries have exactly one entry`. The diagnostic truncated the generated Source Serif 4 URL.

The [pinned Turbopack implementation](https://github.com/vercel/next.js/blob/v16.2.7/crates/next-core/src/next_font/google/mod.rs) rejects a query with other than one parsed entry before downloading the font file. A fresh Google stylesheet fetched with Next's user agent did not expose nested query parameters, so neither a particular URL trigger nor a transient download failure is established.

`bun run build` selects the [supported Webpack build](https://nextjs.org/docs/app/guides/upgrading/version-16#opting-out-of-turbopack). Its [font loader](https://github.com/vercel/next.js/blob/v16.2.7/packages/font/src/google/loader.ts) downloads the extracted URLs directly and emits font assets without that Rust query parser. Existing font choices and development commands stay the same.

Before restoring Turbopack production builds, capture the complete generated CSS/query on a failing runner and verify a corrected Next version with a production build and rendered-font check.
