import type OpenAI from "openai";
import { AI_CHAT_MODEL, AI_REVIEW_MAX_TOKENS } from "@/lib/ai/config";
import {
	buildReviewMessages,
	parseReview,
	type ReviewRequestBody,
} from "@/lib/ai/review";
import { openRouter, requireUser } from "@/lib/ai/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AI review (plan 011, Phase A). Returns structured feedback naming the EXACT
 * text each comment/edit attaches to as a JSON `{ comments, suggestions }`
 * object. The route only calls the LLM and parses its reply — it performs NO
 * Convex writes (the client hook anchors the comments and creates them through
 * plan 010's mutations). A single structured response (no streaming). The key
 * stays server-side. Mirrors the critique route's shape.
 */
export async function POST(req: Request): Promise<Response> {
	const userId = await requireUser();
	if (!userId) {
		return new Response("Unauthorized", { status: 401 });
	}

	let body: ReviewRequestBody;
	try {
		body = (await req.json()) as ReviewRequestBody;
	} catch {
		return new Response("Invalid JSON", { status: 400 });
	}
	if (!body || typeof body.text !== "string" || body.text.trim().length === 0) {
		return new Response("Missing text", { status: 400 });
	}

	let client: ReturnType<typeof openRouter>;
	try {
		client = openRouter();
	} catch {
		return new Response("AI provider not configured", { status: 503 });
	}

	try {
		const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
			reasoning?: { enabled: boolean };
		} = {
			model: AI_CHAT_MODEL,
			max_tokens: AI_REVIEW_MAX_TOKENS,
			messages: buildReviewMessages(body),
			// OpenRouter extension: disable GLM 5.2 reasoning so the JSON output
			// isn't starved by reasoning tokens.
			reasoning: { enabled: false },
		};
		const completion = await client.chat.completions.create(params, {
			signal: req.signal,
		});
		const raw = completion.choices?.[0]?.message?.content ?? "";
		const result = parseReview(raw);
		return Response.json(result);
	} catch (err) {
		if ((err as Error)?.name === "AbortError") {
			return new Response(null, { status: 499 });
		}
		return new Response("AI request failed", { status: 502 });
	}
}
