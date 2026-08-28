import { ConvexError } from "convex/values";

import { TERMINAL_REFUSAL_CODES } from "@/convex/documents";

/**
 * What a rejected Convex mutation promise actually means.
 *
 * Convex retries offline and internal failures itself, and closes/reconnects
 * the socket for platform load shedding, so most of those never reach a
 * `.catch` at all. What DOES reach one is a mixed bag, and the difference
 * matters: an OCC conflict that outlived Convex's own retries, or an
 * application rate limiter, will succeed on an identical later call, while a
 * validation or size refusal never will. Treating the first kind as terminal
 * freezes a healthy document and offers the writer only a destructive way out.
 *
 * The server marks the refusals it OWNS by throwing `ConvexError({code, ...})`
 * and publishes which of those codes are terminal. `unauthenticated` is
 * deliberately NOT one of them: a short-lived Clerk token can expire between
 * queued writes, and the same call succeeds once it is refreshed. The code —
 * not the message, which drifts — is the signal; anything without one is
 * transient until proven otherwise.
 */
export type Refusal = {
	message: string;
	/**
	 * The server classified it AND said re-sending cannot change the answer.
	 * A coded-but-not-terminal refusal (`unauthenticated`) is offered as Retry.
	 */
	terminal: boolean;
	/** The server's own refusal code, when it classified the failure. */
	code?: string;
	/** How long a rate limiter asked us to wait, in ms. */
	retryAfterMs?: number;
};

/** Read `data` off a ConvexError without trusting its shape. */
function errorData(error: unknown): Record<string, unknown> | null {
	if (!(error instanceof ConvexError)) return null;
	const data: unknown = error.data;
	if (typeof data !== "object" || data === null) return null;
	return data as Record<string, unknown>;
}

export function classifyRefusal(error: unknown): Refusal {
	const message = error instanceof Error ? error.message : String(error);
	const data = errorData(error);
	const code = data && typeof data.code === "string" ? data.code : undefined;
	// The Convex rate limiter throws a ConvexError carrying `retryAfter` and no
	// refusal code. It is explicitly retryable, so it must not go terminal.
	const retryAfterMs =
		data && typeof data.retryAfter === "number" ? data.retryAfter : undefined;
	return {
		// A ConvexError's own `message` is the JSON of its data, so the readable
		// one is inside. Everything that renders a message must go through here.
		message: data && typeof data.message === "string" ? data.message : message,
		terminal:
			code !== undefined &&
			(TERMINAL_REFUSAL_CODES as ReadonlySet<string>).has(code),
		code,
		retryAfterMs,
	};
}
