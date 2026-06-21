import type OpenAI from "openai";
import { AI_REVIEW_MAX_TOKENS } from "@/lib/ai/config";
import { buildReviewMessages, type ReviewRequestBody } from "@/lib/ai/review";
import { runReviewLoop } from "@/lib/ai/review-loop";
import { guardAiRoute } from "@/lib/ai/route-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AI review (plan 011, tool-calling variant). Runs a server-side TOOL-CALLING
 * loop: the model leaves feedback by calling the `create_comment` / `suggest_edit`
 * tools across one or more turns, and `runReviewLoop` collects every well-formed
 * call into the SAME `{ comments, suggestions }` object this route has always
 * returned — so the client hook and plan 010's anchor/branch primitives are
 * unchanged. The route still performs NO Convex writes (the client hook anchors
 * the comments and creates them through plan 010's mutations). The key stays
 * server-side. The loop is bounded by AI_REVIEW_MAX_ITERATIONS and honors the
 * request AbortSignal across every iteration.
 */
export async function POST(req: Request): Promise<Response> {
	const guarded = await guardAiRoute<ReviewRequestBody>(req, (body) =>
		!body || typeof body.text !== "string" || body.text.trim().length === 0
			? "Missing text"
			: null,
	);
	if (guarded instanceof Response) return guarded;
	const { client, body } = guarded;

	try {
		const { comments, suggestions } = await runReviewLoop(
			client,
			buildReviewMessages(
				body,
			) as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
			{ maxTokens: AI_REVIEW_MAX_TOKENS, signal: req.signal },
		);
		return Response.json({ comments, suggestions });
	} catch (err) {
		if ((err as Error)?.name === "AbortError") {
			return new Response(null, { status: 499 });
		}
		return new Response("AI request failed", { status: 502 });
	}
}
