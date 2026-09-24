import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { glideScrollTop } from "./typewriter-glide";

function scroller(scrollTop = 0, clientHeight = 600, scrollHeight = 5000) {
	const el = document.createElement("div");
	Object.defineProperty(el, "clientHeight", { value: clientHeight });
	Object.defineProperty(el, "scrollHeight", { value: scrollHeight });
	el.scrollTop = scrollTop;
	return el;
}

let frames: FrameRequestCallback[] = [];
let now = 0;

/** Run one round of queued animation frames, `ms` after the last. */
function runFrame(ms = 16): void {
	const queued = frames;
	frames = [];
	now += ms;
	for (const frame of queued) frame(now);
}

/** Run frames until none are left. */
function runFrames(): void {
	for (let i = 0; frames.length && i < 100; i++) runFrame();
}

beforeEach(() => {
	frames = [];
	now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
		frames.push(cb);
		return frames.length;
	});
	vi.stubGlobal("cancelAnimationFrame", () => {
		frames = [];
	});
	vi.stubGlobal("matchMedia", () => ({ matches: false }));
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("glideScrollTop", () => {
	it("eases to the target over a few frames instead of jumping", () => {
		const el = scroller(100);
		const positions: number[] = [];
		glideScrollTop(el, 140);
		expect(el.scrollTop).toBe(100);
		for (let i = 0; frames.length && i < 100; i++) {
			runFrame();
			positions.push(el.scrollTop);
		}
		expect(el.scrollTop).toBe(140);
		const between = positions.filter((p) => p > 100 && p < 140);
		expect(between.length).toBeGreaterThanOrEqual(2);
		for (let i = 1; i < positions.length; i++) {
			expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1] ?? 0);
		}
	});

	it("jumps when the move is a screen or more", () => {
		const el = scroller(0, 600);
		glideScrollTop(el, 900);
		expect(el.scrollTop).toBe(900);
		expect(frames).toHaveLength(0);
	});

	it("jumps when the writer prefers reduced motion", () => {
		vi.stubGlobal("matchMedia", () => ({ matches: true }));
		const el = scroller(100);
		glideScrollTop(el, 140);
		expect(el.scrollTop).toBe(140);
	});

	it("clamps to the scrollable range", () => {
		const el = scroller(10, 600, 1000);
		glideScrollTop(el, -50);
		runFrames();
		expect(el.scrollTop).toBe(0);
	});

	it("stops when the writer scrolls by hand", () => {
		const el = scroller(100);
		glideScrollTop(el, 140);
		el.dispatchEvent(new Event("wheel"));
		runFrames();
		expect(el.scrollTop).toBe(100);
	});
});
