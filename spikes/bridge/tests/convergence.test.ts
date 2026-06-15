import { describe, expect, it } from "vitest";
import { diffRanges } from "../src/bridge/diff-ranges.ts";
import { Bridge } from "../src/bridge/protocol.ts";
import {
	normalizeMarkdown,
	parseMarkdown,
	stringifyMdast,
} from "../src/canonical/markdown.ts";

describe("canonical serialization convergence", () => {
	it("produces deterministic bytes for a given MDAST", () => {
		const md = "# Hello\n\n_world_ and **bold**.\n";
		const once = normalizeMarkdown(md);
		const twice = normalizeMarkdown(once);
		expect(twice).toBe(once);
	});

	it("stringify(parse(x)) is stable across cycles", () => {
		const md = normalizeMarkdown("- a\n- b\n\n```ts\nconst x = 1;\n```\n");
		for (let i = 0; i < 5; i++) {
			const next = stringifyMdast(parseMarkdown(md));
			expect(next).toBe(md);
		}
	});
});

describe("diffRanges", () => {
	it("finds minimal contiguous change", () => {
		const prev = "hello world";
		const next = "hello brave world";
		expect(diffRanges(prev, next)).toEqual({
			from: 6,
			to: 6,
			insert: "brave ",
		});
	});

	it("returns empty-range insert for append", () => {
		expect(diffRanges("ab", "abc")).toEqual({ from: 2, to: 2, insert: "c" });
	});
});

describe("Bridge feedback-loop guards", () => {
	it("blocks propagation while applying", () => {
		const bridge = new Bridge();
		bridge.beginApplying();
		expect(bridge.shouldPropagate(false)).toBe(false);
		bridge.endApplying();
		expect(bridge.shouldPropagate(false)).toBe(true);
	});

	it("blocks programmatic changes", () => {
		const bridge = new Bridge();
		expect(bridge.shouldPropagate(true)).toBe(false);
	});

	it("drops stale projections", () => {
		const bridge = new Bridge();
		bridge.bumpVersion();
		bridge.bumpVersion();
		expect(bridge.isStale(1)).toBe(true);
		expect(bridge.isStale(2)).toBe(false);
	});

	it("single human edit yields one bumpVersion without echo", () => {
		const bridge = new Bridge();
		const start = bridge.currentVersion;
		expect(bridge.shouldPropagate(false)).toBe(true);
		const v = bridge.bumpVersion();
		expect(v).toBe(start + 1);
		// Simulated echo from programmatic update.
		expect(bridge.shouldPropagate(true)).toBe(false);
		expect(bridge.currentVersion).toBe(v);
	});
});
