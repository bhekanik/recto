import { ConvexError } from "convex/values";
import { z } from "zod";

export type AiErrorCode =
	| "account_deletion_in_progress"
	| "ai_consent_required"
	| "ai_credential_required"
	| "ai_rate_limited"
	| "document_changed"
	| "document_not_found"
	| "document_shared"
	| "invalid_argument"
	| "request_conflict"
	| "request_in_progress"
	| "request_outcome_unknown"
	| "unauthenticated";

export function aiError(code: AiErrorCode, message: string): never {
	throw new ConvexError({ code, message });
}

const errorDataSchema = z.object({
	data: z.object({ code: z.string(), message: z.string().optional() }),
});

export function errorCode(error: Error): string {
	return (
		errorDataSchema.safeParse(error).data?.data.code ?? "ai_provider_failed"
	);
}

export function errorMessage(error: Error): string {
	return errorDataSchema.safeParse(error).data?.data.message ?? error.message;
}

export function httpStatusForAiError(error: Error): number {
	switch (errorCode(error)) {
		case "unauthenticated":
			return 401;
		case "document_not_found":
			return 404;
		case "ai_rate_limited":
			return 429;
		case "invalid_argument":
			return 400;
		case "account_deletion_in_progress":
		case "ai_consent_required":
		case "ai_credential_required":
		case "document_shared":
			return 403;
		case "document_changed":
		case "request_conflict":
		case "request_in_progress":
		case "request_outcome_unknown":
			return 409;
		default:
			return 503;
	}
}
