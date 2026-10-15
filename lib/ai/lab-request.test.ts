import { ConvexError } from "convex/values";
import { describe, expect, it, vi } from "vitest";

import type { Id } from "@/convex/_generated/dataModel";
import {
	explainLabError,
	type LabRequestDeps,
	runLabRequest,
} from "./lab-request";
import { AiRequestOwner } from "./request-owner";

const documentId = "doc1" as Id<"documents">;

function deps(overrides: Partial<LabRequestDeps> = {}): LabRequestDeps {
	return {
		owner: new AiRequestOwner(),
		documentId,
		currentDocumentId: () => documentId,
		source: async () => ({ sourceNodeId: "n1", markdown: "Draft." }),
		latestRun: async () => null,
		acknowledge: vi.fn(async () => true),
		...overrides,
	};
}

describe("a Lab request", () => {
	it("sends the synced head and the text's hash, then claims the result", async () => {
		const d = deps();
		const call = vi.fn(async () => ({ cuts: [] }));
		const outcome = await runLabRequest(d, call);
		expect(outcome).toEqual({
			status: "done",
			result: { cuts: [] },
			source: { sourceNodeId: "n1", markdown: "Draft." },
		});
		const [args] = call.mock.calls[0] as unknown as [Record<string, unknown>];
		expect(args).toMatchObject({
			documentId,
			sourceNodeId: "n1",
			platform: "web",
			traceContent: true,
		});
		expect(args.sourceHash).toMatch(/^[0-9a-f]{64}$/);
		expect(d.acknowledge).toHaveBeenCalledWith(args.requestId);
		expect(d.owner.currentRequestId()).toBeNull();
	});

	it("shows nothing when the writer moved to another document meanwhile", async () => {
		let current: string | null = documentId;
		const d = deps({ currentDocumentId: () => current });
		const outcome = await runLabRequest(d, async () => {
			current = "doc2";
			return { cuts: [{ from: 0, to: 1, reason: "" }] };
		});
		expect(outcome).toEqual({ status: "stale" });
		expect(d.acknowledge).not.toHaveBeenCalled();
	});

	it("shows nothing once superseded, even if the call then fails", async () => {
		const d = deps();
		const outcome = await runLabRequest(d, async () => {
			d.owner.supersede();
			throw new Error("network");
		});
		expect(outcome).toEqual({ status: "stale" });
	});

	it("refuses while an earlier Lab run is still going, and clears a finished one", async () => {
		const running = deps({
			latestRun: async () => ({ requestId: "old", status: "provider_started" }),
		});
		const call = vi.fn();
		expect(await runLabRequest(running, call)).toEqual({
			status: "failed",
			message: "An AI request on this document is still running.",
		});
		expect(call).not.toHaveBeenCalled();

		const finished = deps({
			latestRun: async () => ({ requestId: "old", status: "succeeded" }),
		});
		await runLabRequest(finished, async () => ({ alternatives: [] }));
		expect(finished.acknowledge).toHaveBeenNthCalledWith(1, "old");
	});

	it("fails when the result cannot be claimed or the source cannot be read", async () => {
		const unclaimed = deps({ acknowledge: async () => false });
		expect(await runLabRequest(unclaimed, async () => ({}))).toEqual({
			status: "failed",
			message: "The Lab's result could not be claimed. Try again.",
		});
		const unsynced = deps({ source: async () => ({ error: "Not synced." }) });
		const call = vi.fn();
		expect(await runLabRequest(unsynced, call)).toEqual({
			status: "failed",
			message: "Not synced.",
		});
		expect(call).not.toHaveBeenCalled();
	});

	it("explains the server's refusals in words the writer can act on", async () => {
		const refused = (code: string, message = "server words") =>
			new ConvexError({ code, message });
		expect(explainLabError(refused("document_changed"))).toBe(
			"The document changed while the request started. Try again.",
		);
		expect(explainLabError(refused("ai_rate_limited"))).toBe(
			"Too many AI requests. Wait a minute and try again.",
		);
		expect(explainLabError(refused("ai_credential_required"))).toBe(
			"server words",
		);
		expect(explainLabError(new Error("socket"))).toBe(
			"The Lab could not finish. Try again.",
		);
		const outcome = await runLabRequest(deps(), async () => {
			throw refused("document_shared");
		});
		expect(outcome).toEqual({
			status: "failed",
			message: "AI is off on shared documents.",
		});
	});
});
