import { describe, expect, it } from "vitest";
import type { Id } from "./_generated/dataModel";
import { type RelatedPassage, selectPassages } from "./embeddings";

const docA = "docA" as Id<"documents">;
const docB = "docB" as Id<"documents">;
const active = "active" as Id<"documents">;

function passage(
	documentId: Id<"documents">,
	charStart: number,
	charEnd: number,
	score: number,
): RelatedPassage {
	return { documentId, title: documentId, text: "", charStart, charEnd, score };
}

describe("selectPassages", () => {
	it("drops the active document's own chunks", () => {
		const out = selectPassages(
			[passage(active, 0, 100, 0.99), passage(docA, 0, 100, 0.5)],
			active,
		);
		expect(out.map((p) => p.documentId)).toEqual([docA]);
	});

	it("keeps the best of two overlapping chunks from one document", () => {
		const out = selectPassages(
			[
				passage(docA, 900, 2000, 0.6),
				passage(docA, 0, 1000, 0.7),
				passage(docA, 2000, 3000, 0.4),
			],
			undefined,
		);
		expect(out.map((p) => [p.charStart, p.score])).toEqual([
			[0, 0.7],
			[2000, 0.4],
		]);
	});

	it("caps passages per document so one long draft cannot fill the panel", () => {
		const rows = [0, 1, 2, 3, 4].map((i) =>
			passage(docA, i * 1000, i * 1000 + 500, 0.9 - i * 0.01),
		);
		const out = selectPassages(
			[...rows, passage(docB, 0, 500, 0.2)],
			undefined,
		);
		expect(out.filter((p) => p.documentId === docA)).toHaveLength(3);
		expect(out.at(-1)?.documentId).toBe(docB);
	});

	it("returns at most eight, best first", () => {
		const rows = Array.from({ length: 12 }, (_, i) =>
			passage(`doc${i}` as Id<"documents">, 0, 100, i / 100),
		);
		const out = selectPassages(rows, undefined);
		expect(out).toHaveLength(8);
		expect(out[0]?.score).toBe(0.11);
	});
});
