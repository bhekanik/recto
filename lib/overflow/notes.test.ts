import { describe, expect, it } from "vitest";
import { appendToNotes, removeFromNotes, utf8Bytes } from "./notes";

describe("Overflow notes", () => {
	it("appends after a blank line, as the Mac does", () => {
		expect(appendToNotes("", "Cut.")).toBe("Cut.");
		expect(appendToNotes("note", "Cut.")).toBe("note\n\nCut.");
		expect(appendToNotes("note\n", "Cut.")).toBe("note\n\nCut.");
		expect(appendToNotes("note\n\n", "Cut.")).toBe("note\n\nCut.");
	});

	it("removes text only where it still is exactly", () => {
		expect(removeFromNotes("a\n\nCut.", 3, "Cut.")).toBe("a\n\n");
		expect(removeFromNotes("a\n\nCut!", 3, "Cut.")).toBeNull();
		expect(removeFromNotes("a", -1, "a")).toBeNull();
	});

	it("measures UTF-8 bytes", () => {
		expect(utf8Bytes("é")).toBe(2);
	});
});
