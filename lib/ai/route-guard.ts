/**
 * Shared request preamble for the AI route handlers (plan 009 / 011). Both the
 * transform and review routes open with the same guards in the same order —
 * authenticate (→401), parse the JSON body (→400), validate it (→400), and
 * construct the OpenRouter client (→503) — before diverging into their own
 * (streaming vs. non-streaming) response shapes. This centralizes that preamble:
 * the only route-specific bit, body validation, is supplied as a callback so each
 * route keeps its own message and predicate.
 */

import "server-only";

import type OpenAI from "openai";

import { openRouter, requireUser } from "./server";

/** A guarded request: the authed user, the OpenRouter client, and the body. */
export type GuardedAiRequest<T> = {
	userId: string;
	client: OpenAI;
	body: T;
};

/**
 * Run the shared AI-route preamble. Returns a `Response` to send back verbatim
 * (the guard failed) OR the authed user, OpenRouter client, and validated body.
 * `validate` returns an error message to reject the body with `400`, or `null`
 * when the body is acceptable.
 */
export async function guardAiRoute<T>(
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

	let client: OpenAI;
	try {
		client = openRouter();
	} catch {
		return new Response("AI provider not configured", { status: 503 });
	}

	return { userId, client, body };
}
