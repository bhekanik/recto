import { describe, expect, it } from "vitest";

import { isRemoteServerUpdate } from "./use-document-sync";

describe("isRemoteServerUpdate", () => {
	it("returns false for own echoed write", () => {
		expect(isRemoteServerUpdate(1000, 1000, 1000)).toBe(false);
	});

	it("returns false when server is older than last written", () => {
		expect(isRemoteServerUpdate(900, 1000, 1000)).toBe(false);
	});

	it("returns true for newer remote write", () => {
		expect(isRemoteServerUpdate(2000, 1000, 1000)).toBe(true);
	});

	it("returns false when server matches expected (in-flight echo)", () => {
		expect(isRemoteServerUpdate(1500, 1000, 1500)).toBe(false);
	});
});
