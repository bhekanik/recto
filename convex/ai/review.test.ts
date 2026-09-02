import { describe, expect, it } from "vitest";
import {
	applySuggestions,
	ProviderUsageSettlementError,
	type ReviewCompletionClient,
	reviewOutcomeIsUnknown,
	reviewWithTools,
} from "./review";

describe("AI review suggestion accounting", () => {
	it("counts only unique, non-overlapping, material edits", () => {
		const result = applySuggestions("alpha beta alpha", [
			{ quote: "beta", replacement: "BETA" },
			{ quote: "alpha", replacement: "A" },
			{ quote: "alpha beta", replacement: "AB" },
			{ quote: "beta", replacement: "beta" },
		]);
		expect(result).toEqual({ text: "alpha BETA alpha", applied: 1 });
	});
});

describe("AI review provider settlement", () => {
	it("keeps a completed call outcome unknown when usage persistence fails", async () => {
		const client: ReviewCompletionClient = {
			chat: {
				completions: {
					create: async () => ({
						usage: {
							prompt_tokens: 10,
							completion_tokens: 2,
							total_tokens: 12,
						},
						choices: [
							{
								finish_reason: "stop",
								index: 0,
								logprobs: null,
								message: {
									role: "assistant",
									content: "Done",
									refusal: null,
								},
							},
						],
					}),
				},
			},
		};

		const request = reviewWithTools({
			client,
			text: "draft",
			settle: async () => {
				throw new Error("request_conflict");
			},
		});

		await expect(request).rejects.toBeInstanceOf(ProviderUsageSettlementError);
		expect(reviewOutcomeIsUnknown(new ProviderUsageSettlementError())).toBe(
			true,
		);
	});

	it("settles one completion before it can issue the next", async () => {
		const settled: number[] = [];
		let callCount = 0;
		const client: ReviewCompletionClient = {
			chat: {
				completions: {
					create: async () => {
						callCount += 1;
						if (callCount > 1) {
							expect(settled).toEqual([0]);
							throw new Error("provider rejected follow-up");
						}
						return {
							usage: {
								prompt_tokens: 10,
								completion_tokens: 2,
								total_tokens: 12,
								cost: 0.000021,
							},
							choices: [
								{
									finish_reason: "tool_calls",
									index: 0,
									logprobs: null,
									message: {
										role: "assistant",
										content: null,
										refusal: null,
										tool_calls: [
											{
												id: "call-1",
												type: "function",
												function: {
													name: "create_comment",
													arguments: JSON.stringify({
														quote: "draft",
														body: "note",
													}),
												},
											},
										],
									},
								},
							],
						};
					},
				},
			},
		};

		await expect(
			reviewWithTools({
				client,
				text: "draft",
				settle: async ({ callIndex }) => {
					settled.push(callIndex);
				},
			}),
		).rejects.toThrow("provider rejected follow-up");
		expect(settled).toEqual([0]);
		expect(callCount).toBe(2);
	});
});
