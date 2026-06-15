import type { Options as StringifyOptions } from "remark-stringify";

/** Frozen remark-stringify config — single serialization truth. */
export const CANONICAL_STRINGIFY: Readonly<StringifyOptions> = Object.freeze({
	bullet: "-",
	bulletOrdered: ".",
	emphasis: "_",
	strong: "*",
	fence: "`",
	fences: true,
	listItemIndent: "one",
	rule: "-",
	ruleRepetition: 3,
	ruleSpaces: false,
	setext: false,
	tightDefinitions: true,
	resourceLink: false,
});
