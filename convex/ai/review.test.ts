import { describe, expect, it } from "vitest";
import {
	applySuggestions,
	locateQuote,
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

	it("applies an edit to a repeated quote when its context names one occurrence", () => {
		const result = applySuggestions("alpha beta alpha", [
			{ quote: "alpha", prefix: "beta ", replacement: "A" },
		]);
		expect(result).toEqual({ text: "alpha beta A", applied: 1 });
	});
});

describe("AI review quote placement", () => {
	const text = "The plan is fine. The plan is late. The end.";

	it("places a unique quote without context", () => {
		expect(locateQuote(text, { quote: "The end." })).toBe(36);
	});

	it("places a repeated quote by its suffix", () => {
		expect(locateQuote(text, { quote: "The plan", suffix: " is late" })).toBe(
			18,
		);
	});

	it("places a repeated quote by its prefix", () => {
		expect(locateQuote(text, { quote: "The plan", prefix: "fine. " })).toBe(18);
	});

	it("drops a repeated quote with no context, never guessing", () => {
		expect(locateQuote(text, { quote: "The plan" })).toBeNull();
	});

	it("drops a repeated quote whose context fits every occurrence or none", () => {
		expect(locateQuote(text, { quote: "The plan", suffix: " is" })).toBeNull();
		expect(
			locateQuote(text, { quote: "The plan", suffix: " was cut" }),
		).toBeNull();
	});

	it("drops a quote that is not in the text", () => {
		expect(locateQuote(text, { quote: "the plan" })).toBeNull();
	});
});

function toolCallClient(args: object): ReviewCompletionClient {
	let calls = 0;
	return {
		chat: {
			completions: {
				create: async () => {
					calls += 1;
					return {
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
						choices: [
							{
								finish_reason: calls === 1 ? "tool_calls" : "stop",
								index: 0,
								logprobs: null,
								message: {
									role: "assistant",
									content: calls === 1 ? null : "Done",
									refusal: null,
									...(calls === 1
										? {
												tool_calls: [
													{
														id: "call-1",
														type: "function" as const,
														function: {
															name: "create_comment",
															arguments: JSON.stringify(args),
														},
													},
												],
											}
										: {}),
								},
							},
						],
					};
				},
			},
		},
	};
}

describe("AI review comment categories", () => {
	it("keeps a known category and the context fields", async () => {
		const { result } = await reviewWithTools({
			client: toolCallClient({
				quote: "draft",
				prefix: "my ",
				body: "note",
				category: "Clarity",
			}),
			text: "my draft",
			settle: async () => {},
		});
		expect(result.comments).toEqual([
			{ quote: "draft", prefix: "my ", body: "note", category: "Clarity" },
		]);
	});

	it("keeps the comment but drops a category outside the fixed set", async () => {
		const { result } = await reviewWithTools({
			client: toolCallClient({
				quote: "draft",
				body: "note",
				category: "Vibes",
			}),
			text: "my draft",
			settle: async () => {},
		});
		expect(result.comments).toEqual([{ quote: "draft", body: "note" }]);
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
