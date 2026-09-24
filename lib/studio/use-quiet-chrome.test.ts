import { describe, expect, it } from "vitest";

import { isWritingKey } from "./use-quiet-chrome";

function keyIn(target: Element, init: KeyboardEventInit = {}): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { key: "a", ...init });
	Object.defineProperty(event, "target", { value: target });
	return event;
}

describe("isWritingKey", () => {
	const editor = document.createElement("div");
	editor.className = "ProseMirror";
	const paragraph = document.createElement("p");
	editor.append(paragraph);
	const source = document.createElement("div");
	source.className = "cm-content";

	it("counts plain keys in either editor as writing", () => {
		expect(isWritingKey(keyIn(paragraph))).toBe(true);
		expect(isWritingKey(keyIn(source, { key: "Enter" }))).toBe(true);
		expect(isWritingKey(keyIn(source, { key: "B", shiftKey: true }))).toBe(
			true,
		);
	});

	it("leaves the chrome alone for chords, so ⌘K finds it where it was", () => {
		expect(isWritingKey(keyIn(paragraph, { key: "k", metaKey: true }))).toBe(
			false,
		);
		expect(
			isWritingKey(
				keyIn(paragraph, { key: "B", ctrlKey: true, shiftKey: true }),
			),
		).toBe(false);
	});

	it("ignores typing outside the editors", () => {
		expect(isWritingKey(keyIn(document.createElement("input")))).toBe(false);
	});
});
