import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openInMacApp } from "./mac-app";

describe("openInMacApp", () => {
	const assign = vi.fn();

	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("location", { ...window.location, assign });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		assign.mockReset();
	});

	it("hands the link over", () => {
		openInMacApp("recto://document/abc", vi.fn());
		expect(assign).toHaveBeenCalledWith("recto://document/abc");
	});

	it("offers the download when nothing took the link", () => {
		const missed = vi.fn();
		openInMacApp("recto://document/abc", missed);
		vi.advanceTimersByTime(1600);
		expect(missed).toHaveBeenCalledTimes(1);
	});

	it("stays quiet when the app came forward", () => {
		const missed = vi.fn();
		openInMacApp("recto://document/abc", missed);
		window.dispatchEvent(new Event("blur"));
		vi.advanceTimersByTime(1600);
		expect(missed).not.toHaveBeenCalled();
	});
});
