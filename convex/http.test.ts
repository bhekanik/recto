import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import { MAX_UPLOAD_BYTES } from "./files";
import schema from "./schema";

const modules: Record<string, () => Promise<unknown>> = {
	"./schema.ts": () => import("./schema"),
	"./http.ts": () => import("./http"),
	"./files.ts": () => import("./files"),
	"./account.ts": () => import("./account"),
	"./accountGuard.ts": () => import("./accountGuard"),
	"./accountPurge.ts": () => import("./accountPurge"),
	"./documents.ts": () => import("./documents"),
	"./_generated/api.js": () => import("./_generated/api"),
	"./_generated/server.js": () => import("./_generated/server"),
};

const OWNER = { subject: "owner-user", email: "owner@example.com" };

function upload(
	t: ReturnType<typeof convexTest>,
	body: BodyInit,
	headers: Record<string, string> = {},
): Promise<Response> {
	return t.fetch("/upload-image", {
		method: "POST",
		headers: { "Content-Type": "image/png", ...headers },
		body,
	});
}

describe("POST /upload-image", () => {
	it("refuses an unauthenticated upload", async () => {
		const t = convexTest(schema, modules);
		const res = await upload(t, new Blob(["bytes"]));
		expect(res.status).toBe(401);
		expect(
			await t.run((ctx) => ctx.db.system.query("_storage").collect()),
		).toHaveLength(0);
	});

	it("stores the bytes and records ownership in one call", async () => {
		const t = convexTest(schema, modules);
		const res = await t.withIdentity(OWNER).fetch("/upload-image", {
			method: "POST",
			headers: { "Content-Type": "image/png" },
			body: new Blob(["bytes"]),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { storageId: string; url: string };
		expect(body.url).toContain("/api/storage/");

		// The point of the endpoint: there is no window in which the file exists
		// and nothing knows whose it is.
		const blobs = await t.run((ctx) => ctx.db.query("blobs").collect());
		expect(blobs).toHaveLength(1);
		expect(blobs[0]).toMatchObject({
			ownerUserId: OWNER.subject,
			kind: "upload",
		});
		expect(blobs[0]?.storageId).toBe(body.storageId);
	});

	it("rejects an empty body", async () => {
		const t = convexTest(schema, modules);
		const res = await t.withIdentity(OWNER).fetch("/upload-image", {
			method: "POST",
			headers: { "Content-Type": "image/png" },
			body: new Blob([]),
		});
		expect(res.status).toBe(400);
	});

	it("rejects an oversized upload without storing it", async () => {
		const t = convexTest(schema, modules);
		// The real body, not a lying Content-Length: the test harness normalises
		// that header away, and the body check is the one that actually protects
		// the deployment anyway.
		const oversized = new Blob([new Uint8Array(MAX_UPLOAD_BYTES + 1)]);
		const res = await t.withIdentity(OWNER).fetch("/upload-image", {
			method: "POST",
			headers: { "Content-Type": "image/png" },
			body: oversized,
		});
		expect(res.status).toBe(413);
		expect(
			await t.run((ctx) => ctx.db.system.query("_storage").collect()),
		).toHaveLength(0);
	});

	it("deletes the file it just stored when the claim is refused", async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.account.beginDeletion, { userId: OWNER.subject });

		const res = await t.withIdentity(OWNER).fetch("/upload-image", {
			method: "POST",
			headers: { "Content-Type": "image/png" },
			body: new Blob(["bytes"]),
		});
		expect(res.status).toBe(409);
		// An unclaimed file is the exact failure this endpoint exists to remove,
		// so a refused claim must not leave one behind.
		expect(
			await t.run((ctx) => ctx.db.system.query("_storage").collect()),
		).toHaveLength(0);
		expect(await t.run((ctx) => ctx.db.query("blobs").collect())).toHaveLength(
			0,
		);
	});

	it("answers the browser's preflight", async () => {
		const t = convexTest(schema, modules);
		// The studio is served from a different origin than convex.site, so the
		// browser will not send the POST at all without this.
		const res = await t.fetch("/upload-image", { method: "OPTIONS" });
		expect(res.status).toBe(204);
		expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
		expect(res.headers.get("Access-Control-Allow-Headers")).toContain(
			"Authorization",
		);
		// No Origin reaches the handler here (the harness normalises it away), so
		// this asserts the wildcard fallback rather than the echo.
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});
});
