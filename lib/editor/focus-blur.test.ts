import { describe, expect, it } from "vitest";

import {
	blocksInRamp,
	FOCUS_BLUR_MAX_PX,
	FOCUS_BLUR_RAMP,
	focusBlurRadius,
	focusBlurStyle,
} from "./focus-blur";

describe("focusBlurRadius", () => {
	it("keeps the caret's block sharp", () => {
		expect(focusBlurRadius(0)).toBe(0);
	});

	it("already blurs the nearest neighbour, then grows to the maximum", () => {
		const radii = Array.from({ length: FOCUS_BLUR_RAMP + 2 }, (_, d) =>
			focusBlurRadius(d + 1),
		);
		expect(radii[0]).toBeGreaterThanOrEqual(FOCUS_BLUR_MAX_PX * 0.3);
		for (let i = 1; i < radii.length; i++) {
			expect(radii[i]).toBeGreaterThanOrEqual(radii[i - 1] ?? 0);
		}
		expect(focusBlurRadius(FOCUS_BLUR_RAMP)).toBe(FOCUS_BLUR_MAX_PX);
		expect(focusBlurRadius(FOCUS_BLUR_RAMP * 10)).toBe(FOCUS_BLUR_MAX_PX);
	});

	it("quantises to quarter pixels", () => {
		for (let d = 1; d <= FOCUS_BLUR_RAMP; d++) {
			expect((focusBlurRadius(d) * 4) % 1).toBe(0);
		}
	});
});

describe("blocksInRamp", () => {
	it("returns the caret's block and its neighbours inside the ramp, in order", () => {
		const blocks = blocksInRamp(100, 50);
		expect(blocks.map((b) => b.index)).toEqual(
			Array.from(
				{ length: FOCUS_BLUR_RAMP * 2 - 1 },
				(_, i) => 50 - FOCUS_BLUR_RAMP + 1 + i,
			),
		);
		expect(blocks.find((b) => b.index === 50)?.distance).toBe(0);
		expect(blocks.find((b) => b.index === 49)?.distance).toBe(1);
		expect(blocks.find((b) => b.index === 51)?.distance).toBe(1);
	});

	it("stops at the document's edges", () => {
		expect(blocksInRamp(3, 0).map((b) => b.index)).toEqual([0, 1, 2]);
		expect(blocksInRamp(1, 0)).toEqual([{ index: 0, distance: 0 }]);
	});

	it("doesn't count blank blocks towards the distance", () => {
		// 0 text, 1 blank, 2 text (caret), 3 blank, 4 text
		const blank = (i: number) => i === 1 || i === 3;
		const blocks = blocksInRamp(5, 2, blank);
		expect(blocks.find((b) => b.index === 0)?.distance).toBe(1);
		expect(blocks.find((b) => b.index === 4)?.distance).toBe(1);
	});

	it("is empty for an empty document or a caret outside it", () => {
		expect(blocksInRamp(0, 0)).toEqual([]);
		expect(blocksInRamp(5, -1)).toEqual([]);
		expect(blocksInRamp(5, 5)).toEqual([]);
	});
});

describe("focusBlurStyle", () => {
	it("sets the caret's block explicitly sharp over the container's blur", () => {
		expect(focusBlurStyle(0)).toBe("filter: none");
		expect(focusBlurStyle(2)).toBe(`filter: blur(${focusBlurRadius(2)}px)`);
	});
});
