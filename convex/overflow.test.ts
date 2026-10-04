import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ACCOUNT_DELETION_IN_PROGRESS_MESSAGE } from "./accountGuard";
import { MARKDOWN_TOO_LARGE_MESSAGE, MAX_MARKDOWN_LENGTH } from "./documents";
import { MAX_OVERFLOW_BYTES, OVERFLOW_TOO_LARGE_MESSAGE } from "./overflow";
import schema from "./schema";

const modules: Record<string, () => Promise<unknown>> = {
	"./schema.ts": () => import("./schema"),
	"./documents.ts": () => import("./documents"),
	"./docNodes.ts": () => import("./docNodes"),
	"./documentCleanup.ts": () => import("./documentCleanup"),
	"./overflow.ts": () => import("./overflow"),
	"./review.ts": () => import("./review"),
	"./migrations.ts": () => import("./migrations"),
	"./accountPurge.ts": () => import("./accountPurge"),
	"./_generated/api.js": () => import("./_generated/api"),
	"./_generated/server.js": () => import("./_generated/server"),
};

const OWNER = { subject: "owner-user", email: "owner@example.com" };
const OTHER = { subject: "other-user", email: "other@example.com" };

async function draft() {
	const t = convexTest(schema, modules);
	const owner = t.withIdentity(OWNER);
	const { documentId, rootNodeId } = await owner.mutation(
		api.documents.create,
		{
			title: "Draft",
		},
	);
	return { t, owner, documentId, rootNodeId };
}

function noteSave(documentId: Id<"documents">, markdown = "Ideas for later") {
	return {
		documentId,
		markdown,
		expectedRevision: 0,
		clientMutationId: "notes-1",
	};
}

function nodeFor(parentNodeId: string, markdown: string) {
	return {
		nodeId: "prose-1",
		parentNodeId,
		patch: JSON.stringify({ from: 0, to: 0, insert: markdown }),
		selection: null,
		origin: "legacy-client",
		createdAt: Date.now(),
	};
}

async function imageNote(t: TestConvex<typeof schema>) {
	return await t.run(async (ctx) => {
		const storageId = await ctx.storage.store(new Blob(["image"]));
		const url = await ctx.storage.getUrl(storageId);
		if (!url) throw new Error("Stored image URL is missing");
		return `![notes image](${url})`;
	});
}

async function documentRefs(
	t: TestConvex<typeof schema>,
	documentId: Id<"documents">,
) {
	return await t.run(async (ctx) => {
		const source = await ctx.db
			.query("blobRefSources")
			.withIndex("by_source", (q) =>
				q.eq("source", "document").eq("sourceId", documentId),
			)
			.unique();
		return source?.tokens ?? [];
	});
}

async function suggestion(
	t: TestConvex<typeof schema>,
	documentId: Id<"documents">,
	rootNodeId: string,
	markdown: string,
) {
	return await t.run(async (ctx) => {
		await ctx.db.insert("docNodes", {
			documentId,
			...nodeFor(rootNodeId, markdown),
			nodeId: "suggestion-1",
		});
		return await ctx.db.insert("reviewBranches", {
			documentId,
			reviewerUserId: OTHER.subject,
			baseNodeId: rootNodeId,
			headNodeId: "suggestion-1",
			status: "open",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

describe("Overflow persistence", () => {
	it("reads empty state on old documents and saves without moving prose history", async () => {
		const { t, owner, documentId } = await draft();
		const before = await owner.query(api.documents.get, { documentId });
		expect(await owner.query(api.overflow.get, { documentId })).toEqual({
			markdown: "",
			revision: 0,
		});
		expect(
			await owner.mutation(api.overflow.save, noteSave(documentId)),
		).toEqual({
			saved: true,
			revision: 1,
		});
		expect(await owner.query(api.overflow.get, { documentId })).toEqual({
			markdown: "Ideas for later",
			revision: 1,
		});
		expect(await owner.query(api.documents.get, { documentId })).toEqual(
			before,
		);
		expect(
			await t.run((ctx) => ctx.db.query("docNodes").collect()),
		).toHaveLength(1);
	});

	it("returns the original receipt when a response is lost, even after prose changes", async () => {
		const { owner, documentId } = await draft();
		const args = noteSave(documentId);
		const first = await owner.mutation(api.overflow.save, args);
		await owner.mutation(api.documents.rename, {
			documentId,
			title: "Renamed",
		});
		expect(await owner.mutation(api.overflow.save, args)).toEqual(first);
		expect(await owner.query(api.overflow.get, { documentId })).toMatchObject({
			revision: 1,
		});
	});

	it("rejects changed text or revision under the same current save id", async () => {
		const { owner, documentId } = await draft();
		const args = noteSave(documentId);
		await owner.mutation(api.overflow.save, args);
		await expect(
			owner.mutation(api.overflow.save, { ...args, markdown: "Different" }),
		).rejects.toThrow("invalid_argument");
		await expect(
			owner.mutation(api.overflow.save, { ...args, expectedRevision: 1 }),
		).rejects.toThrow("invalid_argument");
		expect(await owner.query(api.overflow.get, { documentId })).toEqual({
			markdown: args.markdown,
			revision: 1,
		});
	});

	it("reports both a concurrent write and an older replay as conflicts without erasing notes", async () => {
		const { owner, documentId } = await draft();
		const first = noteSave(documentId, "Device A");
		await owner.mutation(api.overflow.save, first);
		expect(
			await owner.mutation(api.overflow.save, {
				...noteSave(documentId, "Device B"),
				clientMutationId: "notes-b",
			}),
		).toEqual({ saved: false, markdown: "Device A", revision: 1 });
		await owner.mutation(api.overflow.save, {
			...noteSave(documentId, "Both devices' chosen notes"),
			expectedRevision: 1,
			clientMutationId: "notes-resolved",
		});
		expect(await owner.mutation(api.overflow.save, first)).toEqual({
			saved: false,
			markdown: "Both devices' chosen notes",
			revision: 2,
		});
	});

	it("persists an intentional empty scratchpad as a new revision", async () => {
		const { owner, documentId } = await draft();
		await owner.mutation(api.overflow.save, noteSave(documentId));
		await owner.mutation(api.overflow.save, {
			...noteSave(documentId, ""),
			expectedRevision: 1,
			clientMutationId: "notes-empty",
		});
		expect(await owner.query(api.overflow.get, { documentId })).toEqual({
			markdown: "",
			revision: 2,
		});
	});

	it.each([
		-1,
		0.5,
		Number.MAX_SAFE_INTEGER,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("refuses invalid expected revision %s", async (expectedRevision) => {
		const { owner, documentId } = await draft();
		await expect(
			owner.mutation(api.overflow.save, {
				...noteSave(documentId),
				expectedRevision,
			}),
		).rejects.toThrow("invalid_argument");
	});

	it.each([
		"",
		"   ",
		"x".repeat(65),
	])("refuses an invalid save identifier", async (clientMutationId) => {
		const { owner, documentId } = await draft();
		await expect(
			owner.mutation(api.overflow.save, {
				...noteSave(documentId),
				clientMutationId,
			}),
		).rejects.toThrow("invalid_argument");
	});

	it("enforces the scratchpad limit in UTF-8 bytes without changing saved notes", async () => {
		const { owner, documentId } = await draft();
		await owner.mutation(
			api.overflow.save,
			noteSave(documentId, "é".repeat(MAX_OVERFLOW_BYTES / 2)),
		);
		await expect(
			owner.mutation(api.overflow.save, {
				...noteSave(documentId, "é".repeat(MAX_OVERFLOW_BYTES / 2 + 1)),
				expectedRevision: 1,
				clientMutationId: "too-big",
			}),
		).rejects.toThrow(OVERFLOW_TOO_LARGE_MESSAGE);
		expect(await owner.query(api.overflow.get, { documentId })).toMatchObject({
			revision: 1,
		});
	});

	it("refuses notes that exceed the combined document limit", async () => {
		const { t, owner, documentId } = await draft();
		await t.run((ctx) =>
			ctx.db.patch(documentId, { markdown: "x".repeat(MAX_MARKDOWN_LENGTH) }),
		);
		await expect(
			owner.mutation(api.overflow.save, noteSave(documentId, "é")),
		).rejects.toThrow(MARKDOWN_TOO_LARGE_MESSAGE);
		expect(await owner.query(api.overflow.get, { documentId })).toEqual({
			markdown: "",
			revision: 0,
		});
	});
});

describe("Overflow remains private and follows document deletion", () => {
	it("refuses unauthenticated users and non-owners, including shared reviewers", async () => {
		const { t, owner, documentId } = await draft();
		await owner.mutation(api.overflow.save, noteSave(documentId));
		await t.run((ctx) =>
			ctx.db.insert("documentShares", {
				documentId,
				ownerUserId: OWNER.subject,
				granteeEmail: OTHER.email,
				granteeUserId: OTHER.subject,
				role: "suggester",
				createdAt: Date.now(),
			}),
		);
		for (const caller of [t, t.withIdentity(OTHER)]) {
			await expect(
				caller.query(api.overflow.get, { documentId }),
			).rejects.toThrow();
			await expect(
				caller.mutation(api.overflow.save, noteSave(documentId)),
			).rejects.toThrow();
		}
		expect(await owner.query(api.overflow.get, { documentId })).toMatchObject({
			revision: 1,
		});
	});

	it("blocks saving behind an account deletion tombstone", async () => {
		const { t, owner, documentId } = await draft();
		await t.run((ctx) =>
			ctx.db.insert("accountDeletions", {
				userId: OWNER.subject,
				startedAt: Date.now(),
				updatedAt: Date.now(),
				phase: "rows",
			}),
		);
		await expect(
			owner.mutation(api.overflow.save, noteSave(documentId)),
		).rejects.toThrow(ACCOUNT_DELETION_IN_PROGRESS_MESSAGE);
	});

	it("document removal deletes notes and their image references and rejects late saves", async () => {
		const { t, owner, documentId } = await draft();
		await owner.mutation(
			api.overflow.save,
			noteSave(documentId, await imageNote(t)),
		);
		expect(await documentRefs(t, documentId)).not.toHaveLength(0);
		await owner.mutation(api.documents.remove, { documentId });
		expect(await documentRefs(t, documentId)).toEqual([]);
		await expect(owner.query(api.overflow.get, { documentId })).rejects.toThrow(
			"not_found",
		);
		await expect(
			owner.mutation(api.overflow.save, noteSave(documentId)),
		).rejects.toThrow("not_found");
	});

	it("account purge removes document-owned notes and reference indexes", async () => {
		const { t, owner, documentId } = await draft();
		await owner.mutation(
			api.overflow.save,
			noteSave(documentId, await imageNote(t)),
		);
		for (let pass = 0; pass < 8; pass += 1) {
			const result = await t.mutation(internal.accountPurge.purgeData, {
				userId: OWNER.subject,
			});
			if (result.done) break;
		}
		expect(await t.run((ctx) => ctx.db.get(documentId))).toBeNull();
		expect(await documentRefs(t, documentId)).toEqual([]);
	});
});

describe("text-only clients preserve Overflow", () => {
	it.each([
		"updateMarkdown",
		"commitEdit",
		"updateCurrentNodeId",
	] as const)("%s retains scratchpad text, revision and image references", async (operation) => {
		const { t, owner, documentId, rootNodeId } = await draft();
		const markdown = await imageNote(t);
		await owner.mutation(api.overflow.save, noteSave(documentId, markdown));
		const tokens = await documentRefs(t, documentId);
		expect(tokens).not.toHaveLength(0);
		const doc = await owner.query(api.documents.get, { documentId });
		if (operation === "updateMarkdown") {
			await owner.mutation(api.documents.updateMarkdown, {
				documentId,
				markdown: "Prose",
				wordCount: 1,
				expectedUpdatedAt: doc?.updatedAt ?? 0,
			});
		} else if (operation === "commitEdit") {
			await owner.mutation(api.documents.commitEdit, {
				documentId,
				node: nodeFor(rootNodeId, "Prose"),
				markdown: "Prose",
				wordCount: 1,
				expectedHeadNodeId: rootNodeId,
				clientMutationId: "prose-save",
			});
		} else {
			await owner.mutation(api.documents.updateCurrentNodeId, {
				documentId,
				currentNodeId: rootNodeId,
				markdown: "",
				wordCount: 0,
				updatedAt: Date.now() + 1,
			});
		}
		await owner.mutation(api.documents.rename, {
			documentId,
			title: "Renamed",
		});
		expect(await owner.query(api.overflow.get, { documentId })).toEqual({
			markdown,
			revision: 1,
		});
		expect(await documentRefs(t, documentId)).toEqual(tokens);
	});

	it.each([
		"updateMarkdown",
		"commitEdit",
		"updateCurrentNodeId",
	] as const)("%s refuses prose that leaves no room for retained notes", async (operation) => {
		const { owner, documentId, rootNodeId } = await draft();
		await owner.mutation(
			api.overflow.save,
			noteSave(documentId, "n".repeat(200)),
		);
		const markdown = "x".repeat(MAX_MARKDOWN_LENGTH - 199);
		const doc = await owner.query(api.documents.get, { documentId });
		const save =
			operation === "updateMarkdown"
				? owner.mutation(api.documents.updateMarkdown, {
						documentId,
						markdown,
						wordCount: 1,
						expectedUpdatedAt: doc?.updatedAt ?? 0,
					})
				: operation === "commitEdit"
					? owner.mutation(api.documents.commitEdit, {
							documentId,
							node: nodeFor(rootNodeId, markdown),
							markdown,
							wordCount: 1,
							expectedHeadNodeId: rootNodeId,
							clientMutationId: "prose-save",
						})
					: owner.mutation(api.documents.updateCurrentNodeId, {
							documentId,
							currentNodeId: rootNodeId,
							markdown,
							wordCount: 1,
							updatedAt: Date.now() + 1,
						});
		await expect(save).rejects.toThrow(MARKDOWN_TOO_LARGE_MESSAGE);
		expect(await owner.query(api.documents.get, { documentId })).toEqual(doc);
	});

	it.each([
		"acceptBranch",
		"acceptHunks",
	] as const)("%s retains Overflow image references", async (operation) => {
		const { t, owner, documentId, rootNodeId } = await draft();
		const markdown = await imageNote(t);
		await owner.mutation(api.overflow.save, noteSave(documentId, markdown));
		const tokens = await documentRefs(t, documentId);
		const branchId = await suggestion(
			t,
			documentId,
			rootNodeId,
			"Reviewed prose",
		);
		if (operation === "acceptBranch") {
			await owner.mutation(api.review.acceptBranch, { documentId, branchId });
		} else {
			await owner.mutation(api.review.acceptHunks, {
				documentId,
				branchId,
				granularity: "word",
				acceptedHunks: [0],
			});
		}
		expect(await owner.query(api.overflow.get, { documentId })).toEqual({
			markdown,
			revision: 1,
		});
		expect(await documentRefs(t, documentId)).toEqual(tokens);
	});

	it.each([
		"acceptBranch",
		"acceptHunks",
	] as const)("%s enforces the combined document limit", async (operation) => {
		const { t, owner, documentId, rootNodeId } = await draft();
		await owner.mutation(api.overflow.save, noteSave(documentId));
		const branchId = await suggestion(
			t,
			documentId,
			rootNodeId,
			"x".repeat(MAX_MARKDOWN_LENGTH),
		);
		const save =
			operation === "acceptBranch"
				? owner.mutation(api.review.acceptBranch, { documentId, branchId })
				: owner.mutation(api.review.acceptHunks, {
						documentId,
						branchId,
						granularity: "word",
						acceptedHunks: [0],
					});
		await expect(save).rejects.toThrow(MARKDOWN_TOO_LARGE_MESSAGE);
		expect(await owner.query(api.documents.get, { documentId })).toMatchObject({
			currentNodeId: rootNodeId,
			markdown: "",
		});
	});

	it("backfilling document references retains images found only in notes", async () => {
		const { t, owner, documentId } = await draft();
		await owner.mutation(
			api.overflow.save,
			noteSave(documentId, await imageNote(t)),
		);
		const tokens = await documentRefs(t, documentId);
		await t.mutation(internal.migrations.scanDocumentRefs, {});
		expect(await documentRefs(t, documentId)).toEqual(tokens);
	});
});
