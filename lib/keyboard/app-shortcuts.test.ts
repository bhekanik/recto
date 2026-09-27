import { describe, expect, it } from "vitest";
import type { Mode } from "@/lib/modes/types";
import {
	type AppShortcutAction,
	createAppShortcutHandler,
	isAddFlagKey,
	isFindKey,
	isSpellcheckKey,
	isToggleNotesKey,
	shouldInterceptFind,
} from "./app-shortcuts";

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

describe("focus blur chord", () => {
	it("Ctrl+Shift+B toggles focus blur, as ⌃⇧B does in the Mac app", () => {
		const actions: AppShortcutAction[] = [];
		const handle = createAppShortcutHandler((action) => actions.push(action));
		const event = new KeyboardEvent("keydown", {
			key: "B",
			ctrlKey: true,
			shiftKey: true,
			cancelable: true,
		});
		handle(event);
		expect(actions).toEqual([{ type: "toggle-focus-blur" }]);
		expect(event.defaultPrevented).toBe(true);
	});
});

describe("spellcheck chord", () => {
	const semicolon = (init: KeyboardEventInit) =>
		new KeyboardEvent("keydown", { key: ";", cancelable: true, ...init });

	it("⌘; on a Mac, Ctrl+; elsewhere", () => {
		expect(isSpellcheckKey(semicolon({ metaKey: true }), true)).toBe(true);
		expect(isSpellcheckKey(semicolon({ ctrlKey: true }), true)).toBe(false);
		expect(isSpellcheckKey(semicolon({ ctrlKey: true }), false)).toBe(true);
		expect(isSpellcheckKey(semicolon({ metaKey: true }), false)).toBe(false);
	});

	it("leaves ⌘: and plain ; alone", () => {
		expect(
			isSpellcheckKey(semicolon({ metaKey: true, shiftKey: true }), true),
		).toBe(false);
		expect(isSpellcheckKey(semicolon({}), true)).toBe(false);
	});

	it("toggles spellcheck from the app handler", () => {
		const actions: AppShortcutAction[] = [];
		const handle = createAppShortcutHandler((action) => actions.push(action));
		const event = semicolon({ ctrlKey: true });
		handle(event);
		expect(actions).toEqual([{ type: "toggle-spellcheck" }]);
		expect(event.defaultPrevented).toBe(true);
	});
});

describe("flag chords", () => {
	const key = (k: string, init: KeyboardEventInit) =>
		new KeyboardEvent("keydown", { key: k, cancelable: true, ...init });

	it("⌘⇧X flags on a Mac, Ctrl+Shift+X elsewhere; ⌘X stays cut", () => {
		expect(
			isAddFlagKey(key("X", { metaKey: true, shiftKey: true }), true),
		).toBe(true);
		expect(isAddFlagKey(key("x", { metaKey: true }), true)).toBe(false);
		expect(
			isAddFlagKey(key("X", { ctrlKey: true, shiftKey: true }), false),
		).toBe(true);
		expect(
			isAddFlagKey(key("X", { ctrlKey: true, shiftKey: true }), true),
		).toBe(false);
	});

	it("⌃⇧N opens notes on a Mac, Alt+Shift+N elsewhere", () => {
		expect(
			isToggleNotesKey(key("N", { ctrlKey: true, shiftKey: true }), true),
		).toBe(true);
		expect(
			isToggleNotesKey(key("N", { altKey: true, shiftKey: true }), false),
		).toBe(true);
		expect(
			isToggleNotesKey(key("N", { ctrlKey: true, shiftKey: true }), false),
		).toBe(false);
		expect(
			isToggleNotesKey(key("N", { metaKey: true, shiftKey: true }), true),
		).toBe(false);
	});

	it("route through the app handler", () => {
		const actions: AppShortcutAction[] = [];
		const handle = createAppShortcutHandler((action) => actions.push(action));
		handle(key("X", { ctrlKey: true, shiftKey: true }));
		handle(key("N", { altKey: true, shiftKey: true }));
		expect(actions).toEqual([{ type: "add-flag" }, { type: "toggle-notes" }]);
	});
});
