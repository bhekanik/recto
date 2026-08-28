import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import { MARKDOWN_TOO_LARGE_MESSAGE, MAX_MARKDOWN_LENGTH } from "./documents";
import schema from "./schema";

// Explicit module map for convex-test (mirrors convex/writingStats.test.ts).
// Keys must include a "_generated" path so convex-test can locate the
// function-bundle root (it splits a key on "_generated").
const modules: Record<string, () => Promise<unknown>> = {
	"./schema.ts": () => import("./schema"),
	"./documents.ts": () => import("./documents"),
	"./docNodes.ts": () => import("./docNodes"),
	"./_generated/api.js": () => import("./_generated/api"),
	"./_generated/server.js": () => import("./_generated/server"),
};

const OWNER = { subject: "owner-user", email: "owner@example.com" };
const OTHER = { subject: "other-user", email: "other@example.com" };

/** A docNodes payload replacing the whole document with `markdown`. */
function nodeFor(
	nodeId: string,
	parentNodeId: string,
	previous: string,
	markdown: string,
) {
	return {
		nodeId,
		parentNodeId,
		patch: JSON.stringify({ from: 0, to: previous.length, insert: markdown }),
		selection: null,
		origin: "test-device",
		createdAt: Date.now(),
	};
}

async function newDocument(t: ReturnType<typeof convexTest>) {
	const owner = t.withIdentity(OWNER);
	const { documentId, rootNodeId } = await owner.mutation(
		api.documents.create,
		{ title: "Draft" },
	);
	return { owner, documentId, rootNodeId };
}

describe("documents.commitEdit", () => {
	it("moves the node, the pointer and the markdown in one transaction", async () => {
		const t = convexTest(schema, modules);
		const { owner, documentId, rootNodeId } = await newDocument(t);

		const result = await owner.mutation(api.documents.commitEdit, {
			documentId,
			node: nodeFor("node-1", rootNodeId, "", "hello world"),
			markdown: "hello world",
			wordCount: 2,
			expectedHeadNodeId: rootNodeId,
			clientMutationId: "commit-1",
		});

		expect(result).toMatchObject({ committed: true, headNodeId: "node-1" });

		const doc = await owner.query(api.documents.get, { documentId });
		expect(doc).toMatchObject({
			currentNodeId: "node-1",
			markdown: "hello world",
			wordCount: 2,
		});
		expect(doc?.updatedAt).toBe(
			result.committed ? result.updatedAt : undefined,
		);

		const nodes = await owner.query(api.docNodes.listSince, { documentId });
		expect(nodes.map((n) => n.nodeId).sort()).toEqual(
			[rootNodeId, "node-1"].sort(),
		);
	});

	it("chains commits off the head it just wrote", async () => {
		const t = convexTest(schema, modules);
		const { owner, documentId, rootNodeId } = await newDocument(t);

		await owner.mutation(api.documents.commitEdit, {
			documentId,
			node: nodeFor("node-1", rootNodeId, "", "one"),
			markdown: "one",
			wordCount: 1,
			expectedHeadNodeId: rootNodeId,
			clientMutationId: "commit-1",
		});
		const second = await owner.mutation(api.documents.commitEdit, {
			documentId,
			node: nodeFor("node-2", "node-1", "one", "one two"),
			markdown: "one two",
			wordCount: 2,
			expectedHeadNodeId: "node-1",
			clientMutationId: "commit-2",
		});

		expect(second).toMatchObject({ committed: true, headNodeId: "node-2" });
		expect(
			(await owner.query(api.documents.get, { documentId }))?.markdown,
		).toBe("one two");
	});

	it("reports divergence without touching the document, but keeps the node", async () => {
		const t = convexTest(schema, modules);
		const { owner, documentId, rootNodeId } = await newDocument(t);

		await owner.mutation(api.documents.commitEdit, {
			documentId,
			node: nodeFor("node-1", rootNodeId, "", "from device A"),
			markdown: "from device A",
			wordCount: 3,
			expectedHeadNodeId: rootNodeId,
			clientMutationId: "commit-a",
		});

		// Device B was offline and still believes the root is the head.
		const diverged = await owner.mutation(api.documents.commitEdit, {
			documentId,
			node: nodeFor("node-b", rootNodeId, "", "from device B"),
			markdown: "from device B",
			wordCount: 3,
			expectedHeadNodeId: rootNodeId,
			clientMutationId: "commit-b",
		});

		expect(diverged).toEqual({
			committed: false,
			diverged: true,
			remoteHeadNodeId: "node-1",
			// The caller queues the winning head by revision, not by timestamp.
			remotePointerRevision: 1,
		});

		const doc = await owner.query(api.documents.get, { documentId });
		expect(doc).toMatchObject({
			currentNodeId: "node-1",
			markdown: "from device A",
		});

		// The branch is preserved — the writer's text is reachable in the tree.
		const nodes = await owner.query(api.docNodes.listSince, { documentId });
		expect(nodes.map((n) => n.nodeId)).toContain("node-b");
	});

	it("replays a retried clientMutationId instead of re-committing", async () => {
		const t = convexTest(schema, modules);
		const { owner, documentId, rootNodeId } = await newDocument(t);

		const args = {
			documentId,
			node: nodeFor("node-1", rootNodeId, "", "only once"),
			markdown: "only once",
			wordCount: 2,
			expectedHeadNodeId: rootNodeId,
			clientMutationId: "outbox-1",
		};
		const first = await owner.mutation(api.documents.commitEdit, args);
		const retry = await owner.mutation(api.documents.commitEdit, args);

		expect(retry).toEqual(first);
		const nodes = await owner.query(api.docNodes.listSince, { documentId });
		expect(nodes.filter((n) => n.nodeId === "node-1")).toHaveLength(1);
	});

	it("treats a commit whose node is already the head as a success, not a divergence", async () => {
		const t = convexTest(schema, modules);
		const { owner, documentId, rootNodeId } = await newDocument(t);

		await owner.mutation(api.documents.commitEdit, {
			documentId,
			node: nodeFor("node-1", rootNodeId, "", "landed"),
			markdown: "landed",
			wordCount: 1,
			expectedHeadNodeId: rootNodeId,
			clientMutationId: "attempt-1",
		});

		// The outbox never saw the ack and retries under a fresh attempt id.
		const retry = await owner.mutation(api.documents.commitEdit, {
			documentId,
			node: nodeFor("node-1", rootNodeId, "", "landed"),
			markdown: "landed",
			wordCount: 1,
			expectedHeadNodeId: rootNodeId,
			clientMutationId: "attempt-2",
		});

		expect(retry).toMatchObject({ committed: true, headNodeId: "node-1" });
	});

	it("rejects markdown past the ~1 MiB ceiling", async () => {
		const t = convexTest(schema, modules);
		const { owner, documentId, rootNodeId } = await newDocument(t);

		const huge = "x".repeat(MAX_MARKDOWN_LENGTH + 1);
		await expect(
			owner.mutation(api.documents.commitEdit, {
				documentId,
				node: nodeFor("node-1", rootNodeId, "", huge),
				markdown: huge,
				wordCount: 1,
				expectedHeadNodeId: rootNodeId,
				clientMutationId: "too-big",
			}),
		).rejects.toThrow(MARKDOWN_TOO_LARGE_MESSAGE);

		const nodes = await owner.query(api.docNodes.listSince, { documentId });
		expect(nodes.map((n) => n.nodeId)).toEqual([rootNodeId]);
	});

	it("measures the size ceiling in bytes, not characters", async () => {
		const t = convexTest(schema, modules);
		const { owner, documentId, rootNodeId } = await newDocument(t);

		// 400k characters, 1.2 MB encoded: under any `.length` check and well over
		// the real Convex limit.
		const multibyte = "漢".repeat(400_000);
		expect(multibyte.length).toBeLessThan(MAX_MARKDOWN_LENGTH);

		await expect(
			owner.mutation(api.documents.commitEdit, {
				documentId,
				node: nodeFor("node-1", rootNodeId, "", multibyte),
				markdown: multibyte,
				wordCount: 1,
				expectedHeadNodeId: rootNodeId,
				clientMutationId: "multibyte",
			}),
		).rejects.toThrow(MARKDOWN_TOO_LARGE_MESSAGE);

		const nodes = await owner.query(api.docNodes.listSince, { documentId });
		expect(nodes.map((n) => n.nodeId)).toEqual([rootNodeId]);
	});

	it("counts patch and snapshot together against the node row ceiling", async () => {
		const t = convexTest(schema, modules);
		const { owner, documentId, rootNodeId } = await newDocument(t);

		// Neither half trips the limit alone; the row Convex stores does.
		const half = "x".repeat(600_000);
		await expect(
			owner.mutation(api.documents.commitEdit, {
				documentId,
				node: {
					nodeId: "node-1",
					parentNodeId: rootNodeId,
					patch: JSON.stringify({ from: 0, to: 0, insert: half }),
					snapshot: half,
					selection: null,
					origin: "test-device",
					createdAt: Date.now(),
				},
				markdown: half,
				wordCount: 1,
				expectedHeadNodeId: rootNodeId,
				clientMutationId: "fat-row",
			}),
		).rejects.toThrow(MARKDOWN_TOO_LARGE_MESSAGE);
	});

	it("works on a row written before pointerRevision and markdownHeadNodeId existed", async () => {
		const t = convexTest(schema, modules);
		const rootNodeId = "legacy-root";

		// Insert the row the way the old code did: neither field present at all.
		// Injecting them as 0/undefined would test the fixture, not the migration.
		const documentId = await t.run(async (ctx) => {
			const id = await ctx.db.insert("documents", {
				userId: OWNER.subject,
				title: "Legacy",
				markdown: "legacy body",
				wordCount: 2,
				currentNodeId: rootNodeId,
				createdAt: 1,
				updatedAt: 1,
			});
			await ctx.db.insert("docNodes", {
				documentId: id,
				nodeId: rootNodeId,
				parentNodeId: null,
				patch: JSON.stringify({ from: 0, to: 0, insert: "" }),
				snapshot: "legacy body",
				selection: null,
				origin: "server",
				createdAt: 1,
			});
			return id;
		});

		const owner = t.withIdentity(OWNER);
		const before = await owner.query(api.documents.get, { documentId });
		// The client is handed a usable number and an explicit "unknown".
		expect(before?.pointerRevision).toBe(0);
		expect(before?.markdownHeadNodeId).toBeUndefined();

		const result = await owner.mutation(api.documents.commitEdit, {
			documentId,
			node: nodeFor("node-1", rootNodeId, "legacy body", "legacy body edited"),
			markdown: "legacy body edited",
			wordCount: 3,
			expectedHeadNodeId: rootNodeId,
			clientMutationId: "legacy-1",
		});

		expect(result).toMatchObject({ committed: true, pointerRevision: 1 });
		const after = await owner.query(api.documents.get, { documentId });
		expect(after?.markdownHeadNodeId).toBe("node-1");
	});

	it("clears markdown provenance when a legacy client saves without a head", async () => {
		const t = convexTest(schema, modules);
		const { owner, documentId, rootNodeId } = await newDocument(t);

		const committed = await owner.mutation(api.documents.commitEdit, {
			documentId,
			node: nodeFor("node-1", rootNodeId, "", "committed"),
			markdown: "committed",
			wordCount: 1,
			expectedHeadNodeId: rootNodeId,
			clientMutationId: "a-1",
		});
		expect(
			(await owner.query(api.documents.get, { documentId }))
				?.markdownHeadNodeId,
		).toBe("node-1");

		// A tab loaded before the deploy sends no head. Its text may belong to a
		// branch nobody can identify, so the stamp must not survive it — a stale
		// stamp would let another device promote that text into the wrong branch.
		await owner.mutation(api.documents.updateMarkdown, {
			documentId,
			markdown: "saved by an old tab",
			wordCount: 4,
			expectedUpdatedAt: committed.committed ? committed.updatedAt : 0,
		});

		const after = await owner.query(api.documents.get, { documentId });
		expect(after?.markdown).toBe("saved by an old tab");
		expect(after?.markdownHeadNodeId).toBeUndefined();
	});

	it("stamps provenance when the caller passes the head", async () => {
		const t = convexTest(schema, modules);
		const { owner, documentId, rootNodeId } = await newDocument(t);

		const committed = await owner.mutation(api.documents.commitEdit, {
			documentId,
			node: nodeFor("node-1", rootNodeId, "", "committed"),
			markdown: "committed",
			wordCount: 1,
			expectedHeadNodeId: rootNodeId,
			clientMutationId: "a-1",
		});
		await owner.mutation(api.documents.updateMarkdown, {
			documentId,
			markdown: "committed and then some",
			wordCount: 4,
			expectedUpdatedAt: committed.committed ? committed.updatedAt : 0,
			expectedHeadNodeId: "node-1",
		});

		const after = await owner.query(api.documents.get, { documentId });
		expect(after?.markdownHeadNodeId).toBe("node-1");
	});

	it("rejects empty ids, keys and patches", async () => {
		const t = convexTest(schema, modules);
		const { owner, documentId, rootNodeId } = await newDocument(t);
		const ok = nodeFor("node-1", rootNodeId, "", "body");
		const base = {
			documentId,
			markdown: "body",
			wordCount: 1,
			expectedHeadNodeId: rootNodeId,
			clientMutationId: "m-1",
		};

		// v.string() accepts "", so without this an empty node id lands in the DAG
		// and the document head can be pointed at nothing.
		await expect(
			owner.mutation(api.documents.commitEdit, {
				...base,
				node: { ...ok, nodeId: "" },
			}),
		).rejects.toThrow("Invalid node.nodeId");

		await expect(
			owner.mutation(api.documents.commitEdit, {
				...base,
				node: ok,
				expectedHeadNodeId: "",
			}),
		).rejects.toThrow("Invalid expectedHeadNodeId");

		await expect(
			owner.mutation(api.documents.commitEdit, {
				...base,
				node: ok,
				clientMutationId: "",
			}),
		).rejects.toThrow("Invalid clientMutationId");

		// An empty patch cannot be applied, so it breaks every materialization
		// that walks through the node.
		await expect(
			owner.mutation(api.documents.commitEdit, {
				...base,
				node: { ...ok, patch: "" },
			}),
		).rejects.toThrow("Invalid node.patch");

		const nodes = await owner.query(api.docNodes.listSince, { documentId });
		expect(nodes.map((n) => n.nodeId)).toEqual([rootNodeId]);
	});

	it("refuses a node whose parent is not the head the caller named", async () => {
		const t = convexTest(schema, modules);
		const { owner, documentId, rootNodeId } = await newDocument(t);

		await expect(
			owner.mutation(api.documents.commitEdit, {
				documentId,
				node: nodeFor("node-1", "somewhere-else", "", "hello"),
				markdown: "hello",
				wordCount: 1,
				expectedHeadNodeId: rootNodeId,
				clientMutationId: "commit-1",
			}),
		).rejects.toThrow(/parentNodeId must equal expectedHeadNodeId/);

		const nodes = await owner.query(api.docNodes.listSince, { documentId });
		expect(nodes.map((n) => n.nodeId)).toEqual([rootNodeId]);
	});

	it("replays an already-head commit whose answer was lost, even after the head moved on", async () => {
		const t = convexTest(schema, modules);
		const { owner, documentId, rootNodeId } = await newDocument(t);

		const commit = {
			documentId,
			node: nodeFor("node-1", rootNodeId, "", "one"),
			markdown: "one",
			wordCount: 1,
			expectedHeadNodeId: rootNodeId,
		};
		await owner.mutation(api.documents.commitEdit, {
			...commit,
			clientMutationId: "commit-1",
		});
		// A second attempt with a FRESH id lands while node-1 is already the head
		// (the first answer was lost); its answer is lost too.
		const retried = await owner.mutation(api.documents.commitEdit, {
			...commit,
			clientMutationId: "commit-1-retry",
		});
		expect(retried).toMatchObject({ committed: true, headNodeId: "node-1" });

		// Another client moves the pointer (an undo) before the retry is
		// replayed. A pointer move does not touch lastCommit, so the retry must
		// replay the recorded success instead of reading the moved head as a
		// divergence.
		await owner.mutation(api.documents.updateCurrentNodeId, {
			documentId,
			currentNodeId: rootNodeId,
			markdown: "",
			wordCount: 0,
			updatedAt: Date.now() + 1,
		});

		const replayed = await owner.mutation(api.documents.commitEdit, {
			...commit,
			clientMutationId: "commit-1-retry",
		});
		expect(replayed).toMatchObject({ committed: true, headNodeId: "node-1" });
		// The replay answers; it does not re-move the pointer.
		expect(
			(await owner.query(api.documents.get, { documentId }))?.currentNodeId,
		).toBe(rootNodeId);
	});

	it("moves the pointer by revision compare-and-set, ignoring a slow client clock", async () => {
		const t = convexTest(schema, modules);
		const { owner, documentId, rootNodeId } = await newDocument(t);

		const committed = await owner.mutation(api.documents.commitEdit, {
			documentId,
			node: nodeFor("node-1", rootNodeId, "", "one"),
			markdown: "one",
			wordCount: 1,
			expectedHeadNodeId: rootNodeId,
			clientMutationId: "commit-1",
		});
		if (!committed.committed) throw new Error("commit failed");

		// A client whose clock is behind the server would lose the wall-clock
		// rule; the revision CAS makes the move land anyway.
		const moved = await owner.mutation(api.documents.updateCurrentNodeId, {
			documentId,
			currentNodeId: rootNodeId,
			markdown: "",
			wordCount: 0,
			updatedAt: committed.updatedAt - 60_000,
			expectedPointerRevision: committed.pointerRevision,
		});
		expect(moved).toMatchObject({
			applied: true,
			currentNodeId: rootNodeId,
			pointerRevision: committed.pointerRevision + 1,
		});
	});

	it("rejects a pointer move whose expected revision is stale", async () => {
		const t = convexTest(schema, modules);
		const { owner, documentId, rootNodeId } = await newDocument(t);

		const committed = await owner.mutation(api.documents.commitEdit, {
			documentId,
			node: nodeFor("node-1", rootNodeId, "", "one"),
			markdown: "one",
			wordCount: 1,
			expectedHeadNodeId: rootNodeId,
			clientMutationId: "commit-1",
		});
		if (!committed.committed) throw new Error("commit failed");

		const stale = await owner.mutation(api.documents.updateCurrentNodeId, {
			documentId,
			currentNodeId: rootNodeId,
			markdown: "",
			wordCount: 0,
			updatedAt: Date.now() + 60_000,
			expectedPointerRevision: committed.pointerRevision - 1,
		});
		expect(stale).toMatchObject({
			applied: false,
			currentNodeId: "node-1",
			pointerRevision: committed.pointerRevision,
		});
		expect(
			(await owner.query(api.documents.get, { documentId }))?.currentNodeId,
		).toBe("node-1");
	});

	it("refuses to point the head at a node that does not exist", async () => {
		const t = convexTest(schema, modules);
		const { owner, documentId, rootNodeId } = await newDocument(t);

		await expect(
			owner.mutation(api.documents.updateCurrentNodeId, {
				documentId,
				currentNodeId: "",
				markdown: "",
				wordCount: 0,
				updatedAt: Date.now(),
			}),
		).rejects.toThrow("Invalid currentNodeId");

		await expect(
			owner.mutation(api.documents.updateCurrentNodeId, {
				documentId,
				currentNodeId: "never-created",
				markdown: "whatever",
				wordCount: 1,
				updatedAt: Date.now(),
			}),
		).rejects.toThrow("Unknown currentNodeId");

		// The head is untouched by either attempt.
		expect(
			(await owner.query(api.documents.get, { documentId }))?.currentNodeId,
		).toBe(rootNodeId);
	});

	it("refuses a commit on someone else's document", async () => {
		const t = convexTest(schema, modules);
		const { documentId, rootNodeId } = await newDocument(t);

		await expect(
			t.withIdentity(OTHER).mutation(api.documents.commitEdit, {
				documentId,
				node: nodeFor("node-1", rootNodeId, "", "not yours"),
				markdown: "not yours",
				wordCount: 2,
				expectedHeadNodeId: rootNodeId,
				clientMutationId: "intruder",
			}),
		).rejects.toThrow("Document not found");
	});
});

describe("documents.updateMarkdown head guard", () => {
	it("refuses a draft written against a head another device moved on from", async () => {
		const t = convexTest(schema, modules);
		const { owner, documentId, rootNodeId } = await newDocument(t);

		// Device A commits and takes the head.
		await owner.mutation(api.documents.commitEdit, {
			documentId,
			node: nodeFor("node-a", rootNodeId, "", "device A text"),
			markdown: "device A text",
			wordCount: 3,
			expectedHeadNodeId: rootNodeId,
			clientMutationId: "a-1",
		});

		// Device B was offline; its debounced autosave still believes the root is
		// the head. Without the guard its stale->retry loop would republish this
		// draft on top of A's branch, leaving documents.markdown detached from
		// documents.currentNodeId.
		const refused = await owner.mutation(api.documents.updateMarkdown, {
			documentId,
			markdown: "device B draft",
			wordCount: 3,
			expectedUpdatedAt: 0,
			expectedHeadNodeId: rootNodeId,
		});

		expect(refused).toMatchObject({ stale: true, headMoved: true });

		const doc = await owner.query(api.documents.get, { documentId });
		expect(doc).toMatchObject({
			currentNodeId: "node-a",
			markdown: "device A text",
		});
	});

	it("writes when the head is the one the caller expected", async () => {
		const t = convexTest(schema, modules);
		const { owner, documentId, rootNodeId } = await newDocument(t);

		const committed = await owner.mutation(api.documents.commitEdit, {
			documentId,
			node: nodeFor("node-a", rootNodeId, "", "committed"),
			markdown: "committed",
			wordCount: 1,
			expectedHeadNodeId: rootNodeId,
			clientMutationId: "a-1",
		});

		const saved = await owner.mutation(api.documents.updateMarkdown, {
			documentId,
			markdown: "committed and then some",
			wordCount: 4,
			expectedUpdatedAt: committed.committed ? committed.updatedAt : 0,
			expectedHeadNodeId: "node-a",
		});

		expect(saved).toMatchObject({ stale: false, headMoved: false });
		expect(
			(await owner.query(api.documents.get, { documentId }))?.markdown,
		).toBe("committed and then some");
	});

	it("stays backwards compatible when the caller sends no head", async () => {
		const t = convexTest(schema, modules);
		const { owner, documentId, rootNodeId } = await newDocument(t);

		await owner.mutation(api.documents.commitEdit, {
			documentId,
			node: nodeFor("node-a", rootNodeId, "", "committed"),
			markdown: "committed",
			wordCount: 1,
			expectedHeadNodeId: rootNodeId,
			clientMutationId: "a-1",
		});

		// The client deployed before this change omits expectedHeadNodeId; it must
		// keep saving through the ordinary stale/retry path.
		const doc = await owner.query(api.documents.get, { documentId });
		const saved = await owner.mutation(api.documents.updateMarkdown, {
			documentId,
			markdown: "old client text",
			wordCount: 3,
			expectedUpdatedAt: doc?.updatedAt ?? 0,
		});

		expect(saved).toMatchObject({ stale: false, headMoved: false });
	});
});
