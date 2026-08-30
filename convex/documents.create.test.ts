import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules: Record<string, () => Promise<unknown>> = {
	"./schema.ts": () => import("./schema"),
	"./documents.ts": () => import("./documents"),
	"./docNodes.ts": () => import("./docNodes"),
	"./_generated/api.js": () => import("./_generated/api"),
	"./_generated/server.js": () => import("./_generated/server"),
};

const OWNER = { subject: "owner-user", email: "owner@example.com" };
const OTHER = { subject: "other-user", email: "other@example.com" };

describe("documents.create with a client documentUuid", () => {
	it("still creates a fresh document every call when no uuid is given", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const first = await owner.mutation(api.documents.create, {});
		const second = await owner.mutation(api.documents.create, {});

		expect(first.documentId).not.toBe(second.documentId);
		expect(first.created).toBe(true);
		expect(second.created).toBe(true);
	});

	it("returns the same document (and root node) for a replayed uuid", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const first = await owner.mutation(api.documents.create, {
			title: "Offline draft",
			documentUuid: "01JCLIENTULID",
		});
		const replay = await owner.mutation(api.documents.create, {
			title: "Offline draft",
			documentUuid: "01JCLIENTULID",
		});

		expect(replay.documentId).toBe(first.documentId);
		expect(replay.rootNodeId).toBe(first.rootNodeId);
		expect(replay.created).toBe(false);
		const [listed] = await owner.query(api.documents.list, {});
		expect(listed).toMatchObject({
			_id: first.documentId,
			documentUuid: "01JCLIENTULID",
		});
	});

	it("does not adopt the title of a replay — the first call's document is returned as-is", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		await owner.mutation(api.documents.create, {
			title: "First",
			documentUuid: "uuid-1",
		});
		await owner.mutation(api.documents.create, {
			title: "Second",
			documentUuid: "uuid-1",
		});

		const [doc] = await owner.query(api.documents.list, {});
		expect(doc?.title).toBe("First");
	});

	it("scopes the uuid per user", async () => {
		const t = convexTest(schema, modules);
		const mine = await t
			.withIdentity(OWNER)
			.mutation(api.documents.create, { documentUuid: "collision" });
		const theirs = await t
			.withIdentity(OTHER)
			.mutation(api.documents.create, { documentUuid: "collision" });

		expect(theirs.documentId).not.toBe(mine.documentId);
		expect(theirs.created).toBe(true);
	});

	it("rejects an empty or over-long documentUuid", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		// v.string() accepts both; only the handler's check stops them.
		await expect(
			owner.mutation(api.documents.create, { documentUuid: "" }),
		).rejects.toThrow("Invalid documentUuid");
		await expect(
			owner.mutation(api.documents.create, { documentUuid: "u".repeat(65) }),
		).rejects.toThrow("Invalid documentUuid");
	});

	it("returns a root node that actually exists in the history", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const { documentId, rootNodeId } = await owner.mutation(
			api.documents.create,
			{ documentUuid: "uuid-root" },
		);
		const replay = await owner.mutation(api.documents.create, {
			documentUuid: "uuid-root",
		});

		const nodes = await owner.query(api.docNodes.listSince, {
			documentId,
		});
		expect(nodes.map((node) => node.nodeId)).toContain(replay.rootNodeId);
		expect(replay.rootNodeId).toBe(rootNodeId);
	});
});
