import { describe, expect, it, vi } from "vitest";
import { settleCompletedEmbeddings } from "./embed";
import {
	completedProviderOutcomeIsUnknown,
	ProviderUsageSettlementError,
} from "./provider";
import { settleCompletedTransform } from "./transform";

describe("completed provider call settlement", () => {
	it("settles an empty transform before rejecting its output", async () => {
		const settle = vi.fn(async () => true);
		await expect(
			settleCompletedTransform({ output: "", settle }),
		).rejects.toThrow("returned nothing");
		expect(settle).toHaveBeenCalledOnce();
	});

	it("settles invalid embeddings before rejecting their shape", async () => {
		const settle = vi.fn(async () => true);
		await expect(
			settleCompletedEmbeddings({
				embeddings: [[1, 2, 3]],
				expectedCount: 1,
				settle,
			}),
		).rejects.toThrow("invalid embeddings");
		expect(settle).toHaveBeenCalledOnce();
	});

	it("keeps a failed settlement outcome unknown", async () => {
		const request = settleCompletedTransform({
			output: "result",
			settle: async () => {
				throw new Error("mutation failed");
			},
		});
		await expect(request).rejects.toBeInstanceOf(ProviderUsageSettlementError);
		expect(
			completedProviderOutcomeIsUnknown(new ProviderUsageSettlementError()),
		).toBe(true);
	});
});
