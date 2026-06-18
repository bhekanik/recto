import { describe, expect, it } from "vitest";

import { CHUNK_TARGET_CHARS, chunk } from "./chunk";

describe("chunk (plan 009 — paragraph-windowed RAG chunking)", () => {
	it("returns 0 chunks for empty / whitespace-only input", () => {
		expect(chunk("")).toEqual([]);
		expect(chunk("   \n\n  \n")).toEqual([]);
	});

	it("returns 1 chunk for a single short paragraph", () => {
		const md = "Just one paragraph of prose.";
		const chunks = chunk(md);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.text).toBe(md);
		expect(chunks[0]?.charStart).toBe(0);
		expect(chunks[0]?.charEnd).toBe(md.length);
	});

	it("is deterministic", () => {
		const md = "Para one.\n\nPara two.\n\nPara three.";
		expect(chunk(md)).toEqual(chunk(md));
	});

	it("char offsets slice back to the chunk text exactly", () => {
		const md =
			"# Title\n\nFirst paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.";
		for (const c of chunk(md)) {
			expect(md.slice(c.charStart, c.charEnd)).toBe(c.text);
			expect(c.charStart).toBeGreaterThanOrEqual(0);
			expect(c.charEnd).toBeLessThanOrEqual(md.length);
			expect(c.charStart).toBeLessThan(c.charEnd);
		}
	});

	it("packs multiple small paragraphs into one window under the target", () => {
		const md = "A short para.\n\nAnother short para.\n\nA third short para.";
		const chunks = chunk(md);
		// All well under target → a single window.
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.charEnd).toBe(md.length);
	});

	it("splits into multiple windows when paragraphs exceed the target", () => {
		const big = "X".repeat(CHUNK_TARGET_CHARS - 100);
		const md = `${big}\n\n${big}\n\n${big}`;
		const chunks = chunk(md);
		expect(chunks.length).toBeGreaterThan(1);
		// Every window covers at least one full paragraph.
		for (const c of chunks) {
			expect(c.text.trim().length).toBeGreaterThan(0);
		}
	});

	it("overlaps adjacent windows by one paragraph", () => {
		const p1 = "P1 ".repeat(200).trim(); // ~600 chars
		const p2 = "P2 ".repeat(200).trim();
		const p3 = "P3 ".repeat(200).trim();
		const md = `${p1}\n\n${p2}\n\n${p3}`;
		const chunks = chunk(md);
		expect(chunks.length).toBeGreaterThanOrEqual(2);
		// Consecutive windows should share a region (overlap), so window N+1 starts
		// before window N ends.
		for (let k = 1; k < chunks.length; k++) {
			const prev = chunks[k - 1];
			const cur = chunks[k];
			if (!prev || !cur) continue;
			expect(cur.charStart).toBeLessThan(prev.charEnd);
		}
	});

	it("always makes progress — a single oversized paragraph is its own chunk", () => {
		const huge = "Y".repeat(CHUNK_TARGET_CHARS * 3);
		const chunks = chunk(huge);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.text).toBe(huge);
	});
});
