import type { GenericActionCtx } from "convex/server";
import { internal } from "../_generated/api";
import type { DataModel, Id } from "../_generated/dataModel";
import { aiError } from "./errors";

export const MAX_AI_TEXT_BYTES = 950_000;
export const MAX_REQUEST_ID_LENGTH = 128;

type ActionCtx = GenericActionCtx<DataModel>;

export function utf8Length(value: string): number {
	return new TextEncoder().encode(value).length;
}

export async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export async function requireActionUserId(ctx: ActionCtx): Promise<string> {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) aiError("unauthenticated", "Unauthenticated");
	return identity.subject;
}

export function validateRequestIdentity(requestId: string): void {
	if (
		requestId.trim().length === 0 ||
		requestId.length > MAX_REQUEST_ID_LENGTH
	) {
		aiError("invalid_argument", "Invalid AI request id.");
	}
}

export async function verifySource(
	ctx: ActionCtx,
	args: {
		userId: string;
		documentId: Id<"documents">;
		sourceNodeId: string;
		sourceHash: string;
	},
): Promise<string> {
	const source = await ctx.runQuery(internal.ai.runs.sourceForRequest, {
		userId: args.userId,
		documentId: args.documentId,
		sourceNodeId: args.sourceNodeId,
	});
	if ((await sha256(source)) !== args.sourceHash) {
		aiError(
			"document_changed",
			"The document changed before the AI request started.",
		);
	}
	return source;
}

type AiRequestPayload = Record<string, string | string[]>;

export async function requestHash(value: AiRequestPayload): Promise<string> {
	return await sha256(JSON.stringify(value));
}
