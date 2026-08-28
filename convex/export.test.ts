import { convexTest } from "convex-test";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { EXPORT_TTL_MS } from "./export";
import schema from "./schema";

// jszip is already a transitive dependency of remark-docx's compiler; these
// tests read the produced archive rather than trusting a byte count.
const modules: Record<string, () => Promise<unknown>> = {
	"./schema.ts": () => import("./schema"),
	"./export.ts": () => import("./export"),
	"./documents.ts": () => import("./documents"),
	"./files.ts": () => import("./files"),
	"./_generated/api.js": () => import("./_generated/api"),
	"./_generated/server.js": () => import("./_generated/server"),
};

const OWNER = { subject: "owner-user", email: "owner@example.com" };
const OTHER = { subject: "other-user", email: "other@example.com" };

const FIXTURE = `---
title: Frontmatter Title
---

# Heading

Text with a [relative link](/doc/abc).
`;

/**
 * Read a stored file's bytes. The Blob itself cannot cross convex-test's
 * mutation boundary ("Blob is not a supported Convex type"), so the unwrap has
 * to happen inside `t.run`.
 */
async function storedBytes(
	t: ReturnType<typeof convexTest>,
	storageId: string,
): Promise<ArrayBuffer | null> {
	return await t.run(async (ctx) => {
		const blob = await ctx.storage.get(storageId as Id<"_storage">);
		return blob === null ? null : await blob.arrayBuffer();
	});
}

async function seedDocument(
	t: ReturnType<typeof convexTest>,
	userId: string,
	markdown = FIXTURE,
	title = "Row Title",
): Promise<Id<"documents">> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert("documents", {
			userId,
			title,
			markdown,
			wordCount: 5,
			currentNodeId: "root",
			createdAt: now,
			updatedAt: now,
		});
	});
}

describe("export.docx", () => {
	it("requires authentication", async () => {
		const t = convexTest(schema, modules);
		const documentId = await seedDocument(t, OWNER.subject);
		await expect(t.action(api.export.docx, { documentId })).rejects.toThrow(
			"Unauthenticated",
		);
	});

	it("refuses to export someone else's document", async () => {
		const t = convexTest(schema, modules);
		const documentId = await seedDocument(t, OWNER.subject);
		await expect(
			t.withIdentity(OTHER).action(api.export.docx, { documentId }),
		).rejects.toThrow("Document not found");
	});

	it("stores a real .docx and hands back a URL and filename", async () => {
		const t = convexTest(schema, modules);
		const documentId = await seedDocument(t, OWNER.subject);

		const before = Date.now();
		const result = await t
			.withIdentity(OWNER)
			.action(api.export.docx, { documentId });

		expect(result.filename).toBe("Row Title.docx");
		expect(result.bytes).toBeGreaterThan(0);
		expect(result.url).toContain("/");
		expect(result.expiresAt).toBeGreaterThanOrEqual(before + EXPORT_TTL_MS);

		const bytes = await storedBytes(t, result.storageId);
		expect(bytes).not.toBeNull();
		const zip = await JSZip.loadAsync(bytes as ArrayBuffer);
		// A .docx is a zip whose body lives at this path — proof it is not, say,
		// an empty blob or an HTML error page.
		const body = await zip.file("word/document.xml")?.async("string");
		expect(body).toContain("Heading");
	});

	it("renders the SERVER's markdown, through the same pipeline as the browser", async () => {
		const t = convexTest(schema, modules);
		const documentId = await seedDocument(t, OWNER.subject);

		const result = await t
			.withIdentity(OWNER)
			.action(api.export.docx, { documentId, origin: "https://example.test" });

		const zip = await JSZip.loadAsync(
			(await storedBytes(t, result.storageId)) as ArrayBuffer,
		);
		const rels = await zip
			.file("word/_rels/document.xml.rels")
			?.async("string");
		// The shared renderer absolutizes root-relative hrefs against `origin`.
		expect(rels).toContain("https://example.test/doc/abc");

		const body = await zip.file("word/document.xml")?.async("string");
		// Frontmatter is metadata, not body — the same rule the web export follows.
		expect(body).not.toContain("Frontmatter Title");
	});

	it("queues the stored file's deletion at the TTL, not immediately", async () => {
		const t = convexTest(schema, modules);
		const documentId = await seedDocument(t, OWNER.subject);
		const before = Date.now();
		const result = await t
			.withIdentity(OWNER)
			.action(api.export.docx, { documentId });

		// Still fetchable now — the client has to be able to download it.
		expect(await storedBytes(t, result.storageId)).not.toBeNull();

		const scheduled = await t.run((ctx) =>
			ctx.db.system.query("_scheduled_functions").collect(),
		);
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]?.name).toContain("deleteStoredFile");
		expect(scheduled[0]?.args[0]).toMatchObject({
			storageId: result.storageId,
		});
		expect(scheduled[0]?.scheduledTime).toBeGreaterThanOrEqual(
			before + EXPORT_TTL_MS,
		);
	});

	it("deletes the file when that scheduled job runs, and tolerates a repeat", async () => {
		const t = convexTest(schema, modules);
		const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["x"])));

		await t.mutation(internal.files.deleteStoredFile, { storageId });
		expect(await storedBytes(t, storageId)).toBeNull();

		// The expiry can fire against a file something else already removed.
		await expect(
			t.mutation(internal.files.deleteStoredFile, { storageId }),
		).resolves.toBeNull();
	});
});
