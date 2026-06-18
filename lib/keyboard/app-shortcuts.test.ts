import { describe, expect, it } from "vitest";
import type { Mode } from "@/lib/modes/types";
import { isFindKey, shouldInterceptFind } from "./app-shortcuts";

function findEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
	return {
		key: "f",
		metaKey: true,
		ctrlKey: false,
		shiftKey: false,
		altKey: false,
		...overrides,
	} as KeyboardEvent;
}

describe("isFindKey", () => {
	it("matches ⌘F", () => {
		expect(isFindKey(findEvent({ metaKey: true }))).toBe(true);
	});
	it("matches Ctrl+F", () => {
		expect(isFindKey(findEvent({ metaKey: false, ctrlKey: true }))).toBe(true);
	});
	it("ignores ⌘⇧F (reserved for focus toggle)", () => {
		expect(isFindKey(findEvent({ shiftKey: true }))).toBe(false);
	});
	it("ignores bare F", () => {
		expect(isFindKey(findEvent({ metaKey: false, ctrlKey: false }))).toBe(
			false,
		);
	});
});

describe("shouldInterceptFind", () => {
	const editable: Mode[] = ["rich", "raw", "vim"];
	for (const mode of editable) {
		it(`intercepts in editable lens: ${mode}`, () => {
			expect(shouldInterceptFind(findEvent(), mode)).toBe(true);
		});
	}

	it("does NOT intercept in preview (native browser find falls through)", () => {
		expect(shouldInterceptFind(findEvent(), "preview")).toBe(false);
	});

	it("non-find keys never intercept, even in editable lenses", () => {
		expect(shouldInterceptFind(findEvent({ key: "g" }), "rich")).toBe(false);
	});
});
