import { describe, expect, it } from "vitest";
import { readerMarkdown } from "./reader";

describe("readerMarkdown", () => {
	it("leaves ghosted passages out and closes the gap they leave", () => {
		const text = "Keep this. Maybe cut this. Keep that.";
		const from = text.indexOf("Maybe");
		const to = from + "Maybe cut this.".length;
		expect(readerMarkdown(text, [{ from, to }])).toBe("Keep this. Keep that.");
	});

	it("measures in UTF-16 like the Mac and ignores ranges past the end", () => {
		const text = "😀 one two";
		expect(readerMarkdown(text, [{ from: 3, to: 7 }])).toBe("😀 two");
		expect(readerMarkdown(text, [{ from: 3, to: 99 }])).toBe(text);
	});
});
