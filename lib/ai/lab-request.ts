import { ConvexError } from "convex/values";

import type { Id } from "@/convex/_generated/dataModel";
import { type AiRequestOwner, sha256Text } from "./request-owner";

/** The synced draft a Lab pass reads: the server's head and its text. */
export type LabSource = { sourceNodeId: string; markdown: string };

/** What every `ai/lab:*` action takes besides its own arguments. */
export type LabBaseArgs = {
	requestId: string;
	documentId: Id<"documents">;
	sourceNodeId: string;
	sourceHash: string;
	platform: string;
	traceContent: boolean;
};

export type LabOutcome<T> =
	| { status: "done"; result: T; source: LabSource }
	| { status: "failed"; message: string }
	/** Superseded: another document, or the hook went away. Show nothing. */
	| { status: "stale" };

type LeftoverRun = { requestId: string; status: string } | null;

export type LabRequestDeps = {
	owner: AiRequestOwner;
	documentId: Id<"documents">;
	/** The document the Studio shows now, read when each step returns. */
	currentDocumentId: () => string | null;
	/** Push the writer's edits and name the synced head, or say why not. */
	source: (signal: AbortSignal) => Promise<LabSource | { error: string }>;
	latestRun: () => Promise<LeftoverRun>;
	acknowledge: (requestId: string) => Promise<boolean>;
};

const STILL_RUNNING = "An AI request on this document is still running.";
const UNCLAIMED = "The Lab's result could not be claimed. Try again.";

/** The server's refusals, in words the writer can act on (`AIClient.explain`). */
export function explainLabError(error: unknown): string {
	if (!(error instanceof ConvexError)) {
		return "The Lab could not finish. Try again.";
	}
	const data: unknown = error.data;
	const code =
		typeof data === "object" && data !== null && "code" in data
			? String(data.code)
			: undefined;
	const message =
		typeof data === "object" &&
		data !== null &&
		"message" in data &&
		typeof data.message === "string"
			? data.message
			: "The Lab could not finish. Try again.";
	switch (code) {
		case "document_shared":
			return "AI is off on shared documents.";
		case "document_changed":
			return "The document changed while the request started. Try again.";
		case "ai_rate_limited":
			return "Too many AI requests. Wait a minute and try again.";
		case "request_in_progress":
		case "request_outcome_unknown":
			return STILL_RUNNING;
		default:
			return message;
	}
}

/**
 * One Lab request on the transform's lifecycle, as the Mac's `AIClient` runs
 * it: own the request before anything yields, read the synced source, clear a
 * leftover Lab run (a Lab result is only a proposal, so acknowledging one
 * loses nothing), send, then acknowledge so the result is this client's to
 * show. A request superseded at any step returns `stale` and nothing of it
 * may show.
 */
export async function runLabRequest<T>(
	deps: LabRequestDeps,
	call: (args: LabBaseArgs, source: LabSource) => Promise<T>,
): Promise<LabOutcome<T>> {
	const { owner, documentId } = deps;
	const ticket = owner.begin(documentId);
	const current = () => owner.isCurrent(ticket, deps.currentDocumentId());
	const fail = (message: string): LabOutcome<T> => {
		owner.finish(ticket);
		return { status: "failed", message };
	};
	try {
		const source = await deps.source(ticket.controller.signal);
		if (!current()) return { status: "stale" };
		if ("error" in source) return fail(source.error);
		const leftover = await deps.latestRun();
		if (!current()) return { status: "stale" };
		if (leftover) {
			if (
				leftover.status === "reserved" ||
				leftover.status === "provider_started"
			)
				return fail(STILL_RUNNING);
			await deps.acknowledge(leftover.requestId);
			if (!current()) return { status: "stale" };
		}
		const sourceHash = await sha256Text(source.markdown);
		if (!current() || !owner.markSent(ticket)) return { status: "stale" };
		const result = await call(
			{
				requestId: ticket.requestId,
				documentId,
				sourceNodeId: source.sourceNodeId,
				sourceHash,
				platform: "web",
				traceContent: true,
			},
			source,
		);
		if (!current()) return { status: "stale" };
		const acknowledged = await deps.acknowledge(ticket.requestId);
		if (!current()) return { status: "stale" };
		if (!acknowledged) return fail(UNCLAIMED);
		owner.finish(ticket);
		return { status: "done", result, source };
	} catch (error) {
		if (!current()) return { status: "stale" };
		return fail(explainLabError(error));
	}
}
