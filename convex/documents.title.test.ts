import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules: Record<string, () => Promise<unknown>> = {
	"./schema.ts": () => import("./schema"),
	"./documents.ts": () => import("./documents"),
	"./docNodes.ts": () => import("./docNodes"),
	"./migrations.ts": () => import("./migrations"),
	"./accountPurge.ts": () => import("./accountPurge"),
	"./blobReferences.ts": () => import("./blobReferences"),
	"./storageTokens.ts": () => import("./storageTokens"),
	"./_generated/api.js": () => import("./_generated/api"),
	"./_generated/server.js": () => import("./_generated/server"),
};

const OWNER = { subject: "owner-user", email: "owner@example.com" };

describe("document title provenance", () => {
	it("creates derived titles and updates them with content", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const { documentId, rootNodeId } = await owner.mutation(
			api.documents.create,
			{},
		);
		const before = await owner.query(api.documents.get, { documentId });
		expect(before).toMatchObject({ title: "Untitled", titleMode: "derived" });

		await owner.mutation(api.documents.commitEdit, {
			documentId,
			node: {
				nodeId: "node-1",
				parentNodeId: rootNodeId,
				patch: JSON.stringify({ from: 0, to: 0, insert: "# New title" }),
				selection: null,
				origin: "test",
				createdAt: 2,
			},
			markdown: "# New title",
			wordCount: 2,
			title: "New title",
			expectedHeadNodeId: rootNodeId,
			clientMutationId: "commit-1",
		});

		expect(await owner.query(api.documents.get, { documentId })).toMatchObject({
			title: "New title",
			titleMode: "derived",
		});
	});

	it("a same-value rename makes the title manual and freezes derivation", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const { documentId } = await owner.mutation(api.documents.create, {});

		await owner.mutation(api.documents.rename, {
			documentId,
			title: "Untitled",
		});
		const renamed = await owner.query(api.documents.get, { documentId });
		expect(renamed?.titleMode).toBe("manual");

		await owner.mutation(api.documents.updateMarkdown, {
			documentId,
			markdown: "# Must not replace",
			wordCount: 3,
			expectedUpdatedAt: renamed?.updatedAt ?? 0,
			title: "Must not replace",
		});
		expect(await owner.query(api.documents.get, { documentId })).toMatchObject({
			title: "Untitled",
			titleMode: "manual",
		});
	});

	it("advances a same-millisecond manual revision", async () => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(100);
		try {
			const t = convexTest(schema, modules);
			const owner = t.withIdentity(OWNER);
			const { documentId } = await owner.mutation(api.documents.create, {});
			const before = await owner.query(api.documents.get, { documentId });

			await owner.mutation(api.documents.rename, {
				documentId,
				title: "Untitled",
			});
			const renamed = await owner.query(api.documents.get, { documentId });

			expect(renamed?.titleMode).toBe("manual");
			expect(renamed?.updatedAt).toBe((before?.updatedAt ?? 0) + 1);
		} finally {
			clock.mockRestore();
		}
	});

	it("treats unmigrated rows as manual", async () => {
		const t = convexTest(schema, modules);
		const documentId = await t.run((ctx) =>
			ctx.db.insert("documents", {
				userId: OWNER.subject,
				title: "Legacy name",
				markdown: "",
				wordCount: 0,
				currentNodeId: "root",
				createdAt: 1,
				updatedAt: 1,
			}),
		);
		const owner = t.withIdentity(OWNER);

		expect(await owner.query(api.documents.get, { documentId })).toMatchObject({
			title: "Legacy name",
			titleMode: "manual",
		});
		await owner.mutation(api.documents.updateMarkdown, {
			documentId,
			markdown: "# Derived",
			wordCount: 1,
			expectedUpdatedAt: 1,
			title: "Derived",
		});
		expect((await owner.query(api.documents.get, { documentId }))?.title).toBe(
			"Legacy name",
		);
	});

	it("backfills legacy rows in bounded idempotent batches", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let index = 0; index < 3; index += 1) {
				await ctx.db.insert("documents", {
					userId: OWNER.subject,
					title: `Legacy ${index}`,
					markdown: "",
					wordCount: 0,
					currentNodeId: `root-${index}`,
					createdAt: index,
					updatedAt: index,
				});
			}
		});

		const first = await t.mutation(
			internal.migrations.backfillDocumentTitleModes,
			{ limit: 2 },
		);
		const second = await t.mutation(
			internal.migrations.backfillDocumentTitleModes,
			{ limit: 2 },
		);
		const third = await t.mutation(
			internal.migrations.backfillDocumentTitleModes,
			{ limit: 2 },
		);
		expect(first).toMatchObject({ scanned: 2, updated: 2, done: false });
		expect(second).toMatchObject({ scanned: 1, updated: 1, done: true });
		expect(third).toMatchObject({ scanned: 0, updated: 0, done: true });
		expect(await t.run((ctx) => ctx.db.query("documents").collect())).toSatisfy(
			(documents: Array<{ titleMode?: string }>) =>
				documents.every((document) => document.titleMode === "manual"),
		);
	});
});
