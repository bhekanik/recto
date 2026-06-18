import { AI_CHAT_MODEL, AI_CRITIQUE_MAX_TOKENS } from "@/lib/ai/config";
import { openRouter, requireUser } from "@/lib/ai/server";
import {
	buildCritiqueMessages,
	type CritiqueRequestBody,
	parseCritique,
} from "@/lib/ai/transform-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Editorial critique (plan 009, Phase B). Returns READ-ONLY qualitative feedback
 * on the current section/document as a JSON `{ notes: [...] }` object. Applies no
 * edits and commits no nodes. A single structured response (no streaming needed —
 * critique is not an edit). The key stays server-side.
 */
export async function POST(req: Request): Promise<Response> {
	const userId = await requireUser();
	if (!userId) {
		return new Response("Unauthorized", { status: 401 });
	}

	let body: CritiqueRequestBody;
	try {
		body = (await req.json()) as CritiqueRequestBody;
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
		const completion = await client.chat.completions.create(
			{
				model: AI_CHAT_MODEL,
				max_tokens: AI_CRITIQUE_MAX_TOKENS,
				messages: buildCritiqueMessages(body),
			},
			{ signal: req.signal },
		);
		const raw = completion.choices?.[0]?.message?.content ?? "";
		const notes = parseCritique(raw);
		return Response.json({ notes });
	} catch (err) {
		if ((err as Error)?.name === "AbortError") {
			return new Response(null, { status: 499 });
		}
		return new Response("AI request failed", { status: 502 });
	}
}
