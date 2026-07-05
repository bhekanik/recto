/**
 * Shared request preamble for the AI route handlers (plan 009 / 011 / 016). Both
 * the transform and review routes open with the same guards in the same order —
 * authenticate (→401), parse the JSON body (→400), validate it (→400), require
 * `documentId` (→400) and reject shared documents (→403; plan 016), and construct
 * the OpenRouter client (→503) — before diverging into their own (streaming vs.
 * non-streaming) response shapes. This centralizes that preamble: the only
 * route-specific bit, body validation, is supplied as a callback so each route
 * keeps its own message and predicate.
 *
 * The shared-document check runs BEFORE client construction on purpose: a shared
 * doc must get 403 even when the OpenRouter key is missing (the boundary answer
 * beats the availability answer). The embed route keeps its hand-rolled preamble
 * (see app/api/ai/embed/route.ts for why) but reuses {@link rejectIfDocumentShared}
 * so the rule has one implementation.
 */

import "server-only";

import { auth } from "@clerk/nextjs/server";
import { fetchQuery } from "convex/nextjs";
import type OpenAI from "openai";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

import { openRouter, requireUser } from "./server";

/** A guarded request: the authed user, the OpenRouter client, and the body. */
export type GuardedAiRequest<T> = {
	userId: string;
	client: OpenAI;
	body: T;
};

/**
 * Enforce the no-AI-on-shared-documents rule server-side (plan 016 — the second
 * half of plan 010's "hide the affordances AND short-circuit the routes"). Asks
 * Convex `documentShareState` AS THE CALLER (Clerk token → authed `fetchQuery`),
 * so the answer uses exactly the visibility rules the client gate reads.
 *
 * Returns a `Response` to send back verbatim when the request must be blocked,
 * or `null` when the document is the caller's own un-shared doc and AI may run.
 *
 * Fail-closed by design — every outcome other than "owner, not shared" blocks:
 * - shared (owner side or grantee side) → 403
 * - not visible to the caller / nonexistent → 404 (mirrors the query's
 *   no-existence-leak `null`)
 * - the check itself failed (Convex/auth error) → 502
 *
 * This is the single enforcement point plan 010's future "owner opts a shared
 * doc back into AI" setting would consult.
 */
export async function rejectIfDocumentShared(
	documentId: string,
): Promise<Response | null> {
	let state: { shared: boolean } | null;
	try {
		const { getToken } = await auth();
		const token = (await getToken({ template: "convex" })) ?? undefined;
		state = await fetchQuery(
			api.review.documentShareState,
			{ documentId: documentId as Id<"documents"> },
			{ token },
		);
	} catch {
		// Fail closed: if shared-ness can't be determined, the boundary holds.
		return new Response("Could not verify document sharing", { status: 502 });
	}
	if (state === null) {
		return new Response("Document not found", { status: 404 });
	}
	if (state.shared) {
		return new Response("AI is disabled on shared documents", { status: 403 });
	}
	return null;
}

/**
 * Run the shared AI-route preamble. Returns a `Response` to send back verbatim
 * (the guard failed) OR the authed user, OpenRouter client, and validated body.
 * `validate` returns an error message to reject the body with `400`, or `null`
 * when the body is acceptable. Every guarded body must carry the `documentId`
 * of the document the AI is operating on (always the active document) so the
 * shared-document rule is enforceable; the guard checks it centrally.
 */
export async function guardAiRoute<T extends { documentId: string }>(
	req: Request,
	validate: (body: T) => string | null,
): Promise<Response | GuardedAiRequest<T>> {
	const userId = await requireUser();
	if (!userId) {
		return new Response("Unauthorized", { status: 401 });
	}

	let body: T;
	try {
		body = (await req.json()) as T;
	} catch {
		return new Response("Invalid JSON", { status: 400 });
	}
	const invalid = validate(body);
	if (invalid !== null) {
		return new Response(invalid, { status: 400 });
	}
	if (typeof body?.documentId !== "string" || body.documentId.length === 0) {
		return new Response("Missing documentId", { status: 400 });
	}
	const rejected = await rejectIfDocumentShared(body.documentId);
	if (rejected) {
		return rejected;
	}

	let client: OpenAI;
	try {
		client = openRouter();
	} catch {
		return new Response("AI provider not configured", { status: 503 });
	}

	return { userId, client, body };
}
