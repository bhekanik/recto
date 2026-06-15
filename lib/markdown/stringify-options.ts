import type { Options as StringifyOptions } from "remark-stringify";

/** Frozen remark-stringify config — single serialization truth (06-markdown-dialect §2.2). */
export const CANONICAL_STRINGIFY: Readonly<StringifyOptions> = Object.freeze({
	bullet: "-",
	emphasis: "_",
	strong: "*",
	fence: "`",
	fences: true,
	listItemIndent: "one",
	rule: "-",
	ruleRepetition: 3,
	ruleSpaces: false,
	setext: false,
	incrementListMarker: true,
	tightDefinitions: true,
	resourceLink: true,
});
