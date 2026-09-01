import { httpRouter } from "convex/server";
import { z } from "zod";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { errorCode, errorMessage, httpStatusForAiError } from "./ai/errors";
import { executePreparedTransform, prepareTransform } from "./ai/transform";
import { MAX_UPLOAD_BYTES, UPLOAD_TOO_LARGE_MESSAGE } from "./files";

/**
 * Server-mediated image upload (ADR-21).
 *
 * The previous protocol had the client ask for a signed URL, POST the bytes
 * straight to storage, and then call a mutation to record who owned the result.
 * The file exists from the moment the POST completes, so anything that stopped
 * the second call — a crash, a closed tab, a rejected mutation, an account
 * deletion landing in between — left a file with no owner. Nothing could then
 * attribute it, and account deletion could not find it.
 *
 * Here the bytes and the ownership row are the server's problem: `store` and
 * `claimUpload` both happen before the client is told anything, and a claim
 * that is refused (the account is being deleted) deletes the file it just
 * stored rather than leaving it behind.
 */

const ALLOWED_HEADERS = "Content-Type, Authorization, Digest";

function corsHeaders(origin: string | null): Record<string, string> {
	return {
		// The studio is served from a different origin than convex.site, so the
		// browser preflights this. Echoing the origin rather than `*` keeps
		// credentialed requests legal.
		"Access-Control-Allow-Origin": origin ?? "*",
		Vary: "Origin",
		"Access-Control-Allow-Methods": "POST, OPTIONS",
		"Access-Control-Allow-Headers": ALLOWED_HEADERS,
		"Access-Control-Max-Age": "86400",
	};
}

function json(body: unknown, status: number, origin: string | null): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
	});
}

const uploadImage = httpAction(async (ctx, request) => {
	const origin = request.headers.get("Origin");

	const identity = await ctx.auth.getUserIdentity();
	if (!identity) return json({ error: "Unauthenticated" }, 401, origin);

	// Checked before reading the body so an oversized upload is refused without
	// buffering it. `content-length` is advisory, hence the second check below.
	const declared = Number(request.headers.get("Content-Length") ?? "0");
	if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
		return json({ error: UPLOAD_TOO_LARGE_MESSAGE }, 413, origin);
	}

	const blob = await request.blob();
	if (blob.size === 0) return json({ error: "Empty upload" }, 400, origin);
	if (blob.size > MAX_UPLOAD_BYTES) {
		return json({ error: UPLOAD_TOO_LARGE_MESSAGE }, 413, origin);
	}

	const storageId = await ctx.storage.store(blob);
	let url: string | null;
	try {
		url = await ctx.runMutation(internal.files.claimUpload, {
			storageId,
			userId: identity.subject,
		});
	} catch (error) {
		// An unclaimed file is one nothing can attribute later, which is the whole
		// failure this endpoint exists to remove.
		await ctx.storage.delete(storageId);
		return json(
			{ error: error instanceof Error ? error.message : "Upload failed" },
			409,
			origin,
		);
	}

	if (url === null) {
		await ctx.runMutation(internal.files.deleteStoredFile, { storageId });
		return json({ error: "Stored file could not be resolved" }, 500, origin);
	}

	return json({ storageId, url }, 200, origin);
});

const uploadImageLegacy = httpAction(async (ctx, request) => {
	const origin = request.headers.get("Origin");
	const token = new URL(request.url).searchParams.get("token");
	if (!token) return json({ error: "Invalid upload URL" }, 401, origin);

	const declared = Number(request.headers.get("Content-Length") ?? "0");
	if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
		return json({ error: UPLOAD_TOO_LARGE_MESSAGE }, 413, origin);
	}
	const blob = await request.blob();
	if (blob.size === 0) return json({ error: "Empty upload" }, 400, origin);
	if (blob.size > MAX_UPLOAD_BYTES) {
		return json({ error: UPLOAD_TOO_LARGE_MESSAGE }, 413, origin);
	}

	const storageId = await ctx.storage.store(blob);
	try {
		const claim = await ctx.runMutation(internal.files.consumeLegacyUpload, {
			token,
			storageId,
		});
		if (!claim.accepted || claim.url === null) {
			await ctx.storage.delete(storageId);
			return json({ error: "Upload URL expired" }, 401, origin);
		}
		return json({ storageId, url: claim.url }, 200, origin);
	} catch (error) {
		await ctx.storage.delete(storageId);
		return json(
			{ error: error instanceof Error ? error.message : "Upload failed" },
			409,
			origin,
		);
	}
});

const transformHttpBodySchema = z.object({
	requestId: z.string(),
	documentId: z.string(),
	sourceNodeId: z.string(),
	sourceHash: z.string(),
	instruction: z.string(),
	selection: z.string(),
	platform: z.string(),
	traceContent: z.boolean(),
});

const aiTransform = httpAction(async (ctx, request) => {
	const origin = request.headers.get("Origin");
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) return json({ error: "Unauthenticated" }, 401, origin);
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return json({ error: "Invalid JSON" }, 400, origin);
	}
	const parsed = transformHttpBodySchema.safeParse(raw);
	if (!parsed.success)
		return json({ error: "Invalid AI transform request" }, 400, origin);
	const body = parsed.data;
	const documentId = await ctx.runQuery(internal.ai.runs.normalizeDocumentId, {
		value: body.documentId,
	});
	if (!documentId) return json({ error: "Document not found" }, 404, origin);

	let prepared: Awaited<ReturnType<typeof prepareTransform>>;
	try {
		prepared = await prepareTransform(ctx, { ...body, documentId });
	} catch (error) {
		const failure =
			error instanceof Error ? error : new Error("AI request failed");
		return json(
			{ error: errorMessage(failure), code: errorCode(failure) },
			httpStatusForAiError(failure),
			origin,
		);
	}
	if (prepared.kind !== "prepared") {
		return new Response(prepared.output, {
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": "no-store",
				...corsHeaders(origin),
			},
		});
	}
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				await executePreparedTransform(
					prepared,
					(delta) => {
						controller.enqueue(encoder.encode(delta));
					},
					request.signal,
				);
				controller.close();
			} catch (error) {
				controller.error(error);
			}
		},
	});
	return new Response(stream, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-store",
			"X-Accel-Buffering": "no",
			...corsHeaders(origin),
		},
	});
});

const http = httpRouter();

http.route({ path: "/upload-image", method: "POST", handler: uploadImage });
http.route({ path: "/ai/transform", method: "POST", handler: aiTransform });
http.route({
	path: "/upload-image-legacy",
	method: "POST",
	handler: uploadImageLegacy,
});
http.route({
	path: "/ai/transform",
	method: "OPTIONS",
	handler: httpAction(
		async (_ctx, request) =>
			new Response(null, {
				status: 204,
				headers: corsHeaders(request.headers.get("Origin")),
			}),
	),
});
http.route({
	path: "/upload-image",
	method: "OPTIONS",
	handler: httpAction(
		async (_ctx, request) =>
			new Response(null, {
				status: 204,
				headers: corsHeaders(request.headers.get("Origin")),
			}),
	),
});
http.route({
	path: "/upload-image-legacy",
	method: "OPTIONS",
	handler: httpAction(
		async (_ctx, request) =>
			new Response(null, {
				status: 204,
				headers: corsHeaders(request.headers.get("Origin")),
			}),
	),
});

export default http;
