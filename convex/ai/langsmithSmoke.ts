import { Client } from "langsmith";
import { getCurrentRunTree, traceable } from "langsmith/traceable";

import { internalAction } from "../_generated/server";

/**
 * Plan 023 N0(e): prove `langsmith`'s `traceable` runs in the Convex DEFAULT
 * runtime, not just under `"use node"`.
 *
 * The open question is `AsyncLocalStorage`: `traceable` builds its run tree
 * from `node:async_hooks`, which the default runtime only gained in Convex
 * 1.39. If this action can read a run id from inside the traced function and
 * flush the batch, every AI action in §8 can stay in the default runtime — a
 * "use node" requirement would change the AI architecture (§8.5 STOP).
 *
 * Internal — operators only; `bunx convex run` reaches internal functions.
 * Run it with:
 *   bunx convex run ai/langsmithSmoke:run
 *
 * Green looks like `{traced: true, runId: "<uuid>", ...}` plus a matching run
 * in the LangSmith project. It never throws on missing configuration — an
 * unconfigured deployment reports `{skipped: "..."}` so the smoke can run
 * anywhere.
 */
export const run = internalAction({
	args: {},
	handler: async () => {
		const apiKey = process.env.LANGSMITH_API_KEY;
		if (!apiKey) return { skipped: "no LANGSMITH_API_KEY" as const };
		if (process.env.LANGSMITH_TRACING !== "true") {
			return { skipped: 'LANGSMITH_TRACING is not "true"' as const };
		}

		const endpoint = process.env.LANGSMITH_ENDPOINT;
		const project = process.env.LANGSMITH_PROJECT ?? null;
		const client = new Client({ apiKey, apiUrl: endpoint });

		const traced = traceable(
			async (input: string) => {
				// Crossing an await first is the point: the real AI calls are async,
				// and AsyncLocalStorage context is exactly what a runtime tends to
				// lose across a suspension. Reading the run tree AFTER the await is
				// therefore the honest test.
				await Promise.resolve();
				// Strict on purpose: `getCurrentRunTree(true)` returns undefined when
				// context did not propagate, which would report a green smoke for the
				// one failure this action exists to detect.
				const runTree = getCurrentRunTree();
				return { echoed: input.toUpperCase(), runId: runTree.id };
			},
			{
				name: "recto.langsmithSmoke",
				client,
				project_name: project ?? undefined,
				tracingEnabled: true,
			},
		);

		try {
			const { echoed, runId } = await traced("recto smoke");
			return {
				traced: true as const,
				runId,
				echoed,
				project,
				endpoint: endpoint ?? null,
			};
		} finally {
			// Convex freezes the isolate the moment the action returns, so an
			// unflushed batch is a silently lost trace.
			await client.awaitPendingTraceBatches();
		}
	},
});
