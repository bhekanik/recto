import { describe, expect, it } from "vitest";

import { buildTransformMessages } from "./transform-request";

describe("buildTransformMessages (plan 009)", () => {
	it("starts with a system message constraining output to the rewrite only", () => {
		const msgs = buildTransformMessages({
			instruction: "Tighten this.",
			selection: "The cat sat on the mat.",
		});
		expect(msgs[0]?.role).toBe("system");
		expect(msgs[0]?.content).toMatch(/ONLY the rewritten text/i);
	});

	it("includes the instruction and selection in the user message", () => {
		const msgs = buildTransformMessages({
			instruction: "Make it formal.",
			selection: "yo what's up",
		});
		const user = msgs.find((m) => m.role === "user");
		expect(user?.content).toContain("Make it formal.");
		expect(user?.content).toContain("yo what's up");
	});
});
