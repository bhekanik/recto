import { afterEach, describe, expect, it, vi } from "vitest";

import {
	dispatchOpenComment,
	OPEN_COMMENT_EVENT,
	subscribeOpenComment,
} from "./summon";

describe("open-comment summon helpers (clicking a highlight)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("round-trips a commentId from dispatch to subscriber", () => {
		const received: string[] = [];
		const unsubscribe = subscribeOpenComment((id) => received.push(id));

		dispatchOpenComment("comment-123");

		expect(received).toEqual(["comment-123"]);
		unsubscribe();
	});

	it("stops delivering after unsubscribe", () => {
		const received: string[] = [];
		const unsubscribe = subscribeOpenComment((id) => received.push(id));
		unsubscribe();

		dispatchOpenComment("comment-456");

		expect(received).toEqual([]);
	});

	it("dispatches a typed CustomEvent under the agreed event name", () => {
		const handler = vi.fn();
		window.addEventListener(OPEN_COMMENT_EVENT, handler);

		dispatchOpenComment("comment-789");

		expect(handler).toHaveBeenCalledTimes(1);
		const event = handler.mock.calls[0]?.[0] as CustomEvent<{
			commentId: string;
		}>;
		expect(event.detail).toEqual({ commentId: "comment-789" });
		window.removeEventListener(OPEN_COMMENT_EVENT, handler);
	});

	it("ignores a malformed event with no commentId", () => {
		const handler = vi.fn();
		const unsubscribe = subscribeOpenComment(handler);

		window.dispatchEvent(new CustomEvent(OPEN_COMMENT_EVENT, { detail: {} }));

		expect(handler).not.toHaveBeenCalled();
		unsubscribe();
	});
});

describe("closest [data-comment-id] resolution (the click→commentId step)", () => {
	// Both editor surfaces resolve the clicked node's nearest [data-comment-id]
	// ancestor the same way; this exercises that DOM lookup in isolation.
	const resolve = (target: Element | null): string | null =>
		(target as HTMLElement | null)
			?.closest?.("[data-comment-id]")
			?.getAttribute("data-comment-id") ?? null;

	it("resolves the id when the click lands inside a highlight span", () => {
		const span = document.createElement("span");
		span.className = "recto-comment-mark";
		span.setAttribute("data-comment-id", "abc");
		span.textContent = "highlighted text";
		document.body.append(span);

		// A click target inside the mark (e.g. a nested text wrapper) still resolves.
		expect(resolve(span)).toBe("abc");
		span.remove();
	});

	it("resolves the id from a nested descendant of the highlight", () => {
		const span = document.createElement("span");
		span.setAttribute("data-comment-id", "outer");
		const inner = document.createElement("em");
		span.append(inner);
		document.body.append(span);

		expect(resolve(inner)).toBe("outer");
		span.remove();
	});

	it("returns null for a click outside any highlight", () => {
		const p = document.createElement("p");
		p.textContent = "plain prose";
		document.body.append(p);

		expect(resolve(p)).toBeNull();
		p.remove();
	});
});
