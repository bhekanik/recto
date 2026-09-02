import { describe, expect, it } from "vitest";
import {
	type EmbeddingSweepProgress,
	nextEmbeddingSweepProgress,
} from "./embeddings";

describe("embedding sweep progress", () => {
	it("advances beyond a permanently failing prefix and publishes only a full scan", () => {
		let progress: EmbeddingSweepProgress | undefined;
		for (let page = 0; page < 11; page += 1) {
			progress = nextEmbeddingSweepProgress({
				previous: progress,
				startedAtBeginning: page === 0,
				isDone: page === 10,
				continueCursor: `page-${page + 1}`,
				pageStaleCount: page === 0 ? 25 : 1,
				pageScannedCount: page === 10 ? 6 : 25,
				resolvedCount: page === 0 ? 0 : 1,
			});
			if (page < 10) {
				expect(progress.sweepCursor).toBe(`page-${page + 1}`);
				expect(progress.hasCompletedSweep).toBe(false);
			}
		}

		expect(progress).toEqual({
			staleCount: 25,
			scannedCount: 256,
			hasCompletedSweep: true,
		});
	});
});
