import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import schema from "@/convex/schema";
import { diffRuns } from "@/lib/history/diff";

// Explicit module map for convex-test. Keys must include a "_generated" path so
// convex-test can locate the function-bundle root (it splits a key on
// "_generated"). Mirrors spikes/undo-tree/tests/convex.bun.test.ts; import.meta.glob
// is avoided here because the root tsconfig has no vite/client types.
const modules: Record<string, () => Promise<unknown>> = {
	"../../convex/schema.ts": () => import("@/convex/schema"),
	"../../convex/documents.ts": () => import("@/convex/documents"),
	"../../convex/docNodes.ts": () => import("@/convex/docNodes"),
	"../../convex/versions.ts": () => import("@/convex/versions"),
	"../../convex/history.ts": () => import("@/convex/history"),
	"../../convex/review.ts": () => import("@/convex/review"),
	"../../convex/_generated/api.js": () => import("@/convex/_generated/api"),
	"../../convex/_generated/server.js": () =>
		import("@/convex/_generated/server"),
};

const OWNER = { subject: "owner-user", email: "owner@example.com" };
const REVIEWER = { subject: "reviewer-user", email: "reviewer@example.com" };
const COMMENTER = { subject: "commenter-user", email: "commenter@example.com" };

/** Build a contiguous full-replace patch (matches the spike/restore shape). */
function fullReplacePatch(from: string, to: string): string {
	return JSON.stringify({ from: 0, to: from.length, insert: to });
}

describe("plan 010 SPIKE — reviewer-branch isolation + accept/reject", () => {
	it("Step 0: identity.email flows through ctx.auth.getUserIdentity()", async () => {
		const t = convexTest(schema, modules);
		// Inline query (no named function) — exercises the same identity path
		// requireDocumentAccess relies on, so invite-by-email can key on email.
		const who = await t.withIdentity(OWNER).query(async (ctx) => {
			const id = await ctx.auth.getUserIdentity();
			return id ? { subject: id.subject, email: id.email } : null;
		});
		expect(who).not.toBeNull();
		expect(who?.email).toBe("owner@example.com");
		expect(typeof who?.email).toBe("string");
		expect((who?.email ?? "").length).toBeGreaterThan(0);
	});

	it("isolates reviewer suggestions from the owner document, accepts additively, rejects as a no-op", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const reviewer = t.withIdentity(REVIEWER);

		// 1. Owner creates a doc and types an edit (append node + advance pointer).
		const { documentId, rootNodeId } = await owner.mutation(
			api.documents.create,
			{ title: "Draft" },
		);

		// updateCurrentNodeId is LWW-guarded by updatedAt, so the pointer write must
		// carry a timestamp >= the doc's creation updatedAt.
		const created = await t.run(async (ctx) => ctx.db.get(documentId));
		const baseTime = (created?.updatedAt ?? Date.now()) + 1000;

		const ownerNodeId = crypto.randomUUID();
		const ownerText = "The owner wrote this sentence.";
		await owner.mutation(api.docNodes.append, {
			documentId,
			nodeId: ownerNodeId,
			parentNodeId: rootNodeId,
			patch: fullReplacePatch("", ownerText),
			snapshot: ownerText,
			selection: null,
			origin: "device-owner",
			createdAt: baseTime,
		});
		await owner.mutation(api.documents.updateCurrentNodeId, {
			documentId,
			currentNodeId: ownerNodeId,
			markdown: ownerText,
			wordCount: 5,
			updatedAt: baseTime,
		});

		const doc0 = await t.run(async (ctx) => ctx.db.get(documentId));
		const ownerMarkdown0 = doc0?.markdown ?? "";
		const ownerCurrentNodeId0 = doc0?.currentNodeId ?? "";
		const ownerUpdatedAt0 = doc0?.updatedAt ?? 0;
		expect(ownerMarkdown0).toBe(ownerText);
		expect(ownerCurrentNodeId0).toBe(ownerNodeId);

		// 2. Reviewer with no share is blocked.
		await expect(
			reviewer.mutation(api.review.reviewerAppend, {
				documentId,
				nodeId: crypto.randomUUID(),
				parentNodeId: ownerCurrentNodeId0,
				patch: fullReplacePatch(ownerText, `${ownerText} (suggested)`),
				selection: null,
				createdAt: 3000,
			}),
		).rejects.toThrow("Document not found");

		// 3. Grant suggester (direct db write — fine for the spike), then append 2 nodes.
		await t.run(async (ctx) => {
			await ctx.db.insert("documentShares", {
				documentId,
				ownerUserId: OWNER.subject,
				granteeEmail: REVIEWER.email,
				role: "suggester",
				createdAt: 100,
			});
		});

		const revNode1 = crypto.randomUUID();
		const revText1 = `${ownerText} It needs more detail.`;
		const r1 = await reviewer.mutation(api.review.reviewerAppend, {
			documentId,
			nodeId: revNode1,
			parentNodeId: ownerCurrentNodeId0,
			patch: fullReplacePatch(ownerText, revText1),
			snapshot: revText1,
			selection: null,
			createdAt: 3000,
		});
		const branchId = r1.branchId;

		const revNode2 = crypto.randomUUID();
		const revText2 = `${revText1} And a closing line.`;
		await reviewer.mutation(api.review.reviewerAppend, {
			documentId,
			branchId,
			nodeId: revNode2,
			parentNodeId: revNode1,
			patch: fullReplacePatch(revText1, revText2),
			snapshot: revText2,
			selection: null,
			createdAt: 4000,
		});

		// Each reviewer node carries origin `review:<reviewerSubject>`.
		const reviewerNodes = await t.run(async (ctx) => {
			const rows = await ctx.db
				.query("docNodes")
				.withIndex("by_document", (q) => q.eq("documentId", documentId))
				.collect();
			return rows.filter((n) => n.nodeId === revNode1 || n.nodeId === revNode2);
		});
		expect(reviewerNodes).toHaveLength(2);
		for (const n of reviewerNodes) {
			expect(n.origin).toBe(`review:${REVIEWER.subject}`);
		}

		// The reviewBranches row tracks the reviewer's own head.
		const branch = await t.run(async (ctx) =>
			ctx.db.get(branchId as Id<"reviewBranches">),
		);
		expect(branch?.status).toBe("open");
		expect(branch?.baseNodeId).toBe(ownerCurrentNodeId0);
		expect(branch?.headNodeId).toBe(revNode2);
		expect(branch?.reviewerUserId).toBe(REVIEWER.subject);

		// 4. LOAD-BEARING: owner document is byte-for-byte untouched.
		const doc1 = await t.run(async (ctx) => ctx.db.get(documentId));
		expect(doc1?.markdown).toBe(ownerMarkdown0);
		expect(doc1?.currentNodeId).toBe(ownerCurrentNodeId0);
		expect(doc1?.updatedAt).toBe(ownerUpdatedAt0);

		// 5. The diff is materializable and non-trivial.
		const diff = await owner.query(api.review.getBranchDiff, {
			documentId,
			branchId: branchId as Id<"reviewBranches">,
		});
		expect(diff.currentMarkdown).toBe(ownerMarkdown0);
		expect(diff.branchMarkdown).toBe(revText2);
		expect(diff.branchMarkdown).not.toBe(diff.currentMarkdown);
		const runs = diffRuns(diff.currentMarkdown, diff.branchMarkdown);
		expect(runs.some((r) => r.type === "add" || r.type === "del")).toBe(true);

		// 8 (early): reviewer cannot accept/reject.
		await expect(
			reviewer.mutation(api.review.acceptBranch, {
				documentId,
				branchId: branchId as Id<"reviewBranches">,
			}),
		).rejects.toThrow("Document not found");
		await expect(
			reviewer.mutation(api.review.rejectBranch, {
				documentId,
				branchId: branchId as Id<"reviewBranches">,
			}),
		).rejects.toThrow("Document not found");

		// 6. Accept is additive: new tip, merged markdown, OLD node survives.
		const accept = await owner.mutation(api.review.acceptBranch, {
			documentId,
			branchId: branchId as Id<"reviewBranches">,
		});
		const doc2 = await t.run(async (ctx) => ctx.db.get(documentId));
		expect(doc2?.currentNodeId).toBe(accept.newNodeId);
		expect(doc2?.currentNodeId).not.toBe(ownerCurrentNodeId0);
		expect(doc2?.markdown).toBe(revText2);

		const preAcceptNodeStillExists = await t.run(async (ctx) => {
			const rows = await ctx.db
				.query("docNodes")
				.withIndex("by_document", (q) => q.eq("documentId", documentId))
				.collect();
			return rows.some((n) => n.nodeId === ownerCurrentNodeId0);
		});
		expect(preAcceptNodeStillExists).toBe(true);

		const acceptedBranch = await t.run(async (ctx) =>
			ctx.db.get(branchId as Id<"reviewBranches">),
		);
		expect(acceptedBranch?.status).toBe("accepted");
		// The accepted-from node parents at the owner's pre-accept tip (additive).
		const newNode = await t.run(async (ctx) => {
			const rows = await ctx.db
				.query("docNodes")
				.withIndex("by_document", (q) => q.eq("documentId", documentId))
				.collect();
			return rows.find((n) => n.nodeId === accept.newNodeId);
		});
		expect(newNode?.parentNodeId).toBe(ownerCurrentNodeId0);
		expect(newNode?.origin).toBe("review-accept");

		// 7. Reject is a no-op on data: open a SECOND branch, reject it.
		const doc3Before = await t.run(async (ctx) => ctx.db.get(documentId));
		const nodeCountBefore = await t.run(async (ctx) => {
			const rows = await ctx.db
				.query("docNodes")
				.withIndex("by_document", (q) => q.eq("documentId", documentId))
				.collect();
			return rows.length;
		});

		const rev2Node1 = crypto.randomUUID();
		const baseForBranch2 = doc3Before?.markdown ?? "";
		const r2 = await reviewer.mutation(api.review.reviewerAppend, {
			documentId,
			nodeId: rev2Node1,
			parentNodeId: doc3Before?.currentNodeId ?? "",
			patch: fullReplacePatch(baseForBranch2, `${baseForBranch2} second pass.`),
			snapshot: `${baseForBranch2} second pass.`,
			selection: null,
			createdAt: 5000,
		});
		await owner.mutation(api.review.rejectBranch, {
			documentId,
			branchId: r2.branchId as Id<"reviewBranches">,
		});

		const rejectedBranch = await t.run(async (ctx) =>
			ctx.db.get(r2.branchId as Id<"reviewBranches">),
		);
		expect(rejectedBranch?.status).toBe("rejected");

		// No docNodes deleted by reject (only the second-branch append added one).
		const nodeCountAfter = await t.run(async (ctx) => {
			const rows = await ctx.db
				.query("docNodes")
				.withIndex("by_document", (q) => q.eq("documentId", documentId))
				.collect();
			return rows.length;
		});
		expect(nodeCountAfter).toBe(nodeCountBefore + 1);

		// Owner doc unchanged by the reject (still the accepted state).
		const doc3After = await t.run(async (ctx) => ctx.db.get(documentId));
		expect(doc3After?.markdown).toBe(doc3Before?.markdown);
		expect(doc3After?.currentNodeId).toBe(doc3Before?.currentNodeId);
	});

	it("a commenter cannot suggest (role below suggester)", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const commenter = t.withIdentity(COMMENTER);

		const { documentId, rootNodeId } = await owner.mutation(
			api.documents.create,
			{ title: "Draft" },
		);

		await t.run(async (ctx) => {
			await ctx.db.insert("documentShares", {
				documentId,
				ownerUserId: OWNER.subject,
				granteeEmail: COMMENTER.email,
				role: "commenter",
				createdAt: 100,
			});
		});

		await expect(
			commenter.mutation(api.review.reviewerAppend, {
				documentId,
				nodeId: crypto.randomUUID(),
				parentNodeId: rootNodeId,
				patch: fullReplacePatch("", "commenter tried to edit"),
				selection: null,
				createdAt: 3000,
			}),
		).rejects.toThrow("Document not found");
	});
});

describe("plan 010 PHASE A — sharing / ACL", () => {
	it("addShare lowercases + trims email, rejects empty and self, and upserts on duplicate", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const { documentId } = await owner.mutation(api.documents.create, {
			title: "Draft",
		});

		// Empty email rejected.
		await expect(
			owner.mutation(api.review.addShare, {
				documentId,
				email: "   ",
				role: "commenter",
			}),
		).rejects.toThrow();

		// Sharing with self rejected.
		await expect(
			owner.mutation(api.review.addShare, {
				documentId,
				email: OWNER.email.toUpperCase(),
				role: "commenter",
			}),
		).rejects.toThrow();

		// Mixed-case / padded email is normalized.
		const first = await owner.mutation(api.review.addShare, {
			documentId,
			email: "  Reviewer@Example.COM ",
			role: "commenter",
		});
		expect(first.updated).toBe(false);

		const sharesAfterFirst = await owner.query(api.review.listShares, {
			documentId,
		});
		expect(sharesAfterFirst).toHaveLength(1);
		expect(sharesAfterFirst[0]?.granteeEmail).toBe("reviewer@example.com");
		expect(sharesAfterFirst[0]?.role).toBe("commenter");

		// Re-inviting the same email updates the role (no duplicate row).
		const second = await owner.mutation(api.review.addShare, {
			documentId,
			email: "reviewer@example.com",
			role: "suggester",
		});
		expect(second.updated).toBe(true);

		const sharesAfterUpsert = await owner.query(api.review.listShares, {
			documentId,
		});
		expect(sharesAfterUpsert).toHaveLength(1);
		expect(sharesAfterUpsert[0]?.role).toBe("suggester");
	});

	it("revokeShare removes only the targeted row and only for the owner", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const reviewer = t.withIdentity(REVIEWER);
		const { documentId } = await owner.mutation(api.documents.create, {
			title: "Draft",
		});

		await owner.mutation(api.review.addShare, {
			documentId,
			email: REVIEWER.email,
			role: "suggester",
		});
		await owner.mutation(api.review.addShare, {
			documentId,
			email: COMMENTER.email,
			role: "commenter",
		});

		const shares = await owner.query(api.review.listShares, { documentId });
		expect(shares).toHaveLength(2);
		const reviewerShare = shares.find((s) => s.granteeEmail === REVIEWER.email);
		expect(reviewerShare).toBeDefined();

		// A non-owner cannot revoke.
		await expect(
			reviewer.mutation(api.review.revokeShare, {
				shareId: reviewerShare?._id as Id<"documentShares">,
			}),
		).rejects.toThrow("Share not found");

		// Owner revokes the reviewer's share only.
		await owner.mutation(api.review.revokeShare, {
			shareId: reviewerShare?._id as Id<"documentShares">,
		});
		const remaining = await owner.query(api.review.listShares, { documentId });
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.granteeEmail).toBe(COMMENTER.email);
	});

	it("non-owners cannot addShare / listShares", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const reviewer = t.withIdentity(REVIEWER);
		const { documentId } = await owner.mutation(api.documents.create, {
			title: "Draft",
		});

		await expect(
			reviewer.mutation(api.review.addShare, {
				documentId,
				email: COMMENTER.email,
				role: "commenter",
			}),
		).rejects.toThrow("Document not found");

		await expect(
			reviewer.query(api.review.listShares, { documentId }),
		).rejects.toThrow("Document not found");
	});

	it("listSharedWithMe returns docs for both an email-only and a user-resolved grantee", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const reviewer = t.withIdentity(REVIEWER);
		const { documentId } = await owner.mutation(api.documents.create, {
			title: "Shared draft",
		});

		// Email-only invite (granteeUserId still unset).
		await owner.mutation(api.review.addShare, {
			documentId,
			email: REVIEWER.email,
			role: "suggester",
		});

		// Email-only path: the reviewer sees the doc even before any mutation binds
		// their user id.
		const emailOnly = await reviewer.query(api.review.listSharedWithMe, {});
		expect(emailOnly).toHaveLength(1);
		expect(emailOnly[0]?._id).toBe(documentId);
		expect(emailOnly[0]?.role).toBe("suggester");
		expect(emailOnly[0]?.shared).toBe(true);
		expect(emailOnly[0]?.ownerUserId).toBe(OWNER.subject);

		// A mutation resolves granteeUserId; the doc still appears (user-resolved).
		await reviewer.mutation(api.review.reviewerAppend, {
			documentId,
			nodeId: crypto.randomUUID(),
			parentNodeId: "missing-base", // materialize isn't exercised here
			patch: fullReplacePatch("", "a suggestion"),
			selection: null,
			createdAt: 9000,
		});
		const resolved = await reviewer.query(api.review.listSharedWithMe, {});
		expect(resolved).toHaveLength(1);
		expect(resolved[0]?._id).toBe(documentId);

		// The owner never sees their own doc in listSharedWithMe.
		const ownerView = await owner.query(api.review.listSharedWithMe, {});
		expect(ownerView).toHaveLength(0);
	});

	it("documentShareState reports shared for owner-with-shares and for a grantee", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const reviewer = t.withIdentity(REVIEWER);
		const stranger = t.withIdentity({
			subject: "stranger-user",
			email: "stranger@example.com",
		});
		const { documentId } = await owner.mutation(api.documents.create, {
			title: "Draft",
		});

		// No shares yet → owner sees shared:false.
		const before = await owner.query(api.review.documentShareState, {
			documentId,
		});
		expect(before?.role).toBe("owner");
		expect(before?.shared).toBe(false);

		await owner.mutation(api.review.addShare, {
			documentId,
			email: REVIEWER.email,
			role: "commenter",
		});

		// Owner now sees shared:true.
		const after = await owner.query(api.review.documentShareState, {
			documentId,
		});
		expect(after?.shared).toBe(true);
		expect(after?.shareCount).toBe(1);

		// Grantee sees shared:true with their role.
		const granteeView = await reviewer.query(api.review.documentShareState, {
			documentId,
		});
		expect(granteeView?.shared).toBe(true);
		expect(granteeView?.role).toBe("commenter");

		// A non-grantee, non-owner gets null (no existence leak).
		const strangerView = await stranger.query(api.review.documentShareState, {
			documentId,
		});
		expect(strangerView).toBeNull();
	});

	it("documents.remove cascades documentShares + reviewBranches + comments", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const reviewer = t.withIdentity(REVIEWER);
		const { documentId, rootNodeId } = await owner.mutation(
			api.documents.create,
			{ title: "Draft" },
		);

		// Share + a reviewer branch + a comment row, then delete the doc.
		await owner.mutation(api.review.addShare, {
			documentId,
			email: REVIEWER.email,
			role: "suggester",
		});
		await reviewer.mutation(api.review.reviewerAppend, {
			documentId,
			nodeId: crypto.randomUUID(),
			parentNodeId: rootNodeId,
			patch: fullReplacePatch("", "suggested text"),
			snapshot: "suggested text",
			selection: null,
			createdAt: 1000,
		});
		await t.run(async (ctx) => {
			await ctx.db.insert("comments", {
				documentId,
				authorUserId: REVIEWER.subject,
				authorName: "Reviewer",
				anchor: { quote: "suggested", prefix: "", suffix: "", offsetHint: 0 },
				body: "A note",
				resolved: false,
				createdAt: 1000,
			});
		});

		// Sanity: rows exist before the delete.
		const before = await t.run(async (ctx) => ({
			shares: (await ctx.db.query("documentShares").collect()).length,
			branches: (await ctx.db.query("reviewBranches").collect()).length,
			comments: (await ctx.db.query("comments").collect()).length,
		}));
		expect(before.shares).toBe(1);
		expect(before.branches).toBe(1);
		expect(before.comments).toBe(1);

		await owner.mutation(api.documents.remove, { documentId });

		const after = await t.run(async (ctx) => ({
			doc: await ctx.db.get(documentId),
			shares: (await ctx.db.query("documentShares").collect()).length,
			branches: (await ctx.db.query("reviewBranches").collect()).length,
			comments: (await ctx.db.query("comments").collect()).length,
			nodes: (await ctx.db.query("docNodes").collect()).length,
		}));
		expect(after.doc).toBeNull();
		expect(after.shares).toBe(0);
		expect(after.branches).toBe(0);
		expect(after.comments).toBe(0);
		expect(after.nodes).toBe(0);
	});
});

describe("plan 010 PHASE B — comments (auth, threading, author/origin seam)", () => {
	const anchorOf = (quote: string) => ({
		quote,
		prefix: "",
		suffix: "",
		offsetHint: 0,
	});

	async function sharedDoc(t: ReturnType<typeof convexTest>) {
		const owner = t.withIdentity(OWNER);
		const { documentId } = await owner.mutation(api.documents.create, {
			title: "Draft",
		});
		await owner.mutation(api.review.addShare, {
			documentId,
			email: COMMENTER.email,
			role: "commenter",
		});
		await owner.mutation(api.review.addShare, {
			documentId,
			email: REVIEWER.email,
			role: "suggester",
		});
		return { documentId };
	}

	it("a commenter can add + list; a stranger cannot", async () => {
		const t = convexTest(schema, modules);
		const { documentId } = await sharedDoc(t);
		const commenter = t.withIdentity(COMMENTER);
		const stranger = t.withIdentity({
			subject: "stranger",
			email: "stranger@example.com",
		});

		const { commentId } = await commenter.mutation(api.review.addComment, {
			documentId,
			anchor: anchorOf("draft"),
			body: "Tighten this.",
		});
		expect(commentId).toBeDefined();

		const list = await commenter.query(api.review.listComments, { documentId });
		expect(list).toHaveLength(1);
		expect(list[0]?.authorUserId).toBe(COMMENTER.subject);
		expect(list[0]?.authorName).toBe(COMMENTER.email); // no name claim → email
		expect(list[0]?.resolved).toBe(false);

		await expect(
			stranger.mutation(api.review.addComment, {
				documentId,
				anchor: anchorOf("draft"),
				body: "I shouldn't be here.",
			}),
		).rejects.toThrow("Document not found");
		await expect(
			stranger.query(api.review.listComments, { documentId }),
		).rejects.toThrow("Document not found");
	});

	it("an empty body is rejected", async () => {
		const t = convexTest(schema, modules);
		const { documentId } = await sharedDoc(t);
		const commenter = t.withIdentity(COMMENTER);
		await expect(
			commenter.mutation(api.review.addComment, {
				documentId,
				anchor: anchorOf("draft"),
				body: "   ",
			}),
		).rejects.toThrow();
	});

	it("author OR owner can resolve/delete; another grantee cannot", async () => {
		const t = convexTest(schema, modules);
		const { documentId } = await sharedDoc(t);
		const owner = t.withIdentity(OWNER);
		const commenter = t.withIdentity(COMMENTER);
		const reviewer = t.withIdentity(REVIEWER);

		const { commentId } = await commenter.mutation(api.review.addComment, {
			documentId,
			anchor: anchorOf("draft"),
			body: "A note.",
		});

		// Another grantee (reviewer) cannot resolve or delete someone else's comment.
		await expect(
			reviewer.mutation(api.review.setCommentResolved, {
				commentId,
				resolved: true,
			}),
		).rejects.toThrow("author or the document owner");
		await expect(
			reviewer.mutation(api.review.removeComment, { commentId }),
		).rejects.toThrow("author or the document owner");

		// The author can resolve.
		await commenter.mutation(api.review.setCommentResolved, {
			commentId,
			resolved: true,
		});
		let list = await owner.query(api.review.listComments, { documentId });
		expect(list[0]?.resolved).toBe(true);

		// The OWNER can unresolve someone else's comment.
		await owner.mutation(api.review.setCommentResolved, {
			commentId,
			resolved: false,
		});
		list = await owner.query(api.review.listComments, { documentId });
		expect(list[0]?.resolved).toBe(false);

		// The owner can delete it.
		await owner.mutation(api.review.removeComment, { commentId });
		list = await owner.query(api.review.listComments, { documentId });
		expect(list).toHaveLength(0);
	});

	it("threaded replies: a reply attaches to its root; deleting the root cascades", async () => {
		const t = convexTest(schema, modules);
		const { documentId } = await sharedDoc(t);
		const owner = t.withIdentity(OWNER);
		const commenter = t.withIdentity(COMMENTER);

		const { commentId: rootId } = await commenter.mutation(
			api.review.addComment,
			{ documentId, anchor: anchorOf("draft"), body: "Root." },
		);
		const { commentId: replyId } = await owner.mutation(api.review.addComment, {
			documentId,
			anchor: anchorOf("draft"),
			body: "Reply.",
			threadParentId: rootId,
		});

		// A reply-to-a-reply is rejected (one level of threading).
		await expect(
			commenter.mutation(api.review.addComment, {
				documentId,
				anchor: anchorOf("draft"),
				body: "Nested.",
				threadParentId: replyId,
			}),
		).rejects.toThrow("Cannot reply to a reply");

		let list = await owner.query(api.review.listComments, { documentId });
		expect(list).toHaveLength(2);
		expect(list.find((c) => c._id === replyId)?.threadParentId).toBe(rootId);

		// Deleting the root cascades its replies.
		await owner.mutation(api.review.removeComment, { commentId: rootId });
		list = await owner.query(api.review.listComments, { documentId });
		expect(list).toHaveLength(0);
	});

	it("author/origin override is OWNER-ONLY: owner can attribute, a reviewer cannot spoof", async () => {
		const t = convexTest(schema, modules);
		const { documentId } = await sharedDoc(t);
		const owner = t.withIdentity(OWNER);
		const reviewer = t.withIdentity(REVIEWER);

		// The owner (plan 011's AI path) attributes a comment to a synthetic author.
		const { commentId } = await owner.mutation(api.review.addComment, {
			documentId,
			anchor: anchorOf("draft"),
			body: "Consider a stronger verb here.",
			author: { authorName: "AI · gpt-5", authorId: "ai:review:gpt-5" },
		});
		const list = await owner.query(api.review.listComments, { documentId });
		const aiComment = list.find((c) => c._id === commentId);
		expect(aiComment?.authorName).toBe("AI · gpt-5");
		expect(aiComment?.authorUserId).toBe("ai:review:gpt-5");

		// A reviewer (non-owner) CANNOT attribute to another author.
		await expect(
			reviewer.mutation(api.review.addComment, {
				documentId,
				anchor: anchorOf("draft"),
				body: "Trying to spoof.",
				author: { authorName: "Someone Else", authorId: "victim-user" },
			}),
		).rejects.toThrow("Only the document owner can attribute");
	});
});

describe("plan 010 PHASE C — reviewer editing path + owner review surface", () => {
	/** Owner creates a doc, types one node, advances the pointer. Returns ids. */
	async function ownedDocWithText(
		t: ReturnType<typeof convexTest>,
		text: string,
	) {
		const owner = t.withIdentity(OWNER);
		const { documentId, rootNodeId } = await owner.mutation(
			api.documents.create,
			{ title: "Draft" },
		);
		const created = await t.run(async (ctx) => ctx.db.get(documentId));
		const baseTime = (created?.updatedAt ?? Date.now()) + 1000;
		const ownerNodeId = crypto.randomUUID();
		await owner.mutation(api.docNodes.append, {
			documentId,
			nodeId: ownerNodeId,
			parentNodeId: rootNodeId,
			patch: fullReplacePatch("", text),
			snapshot: text,
			selection: null,
			origin: "device-owner",
			createdAt: baseTime,
		});
		await owner.mutation(api.documents.updateCurrentNodeId, {
			documentId,
			currentNodeId: ownerNodeId,
			markdown: text,
			wordCount: text.split(/\s+/).length,
			updatedAt: baseTime,
		});
		return { documentId, ownerNodeId, baseTime };
	}

	it("getReviewerDocument seeds a grantee from the owner's current materialized node, never the documents.get owner gate", async () => {
		const t = convexTest(schema, modules);
		const reviewer = t.withIdentity(REVIEWER);
		const ownerText = "The owner wrote this sentence.";
		const { documentId, ownerNodeId } = await ownedDocWithText(t, ownerText);

		await t.run(async (ctx) => {
			await ctx.db.insert("documentShares", {
				documentId,
				ownerUserId: OWNER.subject,
				granteeEmail: REVIEWER.email,
				role: "suggester",
				createdAt: 100,
			});
		});

		// documents.get is owner-only → null for the reviewer (the reason
		// getReviewerDocument exists as the reviewer-side seed source).
		const ownerGet = await reviewer.query(api.documents.get, { documentId });
		expect(ownerGet).toBeNull();

		const seed = await reviewer.query(api.review.getReviewerDocument, {
			documentId,
		});
		expect(seed.markdown).toBe(ownerText);
		expect(seed.baseNodeId).toBe(ownerNodeId);
		expect(seed.title).toBe("Draft");

		// A stranger (no share) is blocked with the existence-safe message.
		const stranger = t.withIdentity({
			subject: "stranger",
			email: "stranger@example.com",
		});
		await expect(
			stranger.query(api.review.getReviewerDocument, { documentId }),
		).rejects.toThrow("Document not found");
	});

	it("listOpenBranches / openBranchCount are owner-only, list only open branches with reviewer name + node count", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const reviewer = t.withIdentity(REVIEWER);
		const ownerText = "Base text.";
		const { documentId, ownerNodeId } = await ownedDocWithText(t, ownerText);

		await owner.mutation(api.review.addShare, {
			documentId,
			email: REVIEWER.email,
			role: "suggester",
		});

		// No branches yet.
		expect(await owner.query(api.review.openBranchCount, { documentId })).toBe(
			0,
		);
		expect(
			await owner.query(api.review.listOpenBranches, { documentId }),
		).toHaveLength(0);

		// Reviewer appends two nodes onto their branch (binds granteeUserId too).
		const rev1 = crypto.randomUUID();
		const rev1Text = `${ownerText} A suggestion.`;
		const r1 = await reviewer.mutation(api.review.reviewerAppend, {
			documentId,
			nodeId: rev1,
			parentNodeId: ownerNodeId,
			patch: fullReplacePatch(ownerText, rev1Text),
			snapshot: rev1Text,
			selection: null,
			createdAt: 3000,
		});
		const rev2 = crypto.randomUUID();
		const rev2Text = `${rev1Text} Another.`;
		await reviewer.mutation(api.review.reviewerAppend, {
			documentId,
			branchId: r1.branchId,
			nodeId: rev2,
			parentNodeId: rev1,
			patch: fullReplacePatch(rev1Text, rev2Text),
			snapshot: rev2Text,
			selection: null,
			createdAt: 4000,
		});

		// A non-owner cannot list / count.
		await expect(
			reviewer.query(api.review.listOpenBranches, { documentId }),
		).rejects.toThrow("Document not found");
		await expect(
			reviewer.query(api.review.openBranchCount, { documentId }),
		).rejects.toThrow("Document not found");

		const list = await owner.query(api.review.listOpenBranches, {
			documentId,
		});
		expect(list).toHaveLength(1);
		expect(list[0]?._id).toBe(r1.branchId);
		expect(list[0]?.reviewerUserId).toBe(REVIEWER.subject);
		// Reviewer name resolves from the share's invited email once bound.
		expect(list[0]?.reviewerName).toBe(REVIEWER.email);
		expect(list[0]?.nodeCount).toBe(2);
		expect(await owner.query(api.review.openBranchCount, { documentId })).toBe(
			1,
		);
	});

	it("after accept the branch leaves listOpenBranches and the owner doc advances; after reject it leaves and the doc is unchanged", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const reviewer = t.withIdentity(REVIEWER);
		const ownerText = "Original draft.";
		const { documentId, ownerNodeId } = await ownedDocWithText(t, ownerText);
		await owner.mutation(api.review.addShare, {
			documentId,
			email: REVIEWER.email,
			role: "suggester",
		});

		// Branch 1 — will be accepted.
		const a1 = crypto.randomUUID();
		const a1Text = `${ownerText} Accepted edit.`;
		const ra = await reviewer.mutation(api.review.reviewerAppend, {
			documentId,
			nodeId: a1,
			parentNodeId: ownerNodeId,
			patch: fullReplacePatch(ownerText, a1Text),
			snapshot: a1Text,
			selection: null,
			createdAt: 3000,
		});

		let open = await owner.query(api.review.listOpenBranches, { documentId });
		expect(open).toHaveLength(1);

		await owner.mutation(api.review.acceptBranch, {
			documentId,
			branchId: ra.branchId as Id<"reviewBranches">,
		});

		open = await owner.query(api.review.listOpenBranches, { documentId });
		expect(open).toHaveLength(0);
		const docAfterAccept = await t.run(async (ctx) => ctx.db.get(documentId));
		expect(docAfterAccept?.markdown).toBe(a1Text);
		expect(docAfterAccept?.currentNodeId).not.toBe(ownerNodeId);

		// Branch 2 — opened off the new tip, will be rejected.
		const liveNodeId = docAfterAccept?.currentNodeId ?? "";
		const liveText = docAfterAccept?.markdown ?? "";
		const r1 = crypto.randomUUID();
		const rr = await reviewer.mutation(api.review.reviewerAppend, {
			documentId,
			nodeId: r1,
			parentNodeId: liveNodeId,
			patch: fullReplacePatch(liveText, `${liveText} Rejected edit.`),
			snapshot: `${liveText} Rejected edit.`,
			selection: null,
			createdAt: 5000,
		});

		open = await owner.query(api.review.listOpenBranches, { documentId });
		expect(open).toHaveLength(1);

		const beforeReject = await t.run(async (ctx) => ctx.db.get(documentId));
		await owner.mutation(api.review.rejectBranch, {
			documentId,
			branchId: rr.branchId as Id<"reviewBranches">,
		});

		open = await owner.query(api.review.listOpenBranches, { documentId });
		expect(open).toHaveLength(0);
		const afterReject = await t.run(async (ctx) => ctx.db.get(documentId));
		expect(afterReject?.markdown).toBe(beforeReject?.markdown);
		expect(afterReject?.currentNodeId).toBe(beforeReject?.currentNodeId);
	});
});
