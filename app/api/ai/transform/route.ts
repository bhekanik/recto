import type OpenAI from "openai";
import { AI_CHAT_MODEL, AI_TRANSFORM_MAX_TOKENS } from "@/lib/ai/config";
import { guardAiRoute } from "@/lib/ai/route-guard";
import {
	buildTransformMessages,
	type TransformRequestBody,
} from "@/lib/ai/transform-request";

export const runtime = "nodejs";
// Streaming response; never cache.
export const dynamic = "force-dynamic";

/**
 * Reversible AI selection transform (plan 009, Phase A). Streams a rewritten
 * span of the selected text back to the client as plain text chunks. The client
 * accumulates the stream, then commits the result as an undo-tree node — so the
 * edit is reversible by construction (reject = undo). The key stays server-side.
 */
export async function POST(req: Request): Promise<Response> {
	const guarded = await guardAiRoute<TransformRequestBody>(req, (body) =>
		!body ||
		typeof body.instruction !== "string" ||
		typeof body.selection !== "string" ||
		body.selection.length === 0
			? "Missing instruction or selection"
			: null,
	);
	if (guarded instanceof Response) return guarded;
	const { client, body } = guarded;

	const messages = buildTransformMessages(body);
	const encoder = new TextEncoder();

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & {
					reasoning?: { enabled: boolean };
				} = {
					model: AI_CHAT_MODEL,
					max_tokens: AI_TRANSFORM_MAX_TOKENS,
					stream: true,
					messages,
					// OpenRouter extension: GLM 5.2 is a reasoning model; disable
					// reasoning so content streams immediately for short edits.
					reasoning: { enabled: false },
				};
				const completion = await client.chat.completions.create(params, {
					// Abort the upstream request when the client disconnects.
					signal: req.signal,
				});
				for await (const part of completion) {
					const delta = part.choices?.[0]?.delta?.content ?? "";
					if (delta) controller.enqueue(encoder.encode(delta));
				}
				controller.close();
			} catch (err) {
				// AbortError on client disconnect is expected — close quietly.
				if ((err as Error)?.name === "AbortError") {
					try {
						controller.close();
					} catch {
						// already closed
					}
					return;
				}
				controller.error(err);
			}
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-store",
			"X-Accel-Buffering": "no",
		},
	});
}
