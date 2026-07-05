import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

// Explicit module map for convex-test (mirrors lib/review/access.test.ts).
// Keys must include a "_generated" path so convex-test can locate the
// function-bundle root (it splits a key on "_generated"). Relative imports —
// this file lives inside convex/, and the convex tsconfig (used by
// `convex codegen`) has no "@/*" path alias.
const modules: Record<string, () => Promise<unknown>> = {
	"./schema.ts": () => import("./schema"),
	"./documents.ts": () => import("./documents"),
	"./files.ts": () => import("./files"),
	"./_generated/api.js": () => import("./_generated/api"),
	"./_generated/server.js": () => import("./_generated/server"),
};

const OWNER = { subject: "owner-user", email: "owner@example.com" };

/**
 * Markdown image reference around the REAL served URL (from ctx.storage.getUrl)
 * — the exact string the client inserts (lib/editor/image-upload.ts). Never
 * hand-build the URL from the doc id: in production the served URL embeds a
 * storage UUID distinct from the `_storage` document id, and the sweep resolves
 * URLs via the same getUrl API this exercises.
 */
function imageMarkdown(url: string): string {
	return `![pic](${url})`;
}

/** Let Date.now() advance past stored files' _creationTime (real timers). */
function ageFiles(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 5));
}

describe("plan 013 — document delete GC", () => {
	it("documents.remove cascades docChunks", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);

		const { documentId } = await owner.mutation(api.documents.create, {
			title: "Draft",
		});

		await t.run(async (ctx) => {
			await ctx.db.insert("docChunks", {
				userId: OWNER.subject,
				documentId,
				charStart: 0,
				charEnd: 5,
				text: "alpha",
				embedding: new Array(1536).fill(0),
				embeddedNodeId: "node-1",
				updatedAt: Date.now(),
			});
			await ctx.db.insert("docChunks", {
				userId: OWNER.subject,
				documentId,
				charStart: 5,
				charEnd: 10,
				text: "bravo",
				embedding: new Array(1536).fill(0.5),
				embeddedNodeId: "node-1",
				updatedAt: Date.now(),
			});
		});

		await owner.mutation(api.documents.remove, { documentId });

		const remaining = await t.run(async (ctx) =>
			ctx.db
				.query("docChunks")
				.withIndex("by_document", (q) => q.eq("documentId", documentId))
				.collect(),
		);
		expect(remaining).toHaveLength(0);
	});

	it("orphanSweep keeps a blob referenced in live document markdown", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);

		const { documentId } = await owner.mutation(api.documents.create, {
			title: "With image",
		});
		const storageId = await t.run(async (ctx) =>
			ctx.storage.store(new Blob(["image-bytes"])),
		);
		await t.run(async (ctx) => {
			const url = await ctx.storage.getUrl(storageId);
			if (!url) throw new Error("expected a servable URL for stored blob");
			await ctx.db.patch(documentId, { markdown: imageMarkdown(url) });
		});

		await ageFiles();
		const result = await t.mutation(internal.files.orphanSweep, {
			graceMs: 0,
		});

		expect(result).toEqual({ scanned: 1, deleted: 0 });
		const file = await t.run(async (ctx) => ctx.db.system.get(storageId));
		expect(file).not.toBeNull();
	});

	it("orphanSweep keeps blobs referenced only in docNodes history (snapshot or patch)", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);

		// Live markdown stays "" — references exist only in history rows.
		const { documentId } = await owner.mutation(api.documents.create, {
			title: "History only",
		});
		const snapshotRefId = await t.run(async (ctx) =>
			ctx.storage.store(new Blob(["snapshot-referenced"])),
		);
		const patchRefId = await t.run(async (ctx) =>
			ctx.storage.store(new Blob(["patch-referenced"])),
		);
		await t.run(async (ctx) => {
			const snapshotUrl = await ctx.storage.getUrl(snapshotRefId);
			const patchUrl = await ctx.storage.getUrl(patchRefId);
			if (!snapshotUrl || !patchUrl)
				throw new Error("expected servable URLs for stored blobs");
			await ctx.db.insert("docNodes", {
				documentId,
				nodeId: "node-snapshot",
				parentNodeId: null,
				patch: JSON.stringify({ from: 0, to: 0, insert: "" }),
				snapshot: imageMarkdown(snapshotUrl),
				selection: null,
				origin: "test",
				createdAt: Date.now(),
			});
			await ctx.db.insert("docNodes", {
				documentId,
				nodeId: "node-patch",
				parentNodeId: "node-snapshot",
				patch: JSON.stringify({
					from: 0,
					to: 0,
					insert: imageMarkdown(patchUrl),
				}),
				selection: null,
				origin: "test",
				createdAt: Date.now(),
			});
		});

		await ageFiles();
		const result = await t.mutation(internal.files.orphanSweep, {
			graceMs: 0,
		});

		expect(result).toEqual({ scanned: 2, deleted: 0 });
		const kept = await t.run(async (ctx) => [
			await ctx.db.system.get(snapshotRefId),
			await ctx.db.system.get(patchRefId),
		]);
		expect(kept[0]).not.toBeNull();
		expect(kept[1]).not.toBeNull();
	});

	it("orphanSweep deletes an unreferenced blob older than the grace window", async () => {
		const t = convexTest(schema, modules);

		const storageId = await t.run(async (ctx) =>
			ctx.storage.store(new Blob(["orphan"])),
		);

		await ageFiles();
		const result = await t.mutation(internal.files.orphanSweep, {
			graceMs: 0,
		});

		expect(result).toEqual({ scanned: 1, deleted: 1 });
		const file = await t.run(async (ctx) => ctx.db.system.get(storageId));
		expect(file).toBeNull();
	});

	it("orphanSweep keeps an unreferenced blob still within the grace window", async () => {
		const t = convexTest(schema, modules);

		const storageId = await t.run(async (ctx) =>
			ctx.storage.store(new Blob(["fresh-orphan"])),
		);

		// Default 24h grace window — freshly stored file must survive.
		const result = await t.mutation(internal.files.orphanSweep, {});

		expect(result).toEqual({ scanned: 1, deleted: 0 });
		const file = await t.run(async (ctx) => ctx.db.system.get(storageId));
		expect(file).not.toBeNull();
	});
});
