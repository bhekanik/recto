import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, mutation, query } from "./_generated/server";
import { assertNotDeleting } from "./accountGuard";
import { removeBlobReferences, syncBlobReferences } from "./blobReferences";
import { startDocumentCleanup } from "./documentCleanup";

type QueryCtx = GenericQueryCtx<import("./_generated/dataModel").DataModel>;
type MutationCtx = GenericMutationCtx<
	import("./_generated/dataModel").DataModel
>;

/**
 * Max stored markdown/snapshot length, guarding the Convex ~1 MiB per-value
 * ceiling (blueprint 03 §5). Book-length manuscripts are an explicit non-goal;
 * fail loudly rather than let Convex reject the whole mutation opaquely. Shared
 * by documents.updateMarkdown and review.ts (suggester/AI branch writes).
 */
export const MAX_MARKDOWN_LENGTH = 950_000;

/**
 * UTF-8 byte length. The Convex ceiling is on encoded bytes, not JS characters,
 * so `"漢".repeat(400_000)` is 400k characters and 1.2 MB — under any
 * `.length` check and over the real limit.
 */
export function utf8Length(value: string): number {
	return new TextEncoder().encode(value).length;
}

export const MARKDOWN_TOO_LARGE_MESSAGE =
	"Document exceeds the ~1 MiB size limit; split it into multiple documents.";

function nextDocumentUpdatedAt(previous: number): number {
	return Math.max(Date.now(), previous + 1);
}

/**
 * Client-generated ids are ULIDs (26 chars) but legacy roots are UUIDs, so the
 * shape is not pinned — only that an id is a plausible non-empty identifier.
 * `v.string()` accepts "", which would otherwise let a malformed payload insert
 * an empty node id or point a document at no node at all.
 */
const MAX_ID_LENGTH = 64;

/**
 * Refusal codes for errors the server decides deterministically. Clients use
 * the code (not the message) to tell "retrying the same call can never
 * succeed" apart from transient rejections such as an exhausted OCC retry,
 * which Convex surfaces as plain errors and which are safe to retry.
 */
export type RefusalCode =
	| "invalid_argument"
	| "unauthenticated"
	| "not_found"
	| "unknown_node"
	| "too_large"
	| "parent_mismatch";

/**
 * Codes a client may treat as terminal (retrying the identical call can never
 * succeed). `unauthenticated` is deliberately absent: a 60-second Clerk token
 * can expire between queued jobs, so an outbox re-authenticates and retries.
 */
export const TERMINAL_REFUSAL_CODES: ReadonlySet<RefusalCode> = new Set([
	"invalid_argument",
	"not_found",
	"unknown_node",
	"too_large",
	"parent_mismatch",
]);

export function refuse(code: RefusalCode, message: string): never {
	throw new ConvexError({ code, message });
}

export function requireDocumentTextFits(
	markdown: string,
	overflowMarkdown = "",
): void {
	if (
		utf8Length(markdown) + utf8Length(overflowMarkdown) >
		MAX_MARKDOWN_LENGTH
	) {
		refuse("too_large", MARKDOWN_TOO_LARGE_MESSAGE);
	}
}

export function requireId(value: string, field: string): string {
	if (value.length === 0 || value.length > MAX_ID_LENGTH) {
		refuse("invalid_argument", `Invalid ${field}`);
	}
	return value;
}

/**
 * Resolve the authenticated Clerk user id (JWT subject) or throw.
 *
 * In a MUTATION context this also refuses when the account is being deleted:
 * a still-valid JWT outlives the Clerk user, so without it a stale tab or an
 * offline outbox can write rows behind the purge (see `accountGuard.ts`).
 */
export async function requireUserId(
	ctx: QueryCtx | MutationCtx,
): Promise<string> {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) {
		refuse("unauthenticated", "Unauthenticated");
	}
	await assertNotDeleting(ctx, identity.subject);
	return identity.subject;
}

/** Assert document belongs to caller. */
export async function requireOwnedDocument(
	ctx: QueryCtx | MutationCtx,
	documentId: Id<"documents">,
): Promise<Doc<"documents">> {
	const userId = await requireUserId(ctx);
	const doc = await ctx.db.get(documentId);
	if (!doc || doc.userId !== userId) {
		refuse("not_found", "Document not found");
	}
	return doc;
}

/** List documents for the authenticated user (metadata only). */
export const list = query({
	args: {},
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		const rows = await ctx.db
			.query("documents")
			.withIndex("by_user_updated", (q) => q.eq("userId", userId))
			.order("desc")
			.collect();

		return rows.map((row) => ({
			_id: row._id,
			title: row.title,
			titleMode: row.titleMode ?? ("manual" as const),
			wordCount: row.wordCount,
			updatedAt: row.updatedAt,
			documentUuid: row.documentUuid,
		}));
	},
});

/**
 * Title + canonical markdown for a document, for the Node-runtime `export.docx`
 * action (plan 023 §4.1(6)). Actions have no database access, and a `"use node"`
 * module cannot define a query, so ownership is re-checked here against the
 * userId the action read from the JWT — never a userId the caller supplied.
 */
export const forExport = internalQuery({
	args: { documentId: v.id("documents"), userId: v.string() },
	handler: async (ctx, args) => {
		const doc = await ctx.db.get(args.documentId);
		if (!doc || doc.userId !== args.userId) return null;
		return { title: doc.title, markdown: doc.markdown };
	},
});

/** Get one document including markdown body. */
export const get = query({
	args: { documentId: v.id("documents") },
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const doc = await ctx.db.get(args.documentId);
		if (!doc || doc.userId !== userId) return null;

		return {
			_id: doc._id,
			title: doc.title,
			titleMode: doc.titleMode ?? ("manual" as const),
			markdown: doc.markdown,
			wordCount: doc.wordCount,
			currentNodeId: doc.currentNodeId,
			// undefined means the stored markdown's provenance is unknown, which
			// clients must treat as untrusted rather than as "belongs to the head".
			markdownHeadNodeId: doc.markdownHeadNodeId,
			// Rows predating pointerRevision read as 0; the first pointer write
			// bumps them to 1, so clients never have to handle a missing value.
			pointerRevision: doc.pointerRevision ?? 0,
			createdAt: doc.createdAt,
			updatedAt: doc.updatedAt,
		};
	},
});

/**
 * Create a new document and its root undo-tree node, in one transaction.
 *
 * `documentUuid` makes creation idempotent for clients that mint a document
 * offline (plan 023 §4.1(5)): the second call with the same uuid returns the
 * document the first one made instead of a duplicate holding the same text.
 * Scoped per user, so two accounts choosing the same uuid do not collide.
 * Omitting it keeps the old behaviour — every call creates a document.
 */
export const create = mutation({
	args: {
		title: v.optional(v.string()),
		/** Client-minted idempotency key; omit for a plain online create. */
		documentUuid: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const documentUuid = args.documentUuid;

		if (documentUuid !== undefined) {
			requireId(documentUuid, "documentUuid");
			const existing = await ctx.db
				.query("documents")
				.withIndex("by_user_uuid", (q) =>
					q.eq("userId", userId).eq("documentUuid", documentUuid),
				)
				.unique();
			if (existing) {
				return {
					documentId: existing._id,
					// Every document created WITH a uuid stores its root, so the
					// fallback is unreachable in practice; it exists because the field
					// is optional for documents created before this change, which by
					// definition carry no uuid and cannot be found here.
					rootNodeId: existing.rootNodeId ?? existing.currentNodeId,
					created: false as const,
				};
			}
		}

		const now = Date.now();
		const rootNodeId = crypto.randomUUID();
		const title = args.title?.trim() || "Untitled";

		const documentId = await ctx.db.insert("documents", {
			userId,
			title,
			titleMode: "derived",
			markdown: "",
			wordCount: 0,
			currentNodeId: rootNodeId,
			rootNodeId,
			documentUuid,
			createdAt: now,
			updatedAt: now,
		});

		// Root node: full snapshot (empty), no parent (blueprint 03 §3.1, 07 §3.2).
		await ctx.db.insert("docNodes", {
			documentId,
			nodeId: rootNodeId,
			parentNodeId: null,
			patch: JSON.stringify({ from: 0, to: 0, insert: "" }),
			snapshot: "",
			selection: null,
			origin: "server",
			createdAt: now,
		});

		return { documentId, rootNodeId, created: true as const };
	},
});

/**
 * Delete a document and cascade-delete everything keyed by_document: history
 * (docNodes + versions), the review collaboration rows (documentShares +
 * reviewBranches + comments, plan 010), and the RAG embedding chunks
 * (docChunks, plan 013 — otherwise deleted-document text keeps surfacing in
 * vector search). Each lives in separate rows indexed by_document, deleted in
 * batches to respect the per-transaction write ceiling (blueprint 03 §5).
 */
export const remove = mutation({
	args: { documentId: v.id("documents") },
	handler: async (ctx, args) => {
		const document = await requireOwnedDocument(ctx, args.documentId);
		// Write the replay fence in the same transaction that hides the document.
		// Dependent rows drain later in bounded, scheduler-backed batches.
		await startDocumentCleanup(ctx, {
			documentId: args.documentId,
			userId: document.userId,
		});

		await removeBlobReferences(ctx, "document", args.documentId);
		await ctx.db.delete(args.documentId);
	},
});

/**
 * Move the undo-tree pointer (last-write-wins by updatedAt). The materialized
 * markdown for the target node is written alongside so an idle reader hydrates
 * the right text (blueprint 07 §5, 03 §3.1; ADR-10 LWW pointer).
 */
export const updateCurrentNodeId = mutation({
	args: {
		documentId: v.id("documents"),
		currentNodeId: v.string(),
		markdown: v.string(),
		wordCount: v.number(),
		title: v.optional(v.string()),
		updatedAt: v.number(),
		/**
		 * The pointerRevision the caller last observed. When given, the move is a
		 * compare-and-set on the server's revision counter instead of the
		 * wall-clock `updatedAt` rule: client clocks race server timestamps
		 * (an earlier queued markdown write can assign `doc.updatedAt` after the
		 * caller captured `Date.now()`), revisions cannot. Old clients omit it.
		 */
		expectedPointerRevision: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		requireId(args.currentNodeId, "currentNodeId");
		const doc = await requireOwnedDocument(ctx, args.documentId);

		// The pointer may only name a node that exists. This used to race the
		// fire-and-forget append that created it; it no longer can. A navigation
		// flushes any open draft first, and Convex delivers one client's
		// mutations in order, so the commitEdit that creates a node is always
		// applied before the pointer write that follows it.
		const target = await ctx.db
			.query("docNodes")
			.withIndex("by_document_node", (q) =>
				q.eq("documentId", args.documentId).eq("nodeId", args.currentNodeId),
			)
			.unique();
		if (!target) refuse("unknown_node", "Unknown currentNodeId");

		// Same ~1 MiB guard as updateMarkdown — the materialized markdown is stored
		// on the documents row here too.
		requireDocumentTextFits(args.markdown, doc.overflowMarkdown);

		const pointerRevision = (doc.pointerRevision ?? 0) + 1;
		const rejected =
			args.expectedPointerRevision !== undefined
				? args.expectedPointerRevision !== (doc.pointerRevision ?? 0)
				: args.updatedAt < doc.updatedAt;
		if (rejected) {
			// Rejected: hand back the head that won, so the caller can queue it
			// instead of guessing.
			return {
				applied: false as const,
				currentNodeId: doc.currentNodeId,
				pointerRevision: doc.pointerRevision ?? 0,
			};
		}
		const updatedAt = nextDocumentUpdatedAt(doc.updatedAt);
		const patch = {
			currentNodeId: args.currentNodeId,
			markdown: args.markdown,
			wordCount: args.wordCount,
			updatedAt,
			pointerRevision,
			// This writes the materialization of the node it is pointing at.
			markdownHeadNodeId: args.currentNodeId,
		};
		await ctx.db.patch(
			args.documentId,
			doc.titleMode === "derived" && args.title !== undefined
				? { ...patch, title: args.title.trim() || "Untitled" }
				: patch,
		);
		await syncBlobReferences(ctx, doc.userId, "document", args.documentId, [
			args.markdown,
			doc.overflowMarkdown ?? "",
		]);
		return {
			applied: true as const,
			currentNodeId: args.currentNodeId,
			updatedAt,
			pointerRevision,
		};
	},
});

/**
 * Commit one undo-tree node AND the document state it produces, atomically.
 *
 * Replaces the three independent writes an edit used to make — `docNodes.append`
 * (fire-and-forget), `documents.updateCurrentNodeId` (debounced 1200ms) and
 * `documents.updateMarkdown` (debounced 500ms). Splitting them meant the server
 * could sit in a state no client ever intended: a node present with the pointer
 * still on its parent, or `updatedAt` advanced by a markdown write while
 * `currentNodeId` lagged. A client watching that intermediate state read its own
 * un-published pointer move as a remote one and walked the pointer backwards
 * (plan 022). One transaction removes the intermediate state entirely.
 *
 * Concurrency contract, for the offline outbox the native clients replay through
 * (plan 023 §4.1):
 *  - The node row is inserted regardless of the head check. The DAG is
 *    append-only and conflict-free, so a node is never wrong — only the pointer
 *    can be contended, and dropping the row would lose the writer's text.
 *  - `expectedHeadNodeId` is the parent the caller committed onto. If the
 *    document head has moved elsewhere, the pointer/markdown are left alone and
 *    `{committed: false, diverged: true, remoteHeadNodeId}` is returned; the
 *    caller resolves it (the web adopts the remote head — the local node stays
 *    reachable in the history panel).
 *  - Retries are safe: replaying the same `clientMutationId`, or a commit whose
 *    node is already the head, returns the original success instead of a
 *    spurious divergence.
 *
 * REPLAY WINDOW — clients must retry a commit until it is acknowledged before
 * sending the next one. Only the MOST RECENT commit is replay-safe:
 * `documents.lastCommit` remembers one `clientMutationId`, so an outbox that
 * pipelines commits and later replays an older one — whose node landed but
 * whose head has since advanced — gets `diverged` rather than its original
 * answer. A strictly sequential outbox that only ever retries the head of its
 * queue never sees this. Widening it means a per-document log of recent
 * mutation ids, which nothing needs yet.
 *
 * Only SUCCESSFUL commits are recorded for replay. A divergence response that
 * never reached the caller, retried later once the head has returned to
 * `expectedHeadNodeId`, will commit — the caller asked to commit onto that head
 * and that head is current, so committing is the correct answer, not a
 * duplicate.
 */
export const commitEdit = mutation({
	args: {
		documentId: v.id("documents"),
		node: v.object({
			nodeId: v.string(),
			parentNodeId: v.union(v.string(), v.null()),
			patch: v.string(),
			snapshot: v.optional(v.string()),
			selection: v.union(
				v.object({ anchor: v.number(), head: v.number() }),
				v.null(),
			),
			origin: v.string(),
			createdAt: v.number(),
		}),
		markdown: v.string(),
		wordCount: v.number(),
		title: v.optional(v.string()),
		/** The document head the caller believes it is committing onto. */
		expectedHeadNodeId: v.string(),
		/** Caller-generated idempotency key for this commit attempt. */
		clientMutationId: v.string(),
	},
	handler: async (ctx, args) => {
		requireId(args.node.nodeId, "node.nodeId");
		requireId(args.expectedHeadNodeId, "expectedHeadNodeId");
		requireId(args.clientMutationId, "clientMutationId");
		if (args.node.parentNodeId !== null) {
			requireId(args.node.parentNodeId, "node.parentNodeId");
		}
		// An empty patch cannot be applied, so it would poison every
		// materialization that walks through this node.
		if (args.node.patch.length === 0)
			refuse("invalid_argument", "Invalid node.patch");

		const doc = await requireOwnedDocument(ctx, args.documentId);

		// Replay of an attempt we already answered — return the same answer.
		if (doc.lastCommit?.clientMutationId === args.clientMutationId) {
			return {
				committed: true as const,
				headNodeId: doc.lastCommit.headNodeId,
				updatedAt: doc.lastCommit.updatedAt,
				pointerRevision:
					doc.lastCommit.pointerRevision ?? doc.pointerRevision ?? 0,
			};
		}

		// Same ~1 MiB ceiling as updateMarkdown (blueprint 03 §5), applied to both
		// rows this mutation writes. The docNodes row is measured as patch +
		// snapshot together because Convex counts the whole document against the
		// limit — checked here so an oversized node fails with this message rather
		// than blowing up opaquely inside the transaction.
		const nodeRowBytes =
			utf8Length(args.node.patch) +
			(args.node.snapshot ? utf8Length(args.node.snapshot) : 0);
		requireDocumentTextFits(args.markdown, doc.overflowMarkdown);
		if (nodeRowBytes > MAX_MARKDOWN_LENGTH) {
			refuse("too_large", MARKDOWN_TOO_LARGE_MESSAGE);
		}

		// A node's parent IS the head it was committed onto; a caller that names
		// one head and parents the node on another would leave the DAG
		// mis-parented or detached, so refuse before anything is written.
		if (args.node.parentNodeId !== args.expectedHeadNodeId) {
			refuse(
				"parent_mismatch",
				"commitEdit: node.parentNodeId must equal expectedHeadNodeId",
			);
		}

		const existing = await ctx.db
			.query("docNodes")
			.withIndex("by_document_node", (q) =>
				q.eq("documentId", args.documentId).eq("nodeId", args.node.nodeId),
			)
			.unique();
		if (!existing) {
			const nodeRowId = await ctx.db.insert("docNodes", {
				documentId: args.documentId,
				...args.node,
			});
			await syncBlobReferences(ctx, doc.userId, "node", nodeRowId, [
				args.node.patch,
				args.node.snapshot ?? "",
			]);
		}

		// The commit already landed (an earlier attempt got through); don't read
		// the advanced head as someone else's write. Record THIS attempt's id too:
		// if this answer is lost and another client moves the head before the
		// retry, the retry must replay the success, not see a divergence.
		if (doc.currentNodeId === args.node.nodeId) {
			const pointerRevision = doc.pointerRevision ?? 0;
			await ctx.db.patch(args.documentId, {
				lastCommit: {
					clientMutationId: args.clientMutationId,
					headNodeId: doc.currentNodeId,
					updatedAt: doc.updatedAt,
					pointerRevision,
				},
			});
			return {
				committed: true as const,
				headNodeId: doc.currentNodeId,
				updatedAt: doc.updatedAt,
				pointerRevision,
			};
		}

		if (doc.currentNodeId !== args.expectedHeadNodeId) {
			return {
				committed: false as const,
				diverged: true as const,
				remoteHeadNodeId: doc.currentNodeId,
				remotePointerRevision: doc.pointerRevision ?? 0,
			};
		}

		const updatedAt = nextDocumentUpdatedAt(doc.updatedAt);
		const pointerRevision = (doc.pointerRevision ?? 0) + 1;
		const patch = {
			currentNodeId: args.node.nodeId,
			markdown: args.markdown,
			wordCount: args.wordCount,
			updatedAt,
			pointerRevision,
			markdownHeadNodeId: args.node.nodeId,
			lastCommit: {
				clientMutationId: args.clientMutationId,
				headNodeId: args.node.nodeId,
				updatedAt,
				pointerRevision,
			},
		};
		await ctx.db.patch(
			args.documentId,
			doc.titleMode === "derived" && args.title !== undefined
				? { ...patch, title: args.title.trim() || "Untitled" }
				: patch,
		);
		await syncBlobReferences(ctx, doc.userId, "document", args.documentId, [
			args.markdown,
			doc.overflowMarkdown ?? "",
		]);

		return {
			committed: true as const,
			headNodeId: args.node.nodeId,
			updatedAt,
			pointerRevision,
		};
	},
});

/** Rename a document title. */
export const rename = mutation({
	args: {
		documentId: v.id("documents"),
		title: v.string(),
	},
	handler: async (ctx, args) => {
		const doc = await requireOwnedDocument(ctx, args.documentId);
		await ctx.db.patch(args.documentId, {
			title: args.title.trim() || "Untitled",
			titleMode: "manual",
			updatedAt: nextDocumentUpdatedAt(doc.updatedAt),
		});
	},
});

/** Debounced autosave with stale-version guard. */
export const updateMarkdown = mutation({
	args: {
		documentId: v.id("documents"),
		markdown: v.string(),
		wordCount: v.number(),
		expectedUpdatedAt: v.number(),
		title: v.optional(v.string()),
		/**
		 * The undo-tree head the caller's text belongs to. Optional so the
		 * previously-deployed client keeps working; when given, a head that has
		 * moved elsewhere means this draft is written against someone else's
		 * branch and must not overwrite theirs.
		 */
		expectedHeadNodeId: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const doc = await requireOwnedDocument(ctx, args.documentId);

		// Guard the Convex ~1 MiB per-value ceiling (blueprint 03 §5). Book-length
		// manuscripts are an explicit non-goal; fail loudly rather than let Convex
		// reject the whole mutation opaquely. The editor keeps the text locally.
		requireDocumentTextFits(args.markdown, doc.overflowMarkdown);

		// A diverged head is NOT retryable: the stale-updatedAt retry loop below
		// would otherwise keep re-writing this device's draft on top of whichever
		// branch won, leaving documents.markdown detached from currentNodeId.
		if (
			args.expectedHeadNodeId !== undefined &&
			doc.currentNodeId !== args.expectedHeadNodeId
		) {
			return {
				updatedAt: doc.updatedAt,
				stale: true as const,
				headMoved: true as const,
			};
		}

		if (doc.updatedAt !== args.expectedUpdatedAt) {
			return {
				updatedAt: doc.updatedAt,
				stale: true as const,
				headMoved: false as const,
			};
		}

		const updatedAt = nextDocumentUpdatedAt(doc.updatedAt);
		const patch: {
			markdown: string;
			wordCount: number;
			updatedAt: number;
			title?: string;
			markdownHeadNodeId?: string;
		} = {
			markdown: args.markdown,
			wordCount: args.wordCount,
			updatedAt,
			// A caller that passed the compare-and-set has proven which head this
			// text belongs to. A legacy caller has not, so its write CLEARS any
			// stamp — leaving a stale one would let another device promote text
			// into a branch it never belonged to (ADR-19, deployment window).
			markdownHeadNodeId: args.expectedHeadNodeId,
		};
		if (doc.titleMode === "derived" && args.title !== undefined) {
			patch.title = args.title.trim() || "Untitled";
		}

		await ctx.db.patch(args.documentId, patch);
		await syncBlobReferences(ctx, doc.userId, "document", args.documentId, [
			args.markdown,
			doc.overflowMarkdown ?? "",
		]);

		return { updatedAt, stale: false as const, headMoved: false as const };
	},
});
