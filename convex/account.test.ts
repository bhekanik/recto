import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
	ACCOUNT_DELETION_UNAVAILABLE_MESSAGE,
	ACCOUNT_DELETION_UPLOAD_CUTOVER_MESSAGE,
	CLERK_USER_UNREACHABLE_MESSAGE,
} from "./account";
import { ACCOUNT_DELETION_IN_PROGRESS_MESSAGE } from "./accountGuard";
import { PURGE_BATCH } from "./accountPurge";
import schema from "./schema";

const modules: Record<string, () => Promise<unknown>> = {
	"./schema.ts": () => import("./schema"),
	"./account.ts": () => import("./account"),
	"./accountGuard.ts": () => import("./accountGuard"),
	"./accountPurge.ts": () => import("./accountPurge"),
	"./blobReferences.ts": () => import("./blobReferences"),
	"./documents.ts": () => import("./documents"),
	"./docNodes.ts": () => import("./docNodes"),
	"./files.ts": () => import("./files"),
	"./history.ts": () => import("./history"),
	"./migrations.ts": () => import("./migrations"),
	"./review.ts": () => import("./review"),
	"./settings.ts": () => import("./settings"),
	"./versions.ts": () => import("./versions"),
	"./workspaces.ts": () => import("./workspaces"),
	"./writingStats.ts": () => import("./writingStats"),
	"./_generated/api.js": () => import("./_generated/api"),
	"./_generated/server.js": () => import("./_generated/server"),
};

const OWNER = { subject: "owner-user", email: "Owner@Example.com" };
const OTHER = { subject: "other-user", email: "other@example.com" };

type Seeded = {
	documentId: Id<"documents">;
	otherDocumentId: Id<"documents">;
	acceptedDocumentId: Id<"documents">;
};

/**
 * A user with something in every table that keys off them — including
 * suggestion nodes they wrote inside OTHER people's documents — plus a second
 * user whose rows must survive untouched.
 */
async function seed(t: ReturnType<typeof convexTest>): Promise<Seeded> {
	return await t.run(async (ctx) => {
		const now = Date.now();

		const node = (
			documentId: Id<"documents">,
			nodeId: string,
			parentNodeId: string | null,
			authorUserId?: string,
			branchId?: Id<"reviewBranches">,
		) =>
			ctx.db.insert("docNodes", {
				documentId,
				nodeId,
				parentNodeId,
				patch: JSON.stringify({ from: 0, to: 0, insert: "" }),
				selection: null,
				origin: authorUserId ? `review:${authorUserId}` : "test",
				authorUserId,
				branchId,
				createdAt: now,
			});

		// --- another user's document, with an OPEN suggestion branch from OWNER ---
		const otherDocumentId = await ctx.db.insert("documents", {
			userId: OTHER.subject,
			title: "Theirs",
			markdown: "not yours",
			wordCount: 2,
			currentNodeId: "other-root",
			createdAt: now,
			updatedAt: now,
		});
		await node(otherDocumentId, "other-root", null);
		await node(
			otherDocumentId,
			"owner-suggestion",
			"other-root",
			OWNER.subject,
		);
		await ctx.db.insert("reviewBranches", {
			documentId: otherDocumentId,
			reviewerUserId: OWNER.subject,
			baseNodeId: "other-root",
			headNodeId: "owner-suggestion",
			status: "open",
			createdAt: now,
			updatedAt: now,
		});

		// --- another user's document where OWNER's suggestion was ACCEPTED ---
		const acceptedDocumentId = await ctx.db.insert("documents", {
			userId: OTHER.subject,
			title: "Merged",
			markdown: "merged",
			wordCount: 1,
			currentNodeId: "accepted-merge",
			createdAt: now,
			updatedAt: now,
		});
		await node(acceptedDocumentId, "accepted-root", null);
		const acceptedBranchId = await ctx.db.insert("reviewBranches", {
			documentId: acceptedDocumentId,
			reviewerUserId: OWNER.subject,
			baseNodeId: "accepted-root",
			headNodeId: "accepted-suggestion",
			status: "accepted",
			createdAt: now,
			updatedAt: now,
		});
		const rejectedBranchId = await ctx.db.insert("reviewBranches", {
			documentId: acceptedDocumentId,
			reviewerUserId: OWNER.subject,
			baseNodeId: "accepted-root",
			headNodeId: "rejected-suggestion",
			status: "rejected",
			createdAt: now,
			updatedAt: now,
		});
		await node(
			acceptedDocumentId,
			"accepted-suggestion",
			"accepted-root",
			OWNER.subject,
			acceptedBranchId,
		);
		// Same reviewer, same document, a DIFFERENT branch that was rejected. The
		// per-(document, reviewer) rule kept this too; the per-branch rule does not.
		await node(
			acceptedDocumentId,
			"rejected-suggestion",
			"accepted-root",
			OWNER.subject,
			rejectedBranchId,
		);
		// review.acceptBranch writes a NEW owner-authored node carrying the merged
		// text; the reviewer's node is not its ancestor.
		await node(acceptedDocumentId, "accepted-merge", "accepted-root");

		// --- OWNER's own document and everything hanging off it ---
		const documentId = await ctx.db.insert("documents", {
			userId: OWNER.subject,
			title: "Mine",
			markdown: "hello",
			wordCount: 1,
			currentNodeId: "node-2",
			createdAt: now,
			updatedAt: now,
		});
		for (let i = 0; i < 3; i += 1) {
			await node(documentId, `node-${i}`, i === 0 ? null : `node-${i - 1}`);
		}
		await ctx.db.insert("versions", {
			documentId,
			nodeId: "node-1",
			label: "Checkpoint",
			kind: "manual",
			createdAt: now,
		});
		await ctx.db.insert("documentShares", {
			documentId,
			ownerUserId: OWNER.subject,
			granteeEmail: "reviewer@example.com",
			role: "commenter",
			createdAt: now,
		});
		await ctx.db.insert("reviewBranches", {
			documentId,
			reviewerUserId: "reviewer-user",
			baseNodeId: "node-0",
			headNodeId: "node-1",
			status: "open",
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert("comments", {
			documentId,
			authorUserId: "reviewer-user",
			authorName: "Reviewer",
			anchor: { quote: "hello", prefix: "", suffix: "", offsetHint: 0 },
			body: "nice",
			resolved: false,
			createdAt: now,
		});
		await ctx.db.insert("docChunks", {
			userId: OWNER.subject,
			documentId,
			charStart: 0,
			charEnd: 5,
			text: "hello",
			embedding: new Array(1536).fill(0),
			embeddedNodeId: "node-2",
			updatedAt: now,
		});

		// --- OWNER's traces on ANOTHER user's document ---
		await ctx.db.insert("comments", {
			documentId: otherDocumentId,
			authorUserId: OWNER.subject,
			authorName: "Owner",
			anchor: { quote: "not", prefix: "", suffix: "", offsetHint: 0 },
			body: "a note on someone else's draft",
			resolved: false,
			createdAt: now,
		});
		await ctx.db.insert("documentShares", {
			documentId: otherDocumentId,
			ownerUserId: OTHER.subject,
			granteeEmail: OWNER.email.toLowerCase(),
			role: "suggester",
			createdAt: now,
		});
		await ctx.db.insert("documentShares", {
			documentId: otherDocumentId,
			ownerUserId: OTHER.subject,
			granteeEmail: "an-alias@example.com",
			granteeUserId: OWNER.subject,
			role: "commenter",
			createdAt: now,
		});

		await ctx.db.insert("writingStats", {
			userId: OWNER.subject,
			date: "2026-08-28",
			words: 100,
			updatedAt: now,
		});
		await ctx.db.insert("writingStats", {
			userId: OTHER.subject,
			date: "2026-08-28",
			words: 5,
			updatedAt: now,
		});
		await ctx.db.insert("workspaces", {
			userId: OWNER.subject,
			deviceId: "web-1",
			deviceClass: "web",
			json: "{}",
			updatedAt: now,
		});
		await ctx.db.insert("settings", {
			userId: OWNER.subject,
			json: '{"theme":"aurora"}',
			updatedAt: now,
		});

		return { documentId, otherDocumentId, acceptedDocumentId };
	});
}

/** Store two blobs and record ownership, one per user. */
async function seedBlobs(t: ReturnType<typeof convexTest>) {
	return await t.run(async (ctx) => {
		const mine = await ctx.storage.store(new Blob(["mine"]));
		const theirs = await ctx.storage.store(new Blob(["theirs"]));
		const unattributed = await ctx.storage.store(new Blob(["nobody"]));
		const now = Date.now();
		await ctx.db.insert("blobs", {
			storageId: mine,
			ownerUserId: OWNER.subject,
			kind: "upload",
			createdAt: now,
		});
		await ctx.db.insert("blobs", {
			storageId: theirs,
			ownerUserId: OTHER.subject,
			kind: "upload",
			createdAt: now,
		});
		return { mine, theirs, unattributed };
	});
}

async function makeLegacyUploadsSafe(t: ReturnType<typeof convexTest>) {
	await t.mutation(internal.files.startLegacyUploadCutover, {});
	await t.run(async (ctx) => {
		const row = await ctx.db.query("legacyUploadCutovers").first();
		if (row) await ctx.db.patch(row._id, { safeAfter: Date.now() - 1 });
	});
}

/** Backfill legacy references before starting deletion. */
async function beginWithReferences(
	t: ReturnType<typeof convexTest>,
	userId: string,
	granteeEmail?: string,
) {
	await runMigration(t, internal.migrations.scanDocumentRefs);
	await runMigration(t, internal.migrations.scanNodeRefs);
	await t.mutation(internal.account.beginDeletion, { userId, granteeEmail });
}

async function storageIds(t: ReturnType<typeof convexTest>) {
	return await t.run(async (ctx) =>
		(await ctx.db.system.query("_storage").collect()).map((file) => file._id),
	);
}

async function countAll(t: ReturnType<typeof convexTest>) {
	return await t.run(async (ctx) => ({
		documents: (await ctx.db.query("documents").collect()).length,
		docNodes: (await ctx.db.query("docNodes").collect()).length,
		versions: (await ctx.db.query("versions").collect()).length,
		documentShares: (await ctx.db.query("documentShares").collect()).length,
		reviewBranches: (await ctx.db.query("reviewBranches").collect()).length,
		comments: (await ctx.db.query("comments").collect()).length,
		docChunks: (await ctx.db.query("docChunks").collect()).length,
		writingStats: (await ctx.db.query("writingStats").collect()).length,
		workspaces: (await ctx.db.query("workspaces").collect()).length,
		settings: (await ctx.db.query("settings").collect()).length,
		blobs: (await ctx.db.query("blobs").collect()).length,
		blobRefs: (await ctx.db.query("blobRefs").collect()).length,
		blobRefSources: (await ctx.db.query("blobRefSources").collect()).length,
		legacyUploadGrants: (await ctx.db.query("legacyUploadGrants").collect())
			.length,
	}));
}

async function nodeIds(t: ReturnType<typeof convexTest>) {
	return await t.run(async (ctx) =>
		(await ctx.db.query("docNodes").collect()).map((node) => node.nodeId),
	);
}

/** Drive the row purge the way the action does, and report the rounds. */
async function purgeToCompletion(
	t: ReturnType<typeof convexTest>,
	userId: string,
	granteeEmail?: string,
	limit?: number,
): Promise<{ rounds: number; deleted: number }> {
	let rounds = 0;
	let deleted = 0;
	for (;;) {
		rounds += 1;
		const result = await t.mutation(internal.accountPurge.purgeData, {
			userId,
			granteeEmail,
			limit,
		});
		deleted += result.deleted;
		if (result.done) return { rounds, deleted };
		if (rounds > 200) throw new Error("purge did not converge");
	}
}

describe("accountPurge.purgeData", () => {
	it("removes every row keyed to the user and nothing keyed to anyone else", async () => {
		const t = convexTest(schema, modules);
		const { otherDocumentId } = await seed(t);

		await purgeToCompletion(t, OWNER.subject, OWNER.email);

		const counts = await countAll(t);
		expect(counts.documents).toBe(2); // the other user's two
		expect(counts.versions).toBe(0);
		expect(counts.documentShares).toBe(0);
		expect(counts.docChunks).toBe(0);
		expect(counts.settings).toBe(0);
		expect(counts.workspaces).toBe(0);
		expect(counts.writingStats).toBe(1); // the other user's

		const survivor = await t.run((ctx) => ctx.db.get(otherDocumentId));
		expect(survivor?.markdown).toBe("not yours");
	});

	it("removes the user's comments and branches on other people's documents", async () => {
		const t = convexTest(schema, modules);
		const { otherDocumentId } = await seed(t);

		await purgeToCompletion(t, OWNER.subject, OWNER.email);

		const left = await t.run(async (ctx) => ({
			comments: await ctx.db
				.query("comments")
				.withIndex("by_document", (q) => q.eq("documentId", otherDocumentId))
				.collect(),
			branches: await ctx.db
				.query("reviewBranches")
				.withIndex("by_document", (q) => q.eq("documentId", otherDocumentId))
				.collect(),
		}));
		expect(left.comments).toHaveLength(0);
		expect(left.branches).toHaveLength(0);
	});

	it("removes unclaimed invites addressed to the user's email, case-insensitively", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		await purgeToCompletion(t, OWNER.subject, OWNER.email);

		expect((await countAll(t)).documentShares).toBe(0);
	});

	it("leaves an email-addressed invite alone when no email is supplied", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		await purgeToCompletion(t, OWNER.subject, undefined);

		const shares = await t.run((ctx) =>
			ctx.db.query("documentShares").collect(),
		);
		expect(shares.map((share) => share.granteeEmail)).toEqual([
			OWNER.email.toLowerCase(),
		]);
	});

	it("is idempotent — a second full purge deletes nothing", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		await purgeToCompletion(t, OWNER.subject, OWNER.email);

		const second = await purgeToCompletion(t, OWNER.subject, OWNER.email);
		expect(second.deleted).toBe(0);
		expect(second.rounds).toBe(1);
	});

	it("resumes from a partial purge", async () => {
		const t = convexTest(schema, modules);
		await seed(t);

		const partial = await t.mutation(internal.accountPurge.purgeData, {
			userId: OWNER.subject,
			granteeEmail: OWNER.email,
			limit: 2,
		});
		expect(partial.deleted).toBe(2);
		expect(partial.done).toBe(false);

		await purgeToCompletion(t, OWNER.subject, OWNER.email);
		expect((await countAll(t)).documents).toBe(2);
	});

	it("clears an account far larger than one batch", async () => {
		const t = convexTest(schema, modules);
		const { documentId } = await seed(t);
		await t.run(async (ctx) => {
			for (let i = 0; i < PURGE_BATCH * 3; i += 1) {
				await ctx.db.insert("docNodes", {
					documentId,
					nodeId: `bulk-${i}`,
					parentNodeId: "node-0",
					patch: "{}",
					selection: null,
					origin: "test",
					createdAt: Date.now(),
				});
			}
		});

		const { rounds } = await purgeToCompletion(t, OWNER.subject, OWNER.email);
		expect(rounds).toBeGreaterThan(1);
		expect(await nodeIds(t)).not.toContain("bulk-0");
	});

	it("does nothing for a user who has never written anything", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		const before = await countAll(t);

		const result = await purgeToCompletion(t, "user-who-never-existed");
		expect(result.deleted).toBe(0);
		expect(await countAll(t)).toEqual(before);
	});
});

describe("accountPurge — suggestion nodes inside other people's documents", () => {
	it("deletes the reviewer's nodes on an open branch", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		await purgeToCompletion(t, OWNER.subject, OWNER.email);

		// Nothing keyed to the reviewer reaches these rows; they live in the
		// OWNER's docNodes and are only findable by authorUserId.
		expect(await nodeIds(t)).not.toContain("owner-suggestion");
		// The document owner's own node is untouched.
		expect(await nodeIds(t)).toContain("other-root");
	});

	it("deletes an accepted suggestion after the owner-authored merge preserves its text", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		await purgeToCompletion(t, OWNER.subject, OWNER.email);

		expect(await nodeIds(t)).not.toContain("accepted-suggestion");
		expect(await nodeIds(t)).toContain("accepted-merge");
	});

	it("keeps a suggestion the owner has since built on, even on an open branch", async () => {
		const t = convexTest(schema, modules);
		const { otherDocumentId } = await seed(t);
		// The owner navigated onto the suggestion and typed from there, so it is
		// now an ancestor of their head — deleting it would break materialization.
		await t.run(async (ctx) => {
			await ctx.db.insert("docNodes", {
				documentId: otherDocumentId,
				nodeId: "owner-followup",
				parentNodeId: "owner-suggestion",
				patch: "{}",
				selection: null,
				origin: "test",
				createdAt: Date.now(),
			});
			await ctx.db.patch(otherDocumentId, { currentNodeId: "owner-followup" });
		});

		await purgeToCompletion(t, OWNER.subject, OWNER.email);
		expect(await nodeIds(t)).toContain("owner-suggestion");
	});

	it("leaves another reviewer's nodes alone", async () => {
		const t = convexTest(schema, modules);
		const { otherDocumentId } = await seed(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("docNodes", {
				documentId: otherDocumentId,
				nodeId: "someone-else-suggestion",
				parentNodeId: "other-root",
				patch: "{}",
				selection: null,
				origin: "review:third-user",
				authorUserId: "third-user",
				createdAt: Date.now(),
			});
		});

		await purgeToCompletion(t, OWNER.subject, OWNER.email);
		expect(await nodeIds(t)).toContain("someone-else-suggestion");
	});
});

describe("accountPurge.purgeBlobs", () => {
	it("deletes only the blobs this user owns", async () => {
		const t = convexTest(schema, modules);
		const { theirs, unattributed } = await seedBlobs(t);
		await beginWithReferences(t, OWNER.subject);

		const result = await t.mutation(internal.accountPurge.purgeBlobs, {
			userId: OWNER.subject,
		});
		expect(result).toEqual({ deleted: 1, kept: 0, done: true });

		const left = await storageIds(t);
		expect(left).toContain(theirs);
		// Unattributed files are not this user's to delete; the orphan sweep
		// collects them once nothing references them.
		expect(left).toContain(unattributed);
		expect(left).toHaveLength(2);
	});

	it("does not delete a file merely because the user's markdown names its URL", async () => {
		const t = convexTest(schema, modules);
		const { documentId } = await seed(t);
		const { theirs } = await seedBlobs(t);

		// The old ownership rule was "whose markdown mentions this URL", which
		// this shared reference would have satisfied.
		const url = await t.run((ctx) => ctx.storage.getUrl(theirs));
		await t.run((ctx) =>
			ctx.db.patch(documentId, { markdown: `look ![alt](${url})` }),
		);
		await beginWithReferences(t, OWNER.subject);

		await t.mutation(internal.accountPurge.purgeBlobs, {
			userId: OWNER.subject,
		});
		expect(await storageIds(t)).toContain(theirs);
	});

	it("deletes a generated export, which no markdown ever references", async () => {
		const t = convexTest(schema, modules);
		const exportId = await t.run(async (ctx) => {
			const storageId = await ctx.storage.store(new Blob(["docx"]));
			await ctx.db.insert("blobs", {
				storageId,
				ownerUserId: OWNER.subject,
				kind: "export",
				createdAt: Date.now(),
			});
			return storageId;
		});
		await beginWithReferences(t, OWNER.subject);

		await t.mutation(internal.accountPurge.purgeBlobs, {
			userId: OWNER.subject,
		});
		expect(await storageIds(t)).not.toContain(exportId);
	});

	it("pages, and reports done only when the owner has none left", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let i = 0; i < 5; i += 1) {
				const storageId = await ctx.storage.store(new Blob([`f${i}`]));
				await ctx.db.insert("blobs", {
					storageId,
					ownerUserId: OWNER.subject,
					kind: "upload",
					createdAt: Date.now(),
				});
			}
		});

		await beginWithReferences(t, OWNER.subject);

		const first = await t.mutation(internal.accountPurge.purgeBlobs, {
			userId: OWNER.subject,
			limit: 2,
		});
		expect(first).toEqual({ deleted: 2, kept: 0, done: false });

		let guard = 0;
		let result = first;
		while (!result.done && guard++ < 10) {
			result = await t.mutation(internal.accountPurge.purgeBlobs, {
				userId: OWNER.subject,
				limit: 2,
			});
		}
		expect(result.done).toBe(true);
		expect(await storageIds(t)).toHaveLength(0);
	});

	it("drops an ownership row whose file is already gone, so it cannot loop forever", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const storageId = await ctx.storage.store(new Blob(["x"]));
			await ctx.db.insert("blobs", {
				storageId,
				ownerUserId: OWNER.subject,
				kind: "upload",
				createdAt: Date.now(),
			});
			await ctx.storage.delete(storageId);
		});
		await beginWithReferences(t, OWNER.subject);

		await t.mutation(internal.accountPurge.purgeBlobs, {
			userId: OWNER.subject,
		});
		const second = await t.mutation(internal.accountPurge.purgeBlobs, {
			userId: OWNER.subject,
		});
		expect(second).toEqual({ deleted: 0, kept: 0, done: true });
	});
});

describe("accountPurge — blobs another user still points at", () => {
	it("keeps a file someone else's document references, but drops its ownership row", async () => {
		const t = convexTest(schema, modules);
		const { otherDocumentId } = await seed(t);
		const { mine } = await seedBlobs(t);

		// The other user pasted this image's URL into their own document.
		const url = await t.run((ctx) => ctx.storage.getUrl(mine));
		await t.run((ctx) =>
			ctx.db.patch(otherDocumentId, { markdown: `theirs ![a](${url})` }),
		);
		await beginWithReferences(t, OWNER.subject);

		const result = await t.mutation(internal.accountPurge.purgeBlobs, {
			userId: OWNER.subject,
		});
		expect(result).toMatchObject({ deleted: 0, kept: 1, done: true });
		// Deleting it would break a document belonging to an account that is not
		// going anywhere.
		expect(await storageIds(t)).toContain(mine);
		// The account is gone, so it cannot keep owning the file; the daily orphan
		// sweep collects it once the other user stops referencing it.
		expect(await t.run((ctx) => ctx.db.query("blobs").collect())).toHaveLength(
			1,
		);
	});

	it("keeps a file another user's HISTORY references", async () => {
		const t = convexTest(schema, modules);
		const { otherDocumentId } = await seed(t);
		const { mine } = await seedBlobs(t);
		const url = await t.run((ctx) => ctx.storage.getUrl(mine));
		await t.run((ctx) =>
			ctx.db.insert("docNodes", {
				documentId: otherDocumentId,
				nodeId: "their-node-with-image",
				parentNodeId: "other-root",
				patch: JSON.stringify({ from: 0, to: 0, insert: `![a](${url})` }),
				selection: null,
				origin: "test",
				createdAt: Date.now(),
			}),
		);
		await beginWithReferences(t, OWNER.subject);

		await t.mutation(internal.accountPurge.purgeBlobs, {
			userId: OWNER.subject,
		});
		// Live markdown never names it; an old version does, and restoring that
		// version has to still render.
		expect(await storageIds(t)).toContain(mine);
	});

	it("refuses to delete blobs without a deletion tombstone", async () => {
		const t = convexTest(schema, modules);
		await seedBlobs(t);

		await expect(
			t.mutation(internal.accountPurge.purgeBlobs, { userId: OWNER.subject }),
		).rejects.toThrow("No deletion in progress for this user");
	});

	it("deletes an unshared blob even when the global reference index is large", async () => {
		const t = convexTest(schema, modules);
		const { mine } = await seedBlobs(t);
		await t.run(async (ctx) => {
			for (let i = 0; i < 4097; i += 1) {
				await ctx.db.insert("blobRefs", {
					token: `unrelated-${i}`,
					ownerUserId: OTHER.subject,
					count: 1,
				});
			}
		});
		await beginWithReferences(t, OWNER.subject);

		const result = await t.mutation(internal.accountPurge.purgeBlobs, {
			userId: OWNER.subject,
		});
		expect(result).toMatchObject({ deleted: 1, kept: 0 });
		expect(await storageIds(t)).not.toContain(mine);
	});

	it("sees a foreign reference added after deletion begins", async () => {
		const t = convexTest(schema, modules);
		const { otherDocumentId } = await seed(t);
		const { mine } = await seedBlobs(t);
		await beginWithReferences(t, OWNER.subject);
		const url = await t.run((ctx) => ctx.storage.getUrl(mine));
		const doc = await t.withIdentity(OTHER).query(api.documents.get, {
			documentId: otherDocumentId,
		});
		await t.withIdentity(OTHER).mutation(api.documents.updateMarkdown, {
			documentId: otherDocumentId,
			markdown: `new ![a](${url})`,
			wordCount: 1,
			expectedUpdatedAt: doc?.updatedAt ?? 0,
		});

		const result = await t.mutation(internal.accountPurge.purgeBlobs, {
			userId: OWNER.subject,
		});
		expect(result).toMatchObject({ deleted: 0, kept: 1 });
		expect(await storageIds(t)).toContain(mine);
	});

	it("reclaims a legacy upload that was stored without ever being claimed", async () => {
		const t = convexTest(schema, modules);
		const { documentId } = await seed(t);
		// What a browser tab running the pre-`/upload-image` protocol leaves: a
		// stored file, referenced by the user's markdown, with no blobs row.
		const orphan = await t.run((ctx) =>
			ctx.storage.store(new Blob(["legacy"])),
		);
		const url = await t.run((ctx) => ctx.storage.getUrl(orphan));
		await t.run((ctx) =>
			ctx.db.patch(documentId, { markdown: `mine ![a](${url})` }),
		);
		await beginWithReferences(t, OWNER.subject);

		const result = await t.mutation(
			internal.accountPurge.purgeUnattributedBlobs,
			{ userId: OWNER.subject },
		);
		expect(result).toEqual({ deleted: 1, done: true });
		expect(await storageIds(t)).not.toContain(orphan);
	});

	it("leaves an unattributed file another user also references", async () => {
		const t = convexTest(schema, modules);
		const { documentId, otherDocumentId } = await seed(t);
		const shared = await t.run((ctx) =>
			ctx.storage.store(new Blob(["shared"])),
		);
		const url = await t.run((ctx) => ctx.storage.getUrl(shared));
		await t.run(async (ctx) => {
			await ctx.db.patch(documentId, { markdown: `mine ![a](${url})` });
			await ctx.db.patch(otherDocumentId, { markdown: `theirs ![a](${url})` });
		});
		await beginWithReferences(t, OWNER.subject);

		await t.mutation(internal.accountPurge.purgeUnattributedBlobs, {
			userId: OWNER.subject,
		});
		expect(await storageIds(t)).toContain(shared);
	});

	it("leaves an unattributed file nobody references to the orphan sweep", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		const nobodys = await t.run((ctx) => ctx.storage.store(new Blob(["x"])));
		await beginWithReferences(t, OWNER.subject);

		await t.mutation(internal.accountPurge.purgeUnattributedBlobs, {
			userId: OWNER.subject,
		});
		expect(await storageIds(t)).toContain(nobodys);
	});
});

describe("accountPurge — reviewer decisions", () => {
	it("deletes accepted and rejected suggestion nodes after their owner snapshots are written", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		await purgeToCompletion(t, OWNER.subject, OWNER.email);

		expect(await nodeIds(t)).not.toContain("rejected-suggestion");
		expect(await nodeIds(t)).not.toContain("accepted-suggestion");
		expect(await nodeIds(t)).toContain("accepted-merge");
	});

	it("handles one document per pass, so an ancestor walk cannot compound", async () => {
		const t = convexTest(schema, modules);
		const { otherDocumentId, acceptedDocumentId } = await seed(t);

		const first = await t.mutation(internal.accountPurge.purgeData, {
			userId: OWNER.subject,
			limit: 4,
		});
		expect(first.done).toBe(false);

		// Both documents still have to be reached; nothing is skipped.
		await purgeToCompletion(t, OWNER.subject, OWNER.email);
		const remaining = await t.run(async (ctx) =>
			(await ctx.db.query("docNodes").collect()).filter(
				(node) => node.authorUserId === OWNER.subject,
			),
		);
		expect(remaining).toHaveLength(0);
		expect([otherDocumentId, acceptedDocumentId]).toHaveLength(2);
	});
});

describe("the deletion tombstone", () => {
	/**
	 * Every user-facing mutation, with an argument set that reaches its auth
	 * check. The point is coverage of the guard, not of each mutation's own
	 * behaviour: a mutation that skips `requireUserId`/`requireDocumentAccess`
	 * would be a hole a stale client could write through.
	 */
	function userMutations(seeded: Seeded) {
		const documentId = seeded.documentId;
		return [
			["documents.create", () => api.documents.create, {}],
			[
				"documents.rename",
				() => api.documents.rename,
				{ documentId, title: "x" },
			],
			["documents.remove", () => api.documents.remove, { documentId }],
			[
				"documents.updateMarkdown",
				() => api.documents.updateMarkdown,
				{
					documentId,
					markdown: "x",
					wordCount: 1,
					expectedUpdatedAt: Date.now(),
				},
			],
			[
				"documents.updateCurrentNodeId",
				() => api.documents.updateCurrentNodeId,
				{
					documentId,
					currentNodeId: "node-1",
					markdown: "x",
					wordCount: 1,
					updatedAt: Date.now(),
				},
			],
			[
				"documents.commitEdit",
				() => api.documents.commitEdit,
				{
					documentId,
					node: {
						nodeId: "new-node",
						parentNodeId: "node-2",
						patch: "{}",
						selection: null,
						origin: "test",
						createdAt: Date.now(),
					},
					markdown: "x",
					wordCount: 1,
					expectedHeadNodeId: "node-2",
					clientMutationId: "m1",
				},
			],
			[
				"docNodes.append",
				() => api.docNodes.append,
				{
					documentId,
					nodeId: "n9",
					parentNodeId: "node-2",
					patch: "{}",
					selection: null,
					origin: "test",
					createdAt: Date.now(),
				},
			],
			["docNodes.ensureRoot", () => api.docNodes.ensureRoot, { documentId }],
			[
				"versions.create",
				() => api.versions.create,
				{ documentId, nodeId: "node-1", label: "v", kind: "manual" as const },
			],
			["settings.save", () => api.settings.save, { json: "{}" }],
			[
				"workspaces.saveForDevice",
				() => api.workspaces.saveForDevice,
				{ deviceId: "d1", deviceClass: "web" as const, json: "{}" },
			],
			[
				"workspaces.save",
				() => api.workspaces.save,
				{
					paneTree: "{}",
					openDocumentIds: [],
					activePaneId: "p",
					perPaneViewState: "{}",
				},
			],
			[
				"writingStats.record",
				() => api.writingStats.record,
				{ date: "2026-08-28", words: 1 },
			],
			["files.generateUploadUrl", () => api.files.generateUploadUrl, {}],
			[
				"review.addShare",
				() => api.review.addShare,
				{ documentId, email: "x@example.com", role: "commenter" as const },
			],
			[
				"review.addComment",
				() => api.review.addComment,
				{
					documentId,
					anchor: { quote: "hello", prefix: "", suffix: "", offsetHint: 0 },
					body: "hi",
				},
			],
			[
				"review.reviewerAppend",
				() => api.review.reviewerAppend,
				{
					documentId: seeded.otherDocumentId,
					nodeId: "sug-1",
					parentNodeId: "other-root",
					patch: JSON.stringify({ from: 0, to: 0, insert: "x" }),
					selection: null,
					createdAt: Date.now(),
				},
			],
		] as const;
	}

	it("refuses every user-facing mutation while a deletion is in flight", async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const owner = t.withIdentity(OWNER);
		const cases = userMutations(seeded);

		// Sanity: without the tombstone at least one of these succeeds, so a
		// blanket failure cannot be mistaken for the guard working.
		await expect(
			owner.mutation(api.settings.save, { json: "{}" }),
		).resolves.toBeDefined();

		await t.mutation(internal.account.beginDeletion, {
			userId: OWNER.subject,
			granteeEmail: OWNER.email,
		});

		for (const [name, reference, args] of cases) {
			await expect(
				// biome-ignore lint/suspicious/noExplicitAny: one call site over 17 differently-typed mutations
				owner.mutation(reference() as any, args as any),
				`${name} must refuse while the account is being deleted`,
			).rejects.toThrow(ACCOUNT_DELETION_IN_PROGRESS_MESSAGE);
		}
	});

	it("still allows reads, so the deleting client's own UI does not explode", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		await t.mutation(internal.account.beginDeletion, {
			userId: OWNER.subject,
		});

		await expect(
			t.withIdentity(OWNER).query(api.documents.list, {}),
		).resolves.toBeDefined();
	});

	it("does not block a different user", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		await t.mutation(internal.account.beginDeletion, {
			userId: OWNER.subject,
		});

		await expect(
			t.withIdentity(OTHER).mutation(api.settings.save, { json: "{}" }),
		).resolves.toBeDefined();
	});

	it("blocks a reviewer from appending to a document whose OWNER is being deleted", async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		await t.mutation(internal.account.beginDeletion, { userId: OTHER.subject });

		await expect(
			t.withIdentity(OWNER).mutation(api.review.reviewerAppend, {
				documentId: seeded.otherDocumentId,
				nodeId: "sug-2",
				parentNodeId: "other-root",
				patch: JSON.stringify({ from: 0, to: 0, insert: "x" }),
				selection: null,
				createdAt: Date.now(),
			}),
		).rejects.toThrow(ACCOUNT_DELETION_IN_PROGRESS_MESSAGE);
	});

	it("is idempotent and preserves the phase across a retry", async () => {
		const t = convexTest(schema, modules);
		const first = await t.mutation(internal.account.beginDeletion, {
			userId: OWNER.subject,
		});
		expect(first).toMatchObject({ phase: "blobs", resumed: false });

		await t.mutation(internal.account.setDeletionPhase, {
			userId: OWNER.subject,
			phase: "identity",
		});
		const second = await t.mutation(internal.account.beginDeletion, {
			userId: OWNER.subject,
		});
		// Resetting the phase here would turn a legitimate "already deleted" 404
		// from Clerk back into a wrong-instance error.
		expect(second).toMatchObject({ phase: "identity", resumed: true });

		const rows = await t.run((ctx) =>
			ctx.db.query("accountDeletions").collect(),
		);
		expect(rows).toHaveLength(1);
	});

	it("schedules exactly one continuation, in the transaction that fences the account", async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.account.beginDeletion, { userId: OWNER.subject });

		const afterFirst = await t.run((ctx) =>
			ctx.db.system.query("_scheduled_functions").collect(),
		);
		// Scheduling from the action instead left a crash window in which the
		// account was fenced with nothing arranged to finish it.
		expect(afterFirst).toHaveLength(1);
		expect(afterFirst[0]?.name).toContain("resumeDeletion");

		await t.mutation(internal.account.beginDeletion, { userId: OWNER.subject });
		const afterRetry = await t.run((ctx) =>
			ctx.db.system.query("_scheduled_functions").collect(),
		);
		// A retry must not stack up another job.
		expect(afterRetry).toHaveLength(1);
	});

	it("never moves a phase backwards", async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.account.beginDeletion, { userId: OWNER.subject });
		await t.mutation(internal.account.setDeletionPhase, {
			userId: OWNER.subject,
			phase: "purged",
		});

		// An older overlapping run reporting an earlier phase would clear
		// `expiresAt` and un-finish a deletion other jobs have already observed
		// as complete.
		const result = await t.mutation(internal.account.setDeletionPhase, {
			userId: OWNER.subject,
			phase: "rows",
		});
		expect(result.phase).toBe("purged");

		const tombstone = await t.query(internal.account.getDeletion, {
			userId: OWNER.subject,
		});
		expect(tombstone?.phase).toBe("purged");
		expect(tombstone?.expiresAt).toBeGreaterThan(Date.now());
	});

	it("preserves the purged tombstone expiry across retries", async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.account.beginDeletion, { userId: OWNER.subject });
		await t.mutation(internal.account.setDeletionPhase, {
			userId: OWNER.subject,
			phase: "purged",
		});
		const before = await t.query(internal.account.getDeletion, {
			userId: OWNER.subject,
		});

		await t.mutation(internal.account.beginDeletion, { userId: OWNER.subject });
		const after = await t.query(internal.account.getDeletion, {
			userId: OWNER.subject,
		});
		expect(after?.expiresAt).toBe(before?.expiresAt);
	});

	it("repairs a missing expiry on an equal purged transition", async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.account.beginDeletion, { userId: OWNER.subject });
		await t.mutation(internal.account.setDeletionPhase, {
			userId: OWNER.subject,
			phase: "purged",
		});
		await t.run(async (ctx) => {
			const row = await ctx.db.query("accountDeletions").first();
			if (row) await ctx.db.patch(row._id, { expiresAt: undefined });
		});

		await t.mutation(internal.account.setDeletionPhase, {
			userId: OWNER.subject,
			phase: "purged",
		});
		const tombstone = await t.query(internal.account.getDeletion, {
			userId: OWNER.subject,
		});
		expect(tombstone?.expiresAt).toBeGreaterThan(Date.now());
	});

	it("is swept only once its retention window has passed", async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.account.beginDeletion, { userId: OWNER.subject });

		// In flight: no expiry, so the sweep must leave it.
		expect(await t.mutation(internal.account.sweepTombstones, {})).toEqual({
			deleted: 0,
		});

		await t.mutation(internal.account.setDeletionPhase, {
			userId: OWNER.subject,
			phase: "purged",
		});
		// Finished, but still inside the retention window.
		expect(await t.mutation(internal.account.sweepTombstones, {})).toEqual({
			deleted: 0,
		});

		await t.run(async (ctx) => {
			const row = await ctx.db.query("accountDeletions").first();
			if (row) await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
		});
		expect(await t.mutation(internal.account.sweepTombstones, {})).toEqual({
			deleted: 1,
		});
	});
});

describe("account.deleteEverything", () => {
	const originalSecret = process.env.CLERK_SECRET_KEY;

	beforeEach(() => {
		process.env.CLERK_SECRET_KEY = "sk_test_not_a_real_key";
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		if (originalSecret === undefined) delete process.env.CLERK_SECRET_KEY;
		else process.env.CLERK_SECRET_KEY = originalSecret;
	});

	/** Stand-in for the Clerk Backend API. Records what was asked of it. */
	function stubClerk(
		options: {
			externalAccounts?: { provider: string }[];
			deleteStatus?: number;
			userStatus?: number;
			body?: unknown;
		} = {},
	) {
		const calls: { method: string; url: string }[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				calls.push({ method, url });
				if (method === "DELETE") {
					return new Response("{}", { status: options.deleteStatus ?? 200 });
				}
				return new Response(
					JSON.stringify(
						options.body ?? {
							external_accounts: options.externalAccounts ?? [],
						},
					),
					{ status: options.userStatus ?? 200 },
				);
			}),
		);
		return calls;
	}

	it("requires authentication", async () => {
		const t = convexTest(schema, modules);
		stubClerk();
		await expect(t.action(api.account.deleteEverything, {})).rejects.toThrow(
			"Unauthenticated",
		);
	});

	it("refuses, without deleting anything, when CLERK_SECRET_KEY is missing", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		const before = await countAll(t);
		delete process.env.CLERK_SECRET_KEY;

		await expect(
			t.withIdentity(OWNER).action(api.account.deleteEverything, {}),
		).rejects.toThrow(ACCOUNT_DELETION_UNAVAILABLE_MESSAGE);

		expect(await countAll(t)).toEqual(before);
	});

	it("waits out signed upload URLs issued by the previous backend", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		await t.mutation(internal.files.startLegacyUploadCutover, {});
		const before = await countAll(t);
		const calls = stubClerk();

		await expect(
			t.withIdentity(OWNER).action(api.account.deleteEverything, {}),
		).rejects.toThrow(ACCOUNT_DELETION_UPLOAD_CUTOVER_MESSAGE);

		expect(calls).toHaveLength(0);
		expect(await countAll(t)).toEqual(before);
		expect(
			await t.run((ctx) => ctx.db.query("accountDeletions").collect()),
		).toHaveLength(0);
	});

	it("refuses, without deleting anything, when the secret cannot see this user", async () => {
		const t = convexTest(schema, modules);
		await makeLegacyUploadsSafe(t);
		await seed(t);
		await seedBlobs(t);
		const before = await countAll(t);
		// A secret for the WRONG Clerk instance answers 404 to every call.
		stubClerk({ userStatus: 404, deleteStatus: 404 });

		await expect(
			t.withIdentity(OWNER).action(api.account.deleteEverything, {}),
		).rejects.toThrow(CLERK_USER_UNREACHABLE_MESSAGE);

		expect(await countAll(t)).toEqual(before);
		expect(await storageIds(t)).toHaveLength(3);
		// And no tombstone was written, so the account is not bricked.
		expect(
			await t.run((ctx) => ctx.db.query("accountDeletions").collect()),
		).toHaveLength(0);
	});

	it("purges blobs and rows, then deletes the Clerk user last", async () => {
		const t = convexTest(schema, modules);
		await makeLegacyUploadsSafe(t);
		await seed(t);
		const { theirs } = await seedBlobs(t);
		const calls = stubClerk();

		const result = await t
			.withIdentity(OWNER)
			.action(api.account.deleteEverything, {});

		expect(result.clerkUserDeleted).toBe(true);
		expect(result.rowsDeleted).toBeGreaterThan(0);
		expect(result.blobsDeleted).toBe(1);
		expect(result.blobsRetained).toBe(0);
		expect(result.appleRevocation).toEqual({ status: "not-applicable" });
		expect((await countAll(t)).documents).toBe(2);
		expect(await storageIds(t)).toContain(theirs);

		const deleteIndex = calls.findIndex((call) => call.method === "DELETE");
		expect(deleteIndex).toBeGreaterThan(-1);
		expect(calls[deleteIndex]?.url).toBe(
			`https://api.clerk.com/v1/users/${OWNER.subject}`,
		);
		// The identity goes after the data, never before.
		expect(deleteIndex).toBe(calls.length - 1);
	});

	it("leaves the tombstone behind, purged, so late writes still fail", async () => {
		const t = convexTest(schema, modules);
		await makeLegacyUploadsSafe(t);
		await seed(t);
		stubClerk();

		await t.withIdentity(OWNER).action(api.account.deleteEverything, {});

		const tombstone = await t.query(internal.account.getDeletion, {
			userId: OWNER.subject,
		});
		expect(tombstone?.phase).toBe("purged");
		expect(tombstone?.expiresAt).toBeGreaterThan(Date.now());

		// A stale tab's queued write, arriving with a JWT that has not expired yet.
		await expect(
			t.withIdentity(OWNER).mutation(api.settings.save, { json: '{"a":1}' }),
		).rejects.toThrow(ACCOUNT_DELETION_IN_PROGRESS_MESSAGE);
		expect((await countAll(t)).settings).toBe(0);
	});

	it("reports what blocks Apple revocation when the user signed in with Apple", async () => {
		const t = convexTest(schema, modules);
		await makeLegacyUploadsSafe(t);
		await seed(t);
		stubClerk({ externalAccounts: [{ provider: "apple" }] });

		const result = await t
			.withIdentity(OWNER)
			.action(api.account.deleteEverything, {});

		expect(result.appleRevocation.status).toBe("skipped");
		expect(result.appleRevocation).toHaveProperty("reason");
	});

	it("also recognises Apple under its oauth_ prefixed spelling", async () => {
		const t = convexTest(schema, modules);
		await makeLegacyUploadsSafe(t);
		await seed(t);
		stubClerk({ externalAccounts: [{ provider: "oauth_apple" }] });

		const result = await t
			.withIdentity(OWNER)
			.action(api.account.deleteEverything, {});
		expect(result.appleRevocation.status).toBe("skipped");
	});

	it("says 'unknown' rather than 'no Apple account' for a response it cannot read", async () => {
		const t = convexTest(schema, modules);
		await makeLegacyUploadsSafe(t);
		await seed(t);
		stubClerk({ body: { external_accounts: "nope" } });

		const result = await t
			.withIdentity(OWNER)
			.action(api.account.deleteEverything, {});
		expect(result.appleRevocation.status).toBe("unknown");
	});

	it("accepts a 404 on the retry of a deletion that already reached Clerk", async () => {
		const t = convexTest(schema, modules);
		await makeLegacyUploadsSafe(t);
		await seed(t);
		// The state a crashed action leaves: data purged, identity already asked
		// for. Clerk now 404s because the user really is gone.
		await t.mutation(internal.account.beginDeletion, {
			userId: OWNER.subject,
			granteeEmail: OWNER.email,
		});
		await t.mutation(internal.account.setDeletionPhase, {
			userId: OWNER.subject,
			phase: "identity",
		});
		stubClerk({ userStatus: 404, deleteStatus: 404 });

		const result = await t
			.withIdentity(OWNER)
			.action(api.account.deleteEverything, {});
		expect(result.clerkUserDeleted).toBe(true);
	});

	it("fails loudly when Clerk refuses the delete, so the caller knows to retry", async () => {
		const t = convexTest(schema, modules);
		await makeLegacyUploadsSafe(t);
		await seed(t);
		stubClerk({ deleteStatus: 500 });

		await expect(
			t.withIdentity(OWNER).action(api.account.deleteEverything, {}),
		).rejects.toThrow("Clerk refused to delete the user");
		// The data is already gone; the tombstone keeps the account inert until a
		// retry finishes the job.
		expect((await countAll(t)).documents).toBe(2);
	});

	it("is idempotent end to end", async () => {
		const t = convexTest(schema, modules);
		await makeLegacyUploadsSafe(t);
		await seed(t);
		stubClerk();
		const owner = t.withIdentity(OWNER);

		await owner.action(api.account.deleteEverything, {});
		const second = await owner.action(api.account.deleteEverything, {});
		expect(second.rowsDeleted).toBe(0);
		expect(second.clerkUserDeleted).toBe(true);
	});

	it("resumeDeletion finishes a deletion the action did not", async () => {
		const t = convexTest(schema, modules);
		await makeLegacyUploadsSafe(t);
		await seed(t);
		stubClerk();
		await t.mutation(internal.account.beginDeletion, {
			userId: OWNER.subject,
			granteeEmail: OWNER.email,
		});

		await t.action(internal.account.resumeDeletion, {
			userId: OWNER.subject,
			attempt: 1,
		});

		expect((await countAll(t)).documents).toBe(2);
		expect(
			(await t.query(internal.account.getDeletion, { userId: OWNER.subject }))
				?.phase,
		).toBe("purged");
	});

	it("resumeDeletion is a no-op once the deletion is finished", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		const calls = stubClerk();
		await t.mutation(internal.account.beginDeletion, { userId: OWNER.subject });
		await t.mutation(internal.account.setDeletionPhase, {
			userId: OWNER.subject,
			phase: "purged",
		});

		await t.action(internal.account.resumeDeletion, {
			userId: OWNER.subject,
			attempt: 1,
		});
		expect(calls).toHaveLength(0);
		expect((await countAll(t)).documents).toBe(3);
	});
});

/** Drain one bounded migration step until it reports done. */
async function runMigration(
	t: ReturnType<typeof convexTest>,
	// biome-ignore lint/suspicious/noExplicitAny: one driver over five migration steps
	reference: any,
): Promise<void> {
	for (let pass = 0; pass < 200; pass += 1) {
		const result = (await t.mutation(reference, {})) as { done: boolean };
		if (result.done) return;
	}
	throw new Error("migration did not converge");
}

describe("migrations", () => {
	it("backfills authorUserId from the review: origin", async () => {
		const t = convexTest(schema, modules);
		const { otherDocumentId } = await seed(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("docNodes", {
				documentId: otherDocumentId,
				nodeId: "legacy-suggestion",
				parentNodeId: "other-root",
				patch: "{}",
				selection: null,
				origin: `review:${OWNER.subject}`,
				createdAt: Date.now(),
			});
		});

		await runMigration(t, internal.migrations.backfillNodeAuthors);

		const patched = await t.run(async (ctx) =>
			(await ctx.db.query("docNodes").collect()).find(
				(node) => node.nodeId === "legacy-suggestion",
			),
		);
		expect(patched?.authorUserId).toBe(OWNER.subject);
	});

	it("does not re-attribute a node whose author was already cleared", async () => {
		const t = convexTest(schema, modules);
		const { otherDocumentId } = await seed(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("docNodes", {
				documentId: otherDocumentId,
				nodeId: "kept-after-deletion",
				parentNodeId: "other-root",
				patch: "{}",
				selection: null,
				origin: "review:deleted-user",
				createdAt: Date.now(),
			});
		});

		await runMigration(t, internal.migrations.backfillNodeAuthors);

		const patched = await t.run(async (ctx) =>
			(await ctx.db.query("docNodes").collect()).find(
				(node) => node.nodeId === "kept-after-deletion",
			),
		);
		// Re-attributing this would hand a deleted account's nodes back to a
		// user id that no longer exists.
		expect(patched?.authorUserId).toBeUndefined();
	});

	it("derives branchId by walking a branch from its head to its base", async () => {
		const t = convexTest(schema, modules);
		const { otherDocumentId } = await seed(t);
		const branchId = await t.run(async (ctx) => {
			const nodes = await ctx.db.query("docNodes").collect();
			const suggestion = nodes.find((n) => n.nodeId === "owner-suggestion");
			if (suggestion)
				await ctx.db.patch(suggestion._id, { branchId: undefined });
			const branch = (
				await ctx.db
					.query("reviewBranches")
					.withIndex("by_document_reviewer", (q) =>
						q
							.eq("documentId", otherDocumentId)
							.eq("reviewerUserId", OWNER.subject),
					)
					.collect()
			)[0];
			return branch?._id;
		});

		await runMigration(t, internal.migrations.backfillNodeBranches);

		const patched = await t.run(async (ctx) =>
			(await ctx.db.query("docNodes").collect()).find(
				(node) => node.nodeId === "owner-suggestion",
			),
		);
		expect(patched?.branchId).toBe(branchId);
	});

	it("attributes a blob referenced by exactly one user, and only that one", async () => {
		const t = convexTest(schema, modules);
		const { documentId } = await seed(t);
		const storageId = await t.run((ctx) =>
			ctx.storage.store(new Blob(["img"])),
		);
		const url = await t.run((ctx) => ctx.storage.getUrl(storageId));
		await t.run((ctx) =>
			ctx.db.patch(documentId, { markdown: `mine ![a](${url})` }),
		);

		await runMigration(t, internal.migrations.scanDocumentRefs);
		await runMigration(t, internal.migrations.scanNodeRefs);
		await runMigration(t, internal.migrations.backfillBlobOwners);

		const rows = await t.run((ctx) => ctx.db.query("blobs").collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]?.ownerUserId).toBe(OWNER.subject);
	});

	it("attributes a blob referenced only from history", async () => {
		const t = convexTest(schema, modules);
		const { documentId } = await seed(t);
		const storageId = await t.run((ctx) =>
			ctx.storage.store(new Blob(["img"])),
		);
		const url = await t.run((ctx) => ctx.storage.getUrl(storageId));
		await t.run((ctx) =>
			ctx.db.insert("docNodes", {
				documentId,
				nodeId: "with-image",
				parentNodeId: "node-2",
				patch: JSON.stringify({ from: 0, to: 0, insert: `![a](${url})` }),
				selection: null,
				origin: "test",
				createdAt: Date.now(),
			}),
		);

		await runMigration(t, internal.migrations.scanDocumentRefs);
		await runMigration(t, internal.migrations.scanNodeRefs);
		await runMigration(t, internal.migrations.backfillBlobOwners);

		// The live markdown never names it; only an old version does.
		const rows = await t.run((ctx) => ctx.db.query("blobs").collect());
		expect(rows.map((row) => row.ownerUserId)).toEqual([OWNER.subject]);
	});

	it("leaves a blob two users both reference unattributed", async () => {
		const t = convexTest(schema, modules);
		const { documentId, otherDocumentId } = await seed(t);
		const storageId = await t.run((ctx) =>
			ctx.storage.store(new Blob(["img"])),
		);
		const url = await t.run((ctx) => ctx.storage.getUrl(storageId));
		await t.run(async (ctx) => {
			await ctx.db.patch(documentId, { markdown: `mine ![a](${url})` });
			await ctx.db.patch(otherDocumentId, { markdown: `theirs ![a](${url})` });
		});

		await runMigration(t, internal.migrations.scanDocumentRefs);
		await runMigration(t, internal.migrations.scanNodeRefs);
		await runMigration(t, internal.migrations.backfillBlobOwners);

		// Guessing here would let one account's deletion take the other's file.
		expect(await t.run((ctx) => ctx.db.query("blobs").collect())).toHaveLength(
			0,
		);
	});

	it("keeps its own progress, so a re-run does not start over", async () => {
		const t = convexTest(schema, modules);
		await seed(t);

		const first = await t.mutation(internal.migrations.scanDocumentRefs, {
			limit: 1,
		});
		expect(first.done).toBe(false);
		const second = await t.mutation(internal.migrations.scanDocumentRefs, {
			limit: 1,
		});
		// A cursor the caller had to carry is a cursor that gets lost halfway.
		expect(second.scanned).toBe(1);

		await runMigration(t, internal.migrations.scanDocumentRefs);
		const progress = await t.run((ctx) =>
			ctx.db.query("migrationProgress").collect(),
		);
		expect(progress.find((row) => row.name === "scanDocumentRefs")?.done).toBe(
			true,
		);
	});

	it("bounds reference backfill pages by rows and bytes", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let i = 0; i < 5; i += 1) {
				await ctx.db.insert("documents", {
					userId: OWNER.subject,
					title: `Large ${i}`,
					markdown: "x".repeat(900_000),
					wordCount: 1,
					currentNodeId: `root-${i}`,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
			}
		});

		const first = await t.mutation(internal.migrations.scanDocumentRefs, {});
		expect(first.done).toBe(false);
		expect(first.scanned).toBeLessThan(5);
		await runMigration(t, internal.migrations.scanDocumentRefs);
	});

	it("updates the reference index when live markdown changes", async () => {
		const t = convexTest(schema, modules);
		const { documentId } = await seed(t);
		const url = await t.run(async (ctx) =>
			ctx.storage.getUrl(await ctx.storage.store(new Blob(["img"]))),
		);
		await t.run((ctx) =>
			ctx.db.patch(documentId, { markdown: `![a](${url})` }),
		);
		await runMigration(t, internal.migrations.scanDocumentRefs);
		expect(
			await t.run((ctx) => ctx.db.query("blobRefs").collect()),
		).not.toHaveLength(0);

		const doc = await t.withIdentity(OWNER).query(api.documents.get, {
			documentId,
		});
		await t.withIdentity(OWNER).mutation(api.documents.updateMarkdown, {
			documentId,
			markdown: "removed",
			wordCount: 1,
			expectedUpdatedAt: doc?.updatedAt ?? 0,
		});

		expect(
			await t.run((ctx) => ctx.db.query("blobRefs").collect()),
		).toHaveLength(0);
		expect(
			await t.run((ctx) => ctx.db.query("blobRefSources").collect()),
		).toHaveLength(0);
	});

	it("keeps the permanent reference index after the legacy cleanup command", async () => {
		const t = convexTest(schema, modules);
		const { documentId } = await seed(t);
		const url = await t.run(async (ctx) =>
			ctx.storage.getUrl(await ctx.storage.store(new Blob(["img"]))),
		);
		await t.run((ctx) =>
			ctx.db.patch(documentId, { markdown: `![a](${url})` }),
		);

		await runMigration(t, internal.migrations.scanDocumentRefs);
		expect(
			await t.run((ctx) => ctx.db.query("blobRefs").collect()),
		).not.toHaveLength(0);

		await runMigration(t, internal.migrations.cleanupBlobRefs);
		expect(
			await t.run((ctx) => ctx.db.query("blobRefs").collect()),
		).not.toHaveLength(0);
	});
});
