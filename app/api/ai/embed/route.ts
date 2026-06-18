import { AI_EMBEDDING_DIM } from "@/lib/ai/config";
import { buildEmbedRequest } from "@/lib/ai/embed-request";
import { openRouter, requireUser } from "@/lib/ai/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type EmbedBody = { inputs: string[] };

/**
 * Embedding generation for RAG (plan 009, Phase C). Takes a batch of chunk texts
 * and returns their vectors. Lives in Next (not Convex) because the embedding key
 * (`OPENROUTER_API_KEY`) is in the Next server env per the provider override. The
 * client orchestrates re-indexing: embed here, then write chunks to Convex via a
 * normal mutation. The key stays server-side.
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
