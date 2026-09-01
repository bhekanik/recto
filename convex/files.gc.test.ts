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
	"./documentCleanup.ts": () => import("./documentCleanup"),
	"./ai/runs.ts": () => import("./ai/runs"),
	"./ai/limits.ts": () => import("./ai/limits"),
	"./accountGuard.ts": () => import("./accountGuard"),
	"./accountPurge.ts": () => import("./accountPurge"),
	"./blobReferences.ts": () => import("./blobReferences"),
	"./storageTokens.ts": () => import("./storageTokens"),
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

		let cleanup = await t.mutation(internal.documentCleanup.run, {
			documentId,
		});
		for (let attempt = 0; attempt < 4 && !cleanup.done; attempt += 1) {
			cleanup = await t.mutation(internal.documentCleanup.run, { documentId });
		}
		const remaining = await t.run(async (ctx) => ({
			chunks: await ctx.db
				.query("docChunks")
				.withIndex("by_document", (q) => q.eq("documentId", documentId))
				.collect(),
			job: await ctx.db
				.query("aiDocumentDeletions")
				.withIndex("by_document", (q) => q.eq("documentId", documentId))
				.unique(),
		}));
		expect(remaining).toEqual({ chunks: [], job: null });
	});

	it("hides a large document first and drains its graph in bounded passes", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const { documentId } = await owner.mutation(api.documents.create, {
			title: "Large draft",
		});
		await t.run(async (ctx) => {
			for (let index = 0; index < 130; index += 1) {
				await ctx.db.insert("versions", {
					documentId,
					nodeId: `node-${index}`,
					label: `Version ${index}`,
					kind: "auto",
					createdAt: index + 1,
				});
				await ctx.db.insert("docChunks", {
					userId: OWNER.subject,
					documentId,
					charStart: index,
					charEnd: index + 1,
					text: `${index}`,
					embedding: new Array(1536).fill(0),
					embeddedNodeId: "old",
					updatedAt: index + 1,
				});
			}
		});

		await owner.mutation(api.documents.remove, { documentId });
		const hidden = await t.run(async (ctx) => ({
			document: await ctx.db.get(documentId),
			job: await ctx.db
				.query("aiDocumentDeletions")
				.withIndex("by_document", (q) => q.eq("documentId", documentId))
				.unique(),
			versions: await ctx.db
				.query("versions")
				.withIndex("by_document", (q) => q.eq("documentId", documentId))
				.collect(),
		}));
		expect(hidden.document).toBeNull();
		expect(hidden.job).not.toBeNull();
		expect(hidden.versions).toHaveLength(130);

		const first = await t.mutation(internal.documentCleanup.run, {
			documentId,
		});
		expect(first).toEqual({ done: false, deleted: 1 });
		const second = await t.mutation(internal.documentCleanup.run, {
			documentId,
		});
		expect(second).toEqual({ done: false, deleted: 64 });

		let result = second;
		for (let attempt = 0; attempt < 10 && !result.done; attempt += 1) {
			result = await t.mutation(internal.documentCleanup.run, { documentId });
		}
		expect(result.done).toBe(true);
		const remaining = await t.run(async (ctx) => ({
			versions: await ctx.db
				.query("versions")
				.withIndex("by_document", (q) => q.eq("documentId", documentId))
				.collect(),
			chunks: await ctx.db
				.query("docChunks")
				.withIndex("by_document", (q) => q.eq("documentId", documentId))
				.collect(),
			job: await ctx.db
				.query("aiDocumentDeletions")
				.withIndex("by_document", (q) => q.eq("documentId", documentId))
				.unique(),
		}));
		expect(remaining).toEqual({ versions: [], chunks: [], job: null });
	});

	it("account deletion finishes an already-hidden document cleanup job", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const { documentId } = await owner.mutation(api.documents.create, {
			title: "Delete twice",
		});
		await t.run(async (ctx) => {
			for (let index = 0; index < 70; index += 1) {
				await ctx.db.insert("docChunks", {
					userId: OWNER.subject,
					documentId,
					charStart: index,
					charEnd: index + 1,
					text: `${index}`,
					embedding: new Array(1536).fill(0),
					embeddedNodeId: "old",
					updatedAt: index + 1,
				});
			}
		});
		await owner.mutation(api.documents.remove, { documentId });

		let purge = await t.mutation(internal.accountPurge.purgeData, {
			userId: OWNER.subject,
		});
		expect(purge.deleted).toBeGreaterThan(0);
		expect(purge.done).toBe(false);
		for (let attempt = 0; attempt < 8 && !purge.done; attempt += 1) {
			purge = await t.mutation(internal.accountPurge.purgeData, {
				userId: OWNER.subject,
			});
		}
		const remaining = await t.run(async (ctx) => ({
			chunks: await ctx.db
				.query("docChunks")
				.withIndex("by_document", (q) => q.eq("documentId", documentId))
				.collect(),
			job: await ctx.db
				.query("aiDocumentDeletions")
				.withIndex("by_document", (q) => q.eq("documentId", documentId))
				.unique(),
		}));
		expect(remaining).toEqual({ chunks: [], job: null });
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
