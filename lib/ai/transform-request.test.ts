import { describe, expect, it } from "vitest";

import {
	buildCritiqueMessages,
	buildTransformMessages,
	parseCritique,
} from "./transform-request";

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

describe("buildCritiqueMessages (plan 009)", () => {
	it("asks for read-only JSON feedback, not edits", () => {
		const msgs = buildCritiqueMessages({ text: "Some draft." });
		expect(msgs[0]?.role).toBe("system");
		expect(msgs[0]?.content).toMatch(/do NOT rewrite/i);
		expect(msgs[0]?.content).toMatch(/JSON/);
		expect(msgs.find((m) => m.role === "user")?.content).toBe("Some draft.");
	});
});

describe("parseCritique (plan 009)", () => {
	it("parses a clean JSON object", () => {
		const raw =
			'{"notes":[{"category":"Clarity","note":"The intro is vague."}]}';
		expect(parseCritique(raw)).toEqual([
			{ category: "Clarity", note: "The intro is vague." },
		]);
	});

	it("parses JSON wrapped in a code fence", () => {
		const raw =
			'```json\n{"notes":[{"category":"Pacing","note":"It drags here."}]}\n```';
		expect(parseCritique(raw)).toEqual([
			{ category: "Pacing", note: "It drags here." },
		]);
	});

	it("parses JSON with stray prose around it", () => {
		const raw =
			'Here is my feedback:\n{"notes":[{"category":"Tone","note":"Too stiff."}]}\nHope that helps.';
		expect(parseCritique(raw)).toEqual([
			{ category: "Tone", note: "Too stiff." },
		]);
	});

	it("drops malformed note items", () => {
		const raw =
			'{"notes":[{"category":"Clarity","note":"ok"},{"bad":true},{"category":1,"note":"x"}]}';
		expect(parseCritique(raw)).toEqual([{ category: "Clarity", note: "ok" }]);
	});

	it("returns [] for unparseable input", () => {
		expect(parseCritique("not json at all")).toEqual([]);
		expect(parseCritique("")).toEqual([]);
		expect(parseCritique('{"notes": "not an array"}')).toEqual([]);
	});
});
