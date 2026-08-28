# Unicode conformance data

`GraphemeBreakTest.txt` is Unicode 16.0.0's own test file for
`Grapheme_Cluster_Break`, downloaded verbatim from
<https://www.unicode.org/Public/16.0.0/ucd/auxiliary/GraphemeBreakTest.txt>.

© 2024 Unicode®, Inc. Used under the Unicode Terms of Use
(<https://www.unicode.org/terms_of_use.html>), which permit redistribution of
the data files with the copyright notice intact. Do not edit it — replacing it
means downloading a newer version from the same place.

## Why it is here

Recto has **two** grapheme-cluster implementations that must agree exactly: JS
(`Intl.Segmenter`, in `packages/recto-vim-js/src/grapheme.js`) clamps the vim
core's positions, and Swift (`Character` boundaries, in
`RectoVim.GraphemeClamp`) clamps positions of native origin. A disagreement
between them desynchronises the JS mirror from `NSTextStorage`, which is silent
text corruption.

Both are run against this file — `packages/recto-vim-js/test/grapheme.bun.test.ts`
and `RectoVimTests.GraphemeConformanceTests`. Agreeing with the same conformance
data is a much stronger claim than agreeing with each other on the cases someone
thought to write down: the previous implementation passed a hand-written suite
while splitting Hangul syllables, SpacingMarks and CRLF.

Both implementations are ICU-backed and follow whatever Unicode version the OS
ships, so a handful of rows can legitimately fail after an OS update that moves
to a newer UCD than the file. The suites report the exact failing rows rather
than a count, so that case is distinguishable from a real regression.
