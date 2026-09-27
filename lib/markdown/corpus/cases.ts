/** Round-trip corpus inputs — blueprint 06-markdown-dialect §6. */
export type CorpusCase = {
	id: number;
	name: string;
	input: string;
	/** When true, assert yaml.value byte-exact (assertion 4). */
	checkFrontmatter?: boolean;
};

export const CORPUS_CASES: CorpusCase[] = [
	{
		id: 1,
		name: "headings H1–H6 ATX",
		input: `# One
## Two
### Three
#### Four
##### Five
###### Six
`,
	},
	{
		id: 2,
		name: "Setext to ATX",
		input: `Title
=====

Subtitle
---
`,
	},
	{
		id: 3,
		name: "nested unordered list",
		input: `- one
 - two
  - three
`,
	},
	{
		id: 4,
		name: "nested ordered list with start",
		input: `3. first
4. second
   1. nested
`,
	},
	{
		id: 5,
		name: "mixed ordered and unordered nesting",
		input: `1. ordered
   - bullet
     1. inner ordered
- top bullet
  1. inner
`,
	},
	{
		id: 6,
		name: "task list",
		input: `- [ ] todo
- [x] done
  - [ ] nested
`,
	},
	{
		id: 7,
		name: "table alignments",
		input: `| left | center | right | default |
| :--- | :----: | ----: | --- |
| a | b | c | d |
`,
	},
	{
		id: 8,
		name: "table escaped pipes",
		input: `| col |
| --- |
| a \\| b |
`,
	},
	{
		id: 9,
		name: "table cell br",
		input: `| col |
| --- |
| line1<br>line2 |
`,
	},
	{
		id: 10,
		name: "multiple footnotes out of order",
		input: `Second[^b] and first[^a].

[^b]: Note B
[^a]: Note A
`,
	},
	{
		id: 11,
		name: "orphan footnote ref and def",
		input: `Missing[^missing] and orphan[^orphan].

[^orphan]: Orphan only
`,
	},
	{
		id: 12,
		name: "nested YAML frontmatter",
		checkFrontmatter: true,
		input: `---
title: Hello
tags:
  - one
  - two
meta:
  nested: true
date: 2026-01-15
---

Body after frontmatter.
`,
	},
	{
		id: 13,
		name: "hard break backslash and trailing spaces",
		input: `Line one\\
Line two  
Line three
`,
	},
	{
		id: 14,
		name: "soft break in paragraph",
		input: `Line one
Line two still same paragraph
`,
	},
	{
		id: 15,
		name: "fenced code with lang and inner backticks",
		input: `\`\`\`ts
const x = \`hello\`;
\`\`\`
`,
	},
	{
		id: 16,
		name: "nested blockquote",
		input: `> outer
>
> > inner
`,
	},
	{
		id: 17,
		name: "links and images with titles",
		input: `[link](https://example.com "Link title")

![alt](https://example.com/img.png "Image title")
`,
	},
	{
		id: 18,
		name: "reference-style link",
		input: `[ref link][id]

[id]: https://example.com "Ref title"
`,
	},
	{
		id: 19,
		name: "strikethrough",
		input: `~~deleted~~ text
`,
	},
	{
		id: 20,
		name: "autolinks",
		input: `<https://example.com>

www.example.org
`,
	},
	{
		id: 21,
		name: "inline mix",
		input: `**bold** _italic_ \`code\` ~~strike~~ [link](https://x.com) and footnote[^n].

[^n]: Note
`,
	},
	{
		id: 22,
		name: "delimiter normalization",
		input: `*foo* and __bar__
`,
	},
	{
		id: 23,
		name: "thematic break variants",
		input: `Before

***

Between

___

After

- - -

End
`,
	},
	{
		id: 24,
		name: "inline raw HTML",
		input: `<span>safe</span>

<script>alert(1)</script>
`,
	},
	{
		id: 25,
		name: "writing flags (inline HTML comments, guarded at line start)",
		input: `Born in <!--flag: the town, mid-century--> in 1920.

\u2060<!--flag--> opens a paragraph.

- \u2060<!--flag: a list item--> item
`,
	},
];
