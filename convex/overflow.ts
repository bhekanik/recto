import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { sha256 } from "./ai/request";
import { syncBlobReferences } from "./blobReferences";
import {
	refuse,
	requireDocumentTextFits,
	requireId,
	requireOwnedDocument,
	utf8Length,
} from "./documents";

export const MAX_OVERFLOW_BYTES = 64 * 1024;
export const OVERFLOW_TOO_LARGE_MESSAGE =
	"Overflow exceeds the 64 KiB scratchpad limit; copy some notes elsewhere before saving.";

export type OverflowState = { markdown: string; revision: number };
export type OverflowSaveResult =
	| { saved: true; revision: number }
	| ({ saved: false } & OverflowState);

export const get = query({
	args: { documentId: v.id("documents") },
	handler: async (ctx, args): Promise<OverflowState> => {
		const doc = await requireOwnedDocument(ctx, args.documentId);
		return {
			markdown: doc.overflowMarkdown ?? "",
			revision: doc.overflowRevision ?? 0,
		};
	},
});

export const save = mutation({
	args: {
		documentId: v.id("documents"),
		markdown: v.string(),
		expectedRevision: v.number(),
		clientMutationId: v.string(),
	},
	handler: async (ctx, args): Promise<OverflowSaveResult> => {
		const doc = await requireOwnedDocument(ctx, args.documentId);
		requireId(args.clientMutationId, "clientMutationId");
		if (
			args.clientMutationId.trim().length === 0 ||
			!Number.isSafeInteger(args.expectedRevision) ||
			args.expectedRevision < 0 ||
			args.expectedRevision >= Number.MAX_SAFE_INTEGER
		) {
			refuse("invalid_argument", "Invalid Overflow save identity or revision.");
		}
		if (utf8Length(args.markdown) > MAX_OVERFLOW_BYTES) {
			refuse("too_large", OVERFLOW_TOO_LARGE_MESSAGE);
		}
		const requestHash = await sha256(
			JSON.stringify([args.expectedRevision, args.markdown]),
		);
		if (doc.lastOverflowCommit?.clientMutationId === args.clientMutationId) {
			if (doc.lastOverflowCommit.requestHash !== requestHash) {
				refuse(
					"invalid_argument",
					"Overflow save id was reused for different notes.",
				);
			}
			return { saved: true, revision: doc.lastOverflowCommit.revision };
		}
		const revision = doc.overflowRevision ?? 0;
		if (revision !== args.expectedRevision) {
			return { saved: false, markdown: doc.overflowMarkdown ?? "", revision };
		}
		requireDocumentTextFits(doc.markdown, args.markdown);
		const nextRevision = revision + 1;
		await ctx.db.patch(args.documentId, {
			overflowMarkdown: args.markdown,
			overflowRevision: nextRevision,
			lastOverflowCommit: {
				clientMutationId: args.clientMutationId,
				requestHash,
				revision: nextRevision,
			},
		});
		await syncBlobReferences(ctx, doc.userId, "document", args.documentId, [
			doc.markdown,
			args.markdown,
		]);
		return { saved: true, revision: nextRevision };
	},
});
