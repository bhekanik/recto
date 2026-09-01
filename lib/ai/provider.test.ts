import { describe, expect, it } from "vitest";
import {
	flushProvider,
	parseProviderUsage,
	providerOutcomeIsUnknown,
} from "@/convex/ai/provider";

describe("OpenRouter usage", () => {
	it("keeps LangSmith flush failure best-effort", async () => {
		await expect(
			flushProvider({
				flush: async () => {
					throw new Error("trace down");
				},
			}),
		).resolves.toBeUndefined();
	});
	it("converts provider dollars to integer micros", () => {
		expect(
			parseProviderUsage({
				prompt_tokens: 12,
				completion_tokens: 4,
				cost: 0.000123,
				completion_tokens_details: { reasoning_tokens: 2 },
			}),
		).toEqual({
			promptTokens: 12,
			completionTokens: 4,
			reasoningTokens: 2,
			costMicros: 123,
		});
	});

	it.each([
		new DOMException("Aborted", "AbortError"),
		Object.assign(new Error("timeout"), { name: "APIConnectionTimeoutError" }),
		new TypeError("network"),
	])("keeps abort, timeout and network failures outcome-unknown", (error) => {
		expect(providerOutcomeIsUnknown(error)).toBe(true);
	});

	it("allows an explicit provider rejection to be terminal", () => {
		expect(providerOutcomeIsUnknown(new Error("400 Bad Request"))).toBe(false);
	});
});
