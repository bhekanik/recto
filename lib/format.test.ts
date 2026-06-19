import { describe, expect, it } from "vitest";

import { timeFmt } from "@/lib/format";

// The comments panel and owner review surface both render the same "Mon D, H:MM"
// stamp; this pins the resolved Intl options so a drift in one place can't
// silently diverge the two surfaces.
describe("timeFmt", () => {
	it("keeps the shared short-date / numeric-time options", () => {
		const opts = timeFmt.resolvedOptions();
		expect(opts.month).toBe("short");
		expect(opts.day).toBe("numeric");
		expect(opts.hour).toBe("numeric");
		expect(opts.minute).toBe("2-digit");
	});
});
