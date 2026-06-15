import { describe, expect, it } from "bun:test";
import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema.ts";
import { computePatch, encodePatch } from "../src/patch.ts";

const modules: Record<string, () => Promise<unknown>> = {
	"../convex/schema.ts": () => import("../convex/schema.ts"),
	"../convex/documents.ts": () => import("../convex/documents.ts"),
	"../convex/docNodes.ts": () => import("../convex/docNodes.ts"),
	"../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
	"../convex/_generated/server.js": () =>
		import("../convex/_generated/server.js"),
};

describe("Spike B — cloud undo-tree DAG", () => {
	it("append-only: nodes are never mutated", async () => {
		const t = convexTest(schema, modules);
		const { documentId, rootNodeId } = await t.mutation(
			api.documents.createDocument,
			{
				markdown: "start",
			},
		);

		const n1 = crypto.randomUUID();
		await t.mutation(api.docNodes.append, {
			documentId,
			nodeId: n1,
			parentNodeId: rootNodeId,
			patch: encodePatch(computePatch("start", "start edited")),
			selection: null,
			origin: "client-a",
			createdAt: Date.now(),
		});

		const dup = await t.mutation(api.docNodes.append, {
			documentId,
			nodeId: n1,
			parentNodeId: rootNodeId,
			patch: encodePatch(computePatch("start", "start edited")),
			selection: null,
			origin: "client-a",
			createdAt: Date.now(),
		});
		expect(dup.duplicate).toBe(true);

		const nodes = await t.query(api.docNodes.listByDocument, { documentId });
		expect(nodes.filter((n) => n.nodeId === n1)).toHaveLength(1);
	});

	it("two clients diverge: union-merge with both branches", async () => {
		const t = convexTest(schema, modules);
		const { documentId, rootNodeId } = await t.mutation(
			api.documents.createDocument,
			{
				markdown: "",
			},
		);

		const n1 = crypto.randomUUID();
		const n2 = crypto.randomUUID();
		const base = "shared base";
		await t.mutation(api.docNodes.append, {
			documentId,
			nodeId: n1,
			parentNodeId: rootNodeId,
			patch: encodePatch(computePatch("", base)),
			snapshot: base,
			selection: null,
			origin: "shared",
			createdAt: 1000,
		});
		await t.mutation(api.docNodes.append, {
			documentId,
			nodeId: n2,
			parentNodeId: n1,
			patch: encodePatch(computePatch(base, `${base} at n2`)),
			snapshot: `${base} at n2`,
			selection: null,
			origin: "shared",
			createdAt: 2000,
		});

		const a3 = crypto.randomUUID();
		const a4 = crypto.randomUUID();
		const n2Text = `${base} at n2`;
		await t.mutation(api.docNodes.append, {
			documentId,
			nodeId: a3,
			parentNodeId: n2,
			patch: encodePatch(computePatch(n2Text, `${n2Text} branch A step 1`)),
			selection: null,
			origin: "client-a",
			createdAt: 3000,
		});
		await t.mutation(api.docNodes.append, {
			documentId,
			nodeId: a4,
			parentNodeId: a3,
			patch: encodePatch(
				computePatch(
					`${n2Text} branch A step 1`,
					`${n2Text} branch A step 1 final`,
				),
			),
			selection: null,
			origin: "client-a",
			createdAt: 4000,
		});

		const b3 = crypto.randomUUID();
		await t.mutation(api.docNodes.append, {
			documentId,
			nodeId: b3,
			parentNodeId: n2,
			patch: encodePatch(computePatch(n2Text, `${n2Text} branch B`)),
			selection: null,
			origin: "client-b",
			createdAt: 3500,
		});

		const nodes = await t.query(api.docNodes.listByDocument, { documentId });
		const ids = new Set(nodes.map((n) => n.nodeId));
		expect(ids.has(a3)).toBe(true);
		expect(ids.has(a4)).toBe(true);
		expect(ids.has(b3)).toBe(true);
		expect(nodes).toHaveLength(6);

		const matA = await t.query(api.docNodes.materializeAt, {
			documentId,
			nodeId: a4,
		});
		const matB = await t.query(api.docNodes.materializeAt, {
			documentId,
			nodeId: b3,
		});
		expect(matA.markdown).toBe(`${n2Text} branch A step 1 final`);
		expect(matB.markdown).toBe(`${n2Text} branch B`);
	});

	it("currentNodeId is LWW by updatedAt and converges", async () => {
		const t = convexTest(schema, modules);
		const { documentId } = await t.mutation(api.documents.createDocument, {});

		const doc0 = await t.run(async (ctx) => ctx.db.get(documentId));
		const t0 = doc0?.updatedAt ?? 0;

		const r1 = await t.mutation(api.documents.updateCurrentNodeId, {
			documentId,
			currentNodeId: "node-a",
			updatedAt: t0 + 1000,
		});
		expect(r1.applied).toBe(true);

		const r2 = await t.mutation(api.documents.updateCurrentNodeId, {
			documentId,
			currentNodeId: "node-b",
			updatedAt: t0 + 2000,
		});
		expect(r2.applied).toBe(true);

		const r3 = await t.mutation(api.documents.updateCurrentNodeId, {
			documentId,
			currentNodeId: "node-a",
			updatedAt: t0 + 1500,
		});
		expect(r3.applied).toBe(false);
		expect(r3.currentNodeId).toBe("node-b");

		const doc = await t.run(async (ctx) => ctx.db.get(documentId));
		expect(doc?.currentNodeId).toBe("node-b");
	});

	it("stub restore forks forward — pre-restore branch remains", async () => {
		const t = convexTest(schema, modules);
		const { documentId, rootNodeId } = await t.mutation(
			api.documents.createDocument,
			{
				markdown: "v1",
			},
		);

		const n1 = crypto.randomUUID();
		await t.mutation(api.docNodes.append, {
			documentId,
			nodeId: n1,
			parentNodeId: rootNodeId,
			patch: encodePatch(computePatch("v1", "v2")),
			snapshot: "v2",
			selection: null,
			origin: "a",
			createdAt: 1000,
		});

		await t.mutation(api.documents.updateCurrentNodeId, {
			documentId,
			currentNodeId: n1,
			updatedAt: 2000,
		});

		const { newNodeId } = await t.mutation(api.docNodes.restoreForkForward, {
			documentId,
			sourceNodeId: rootNodeId,
			origin: "restore",
		});

		const nodes = await t.query(api.docNodes.listByDocument, { documentId });
		expect(nodes.some((n) => n.nodeId === n1)).toBe(true);
		expect(nodes.some((n) => n.nodeId === newNodeId)).toBe(true);

		const doc = await t.run(async (ctx) => ctx.db.get(documentId));
		expect(doc?.currentNodeId).toBe(newNodeId);

		const restored = await t.query(api.docNodes.materializeAt, {
			documentId,
			nodeId: newNodeId,
		});
		expect(restored.markdown).toBe("v1");
	});
});
