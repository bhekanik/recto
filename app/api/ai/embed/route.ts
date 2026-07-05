import { AI_EMBEDDING_DIM } from "@/lib/ai/config";
import { buildEmbedRequest } from "@/lib/ai/embed-request";
import { openRouter, requireUser } from "@/lib/ai/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type EmbedBody = { inputs: string[] };

/**
 * Embedding generation for RAG (plan 009, Phase C). Takes a batch of chunk texts
 * and returns their vectors. This is the on-demand client path: embed here, then
 * write chunks to Convex via a normal mutation. The embedding key
 * (`OPENROUTER_API_KEY`) lives in BOTH server envs — the Next server env (this
 * route) and the Convex deployment env (the daily `reindexSweep` cron in
 * convex/embeddings.ts embeds directly from Convex). Either way the key stays
 * server-side.
 *
 * Not folded into `guardAiRoute` (lib/ai/route-guard.ts): this route returns an
 * empty-success response for empty inputs BEFORE constructing the OpenRouter
 * client, whereas the guard constructs the client first — unifying would turn
 * that 200 into a 503 when the key is missing.
 */
export async function POST(req: Request): Promise<Response> {
	const userId = await requireUser();
	if (!userId) {
		return new Response("Unauthorized", { status: 401 });
	}

	let body: EmbedBody;
	try {
		body = (await req.json()) as EmbedBody;
	} catch {
		return new Response("Invalid JSON", { status: 400 });
	}
	if (!body || !Array.isArray(body.inputs)) {
		return new Response("Missing inputs", { status: 400 });
	}

	const request = buildEmbedRequest(body.inputs);
	if (request.input.length === 0) {
		return Response.json({ embeddings: [], dimensions: AI_EMBEDDING_DIM });
	}

	let client: ReturnType<typeof openRouter>;
	try {
		client = openRouter();
	} catch {
		return new Response("AI provider not configured", { status: 503 });
	}

	try {
		const res = await client.embeddings.create(request, {
			signal: req.signal,
		});
		const embeddings = res.data.map((d) => d.embedding as number[]);
		return Response.json({ embeddings, dimensions: AI_EMBEDDING_DIM });
	} catch (err) {
		if ((err as Error)?.name === "AbortError") {
			return new Response(null, { status: 499 });
		}
		return new Response("Embedding request failed", { status: 502 });
	}
}
