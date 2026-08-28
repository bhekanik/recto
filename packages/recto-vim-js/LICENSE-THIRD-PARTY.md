# Third-party code in this package

`src/generated/` is produced by `scripts/extract-core.ts`, which copies source
verbatim out of two MIT-licensed packages. Nothing is modified; see the script
for the exact anchors.

## @replit/codemirror-vim 6.3.0 — MIT

Copyright (C) 2017 by Yunchi Luo and contributors.
Source: https://github.com/replit/codemirror-vim

Extracted: the `initVim(CM)` factory (the vim core), `scanForBracket` with its
bracket tables, and `hardWrap`.

## @codemirror/language 6.12.3 — MIT

Copyright (C) 2018-2021 by Marijn Haverbeke and others.
Source: https://github.com/codemirror/language

Extracted: the `StringStream` class, which the vim core reaches for as
`CM.StringStream` when parsing ex-command arguments.

Both licences are reproduced in the upstream packages under `node_modules/`.
The ship-time acknowledgements screen (plan 023 §14) must list both.
