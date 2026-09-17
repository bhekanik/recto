import { describe, expect, it } from "vitest";

import { nodeLabel } from "./diff";

const patch = (from: number, to: number, insert: string) =>
	JSON.stringify({ from, to, insert });

describe("nodeLabel", () => {
	it("quotes the text an insertion added", () => {
		expect(nodeLabel(patch(4, 4, "the second draft"), "root")).toBe(
			"Added “the second draft”",
		);
	});

	it("quotes the new text of a replacement", () => {
		expect(nodeLabel(patch(0, 5, "Hello"), "root")).toBe("Changed to “Hello”");
	});

	it("collapses Markdown whitespace and trims the quote", () => {
		expect(
			nodeLabel(patch(0, 0, "\n\n## Intro\n\tBody  text \n"), "root"),
		).toBe("Added “## Intro Body text”");
	});

	it("cuts a long quote at 32 UTF-16 units with an ellipsis", () => {
		expect(nodeLabel(patch(0, 0, "a".repeat(40)), "root")).toBe(
			`Added “${"a".repeat(32)}…”`,
		);
	});

	it("never cuts through a surrogate pair", () => {
		expect(nodeLabel(patch(0, 0, `${"a".repeat(31)}😀tail`), "root")).toBe(
			`Added “${"a".repeat(31)}…”`,
		);
	});

	it("does not quote a lone surrogate from a patch boundary inside an emoji", () => {
		expect(nodeLabel(patch(1, 2, "\ude01"), "root")).toBe("Edited");
	});

	it("counts characters when the inserted text is only whitespace", () => {
		expect(nodeLabel(patch(3, 3, "\n\n"), "root")).toBe("Added 2 chars");
		expect(nodeLabel(patch(3, 5, " "), "root")).toBe("Edited");
	});

	it("keeps the deletion, root, restore and AI labels", () => {
		expect(nodeLabel(patch(2, 9, ""), "root")).toBe("Removed 7 chars");
		expect(nodeLabel(patch(0, 0, "x"), null)).toBe("Document created");
		expect(nodeLabel(patch(0, 0, "x"), "root", "restore")).toBe(
			"Restored a version",
		);
		expect(nodeLabel(patch(0, 0, "x"), "root", "ai:Tighten")).toBe(
			"AI: Tighten",
		);
	});
});
