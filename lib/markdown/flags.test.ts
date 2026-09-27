import { describe, expect, it } from "vitest";

import { countWords } from "./count-words";
import { deriveTitleFromMarkdown } from "./derive-title";
import {
	cleanFlagNote,
	FLAG_GUARD,
	findFlags,
	flagInsertion,
	flagToken,
	isFlagHtml,
	needsFlagGuard,
	removeFlag,
	setFlagNote,
} from "./flags";
import { normalizeMarkdown } from "./normalize";
import { parseMarkdown } from "./parse";

/** The one flag in `md`; fails the test when there isn't exactly one. */
function onlyFlag(md: string) {
	const flags = findFlags(md);
	expect(flags).toHaveLength(1);
	const [flag] = flags;
	if (!flag) throw new Error("no flag");
	return flag;
}

describe("flag tokens", () => {
	it("writes the note inside the comment, or a bare flag without one", () => {
		expect(flagToken("town name")).toBe("<!--flag: town name-->");
		expect(flagToken("  ")).toBe("<!--flag-->");
	});

	it("keeps a note on one line and unable to close the comment early", () => {
		expect(cleanFlagNote("the\n  river's  name")).toBe("the river's name");
		expect(cleanFlagNote("before --> after")).toBe("before –> after");
		expect(cleanFlagNote("ends with a dash-")).toBe("ends with a dash–");
		expect(cleanFlagNote(" dash then space- ")).toBe("dash then space–");
		expect(cleanFlagNote("mid-century")).toBe("mid-century");
	});

	it("recognises exactly one flag comment", () => {
		expect(isFlagHtml("<!--flag-->")).toBe(true);
		expect(isFlagHtml("<!--flag: a b-->")).toBe(true);
		expect(isFlagHtml("<!-- a comment -->")).toBe(false);
		expect(isFlagHtml("<!--flagpole-->")).toBe(false);
	});
});

describe("findFlags", () => {
	it("finds flags in order with their notes and offsets", () => {
		const md = "Born in <!--flag: town--> in <!--flag-->.\n";
		const flags = findFlags(md);
		expect(flags.map((f) => f.note)).toEqual(["town", ""]);
		expect(flags.map((f) => md.slice(f.from, f.to))).toEqual([
			"<!--flag: town-->",
			"<!--flag-->",
		]);
	});

	it("ignores flag text inside code", () => {
		expect(findFlags("a `<!--flag-->` b\n\n```\n<!--flag-->\n```\n")).toEqual(
			[],
		);
	});

	it("covers the guard in front of a line-start flag", () => {
		const md = `${FLAG_GUARD}<!--flag: who--> was born\n`;
		const flag = onlyFlag(md);
		expect(flag.from).toBe(0);
		expect(flag.tokenFrom).toBe(1);
		expect(flag.note).toBe("who");
	});

	it("finds flags in headings, lists and quotes", () => {
		const md = `# Title <!--flag-->\n\n- ${FLAG_GUARD}<!--flag: a-->\n\n> x <!--flag: b-->\n`;
		expect(findFlags(md).map((f) => f.note)).toEqual(["", "a", "b"]);
	});
});

describe("inserting a flag", () => {
	it("guards a flag that would begin a line's content", () => {
		expect(needsFlagGuard("", 0)).toBe(true);
		expect(needsFlagGuard("One.\n", 5)).toBe(true);
		expect(needsFlagGuard("- ", 2)).toBe(true);
		expect(needsFlagGuard("  1. ", 5)).toBe(true);
		expect(needsFlagGuard("> - [ ] ", 8)).toBe(true);
		expect(needsFlagGuard("Born in ", 8)).toBe(false);
		expect(needsFlagGuard("# ", 2)).toBe(false);
	});

	it("inserts inline wherever it lands", () => {
		const cases: [string, string][] = [
			["", " was born.\n"],
			["Line one.\n", " two.\n"],
			["- ", " item\n"],
			["Born in ", " in 1920.\n"],
		];
		for (const [before, after] of cases) {
			const md =
				before + flagInsertion(before + after, before.length, "x") + after;
			expect(onlyFlag(md).note).toBe("x");
			// Round-trips through canonical Markdown unchanged, still inline.
			expect(normalizeMarkdown(md)).toBe(md);
			expect(parseMarkdown(md).children.some((n) => n.type === "html")).toBe(
				false,
			);
		}
	});
});

describe("editing a flag", () => {
	const md = "Born in <!--flag: town--> in 1920.\n";

	it("rewrites the note in place", () => {
		const flag = onlyFlag(md);
		expect(setFlagNote(md, flag, "Harare?")).toBe(
			"Born in <!--flag: Harare?--> in 1920.\n",
		);
		expect(setFlagNote(md, flag, "")).toBe("Born in <!--flag--> in 1920.\n");
	});

	it("resolving removes the flag, its guard and one of the spaces around it", () => {
		expect(removeFlag(md, onlyFlag(md))).toBe("Born in in 1920.\n");
		const guarded = `${FLAG_GUARD}<!--flag--> Born.\n`;
		expect(removeFlag(guarded, onlyFlag(guarded))).toBe(" Born.\n");
		const tight = "Born in Harare<!--flag-->.\n";
		expect(removeFlag(tight, onlyFlag(tight))).toBe("Born in Harare.\n");
	});
});

describe("flags stay out of the prose", () => {
	it("aren't words", () => {
		expect(countWords("Born in <!--flag: the town name--> in 1920.")).toBe(4);
	});

	it("aren't part of a heading's title", () => {
		expect(
			deriveTitleFromMarkdown("# Chapter <!--flag: better name--> One\n"),
		).toBe("Chapter  One");
	});
});
