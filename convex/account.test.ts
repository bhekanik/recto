import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ACCOUNT_DELETION_UNAVAILABLE_MESSAGE } from "./account";
import { PURGE_BATCH } from "./accountPurge";
import schema from "./schema";

const modules: Record<string, () => Promise<unknown>> = {
	"./schema.ts": () => import("./schema"),
	"./account.ts": () => import("./account"),
	"./accountPurge.ts": () => import("./accountPurge"),
	"./documents.ts": () => import("./documents"),
	"./docNodes.ts": () => import("./docNodes"),
	"./files.ts": () => import("./files"),
	"./_generated/api.js": () => import("./_generated/api"),
	"./_generated/server.js": () => import("./_generated/server"),
};

const OWNER = { subject: "owner-user", email: "Owner@Example.com" };
const OTHER = { subject: "other-user", email: "other@example.com" };

type Seeded = { documentId: Id<"documents">; otherDocumentId: Id<"documents"> };

/**
 * A user with something in every table that keys off them, plus a second user
 * whose rows must survive untouched.
 */
async function seed(t: ReturnType<typeof convexTest>): Promise<Seeded> {
	return await t.run(async (ctx) => {
		const now = Date.now();

		const otherDocumentId = await ctx.db.insert("documents", {
			userId: OTHER.subject,
			title: "Theirs",
			markdown: "not yours",
			wordCount: 2,
			currentNodeId: "other-root",
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert("docNodes", {
			documentId: otherDocumentId,
			nodeId: "other-root",
			parentNodeId: null,
			patch: "{}",
			selection: null,
			origin: "test",
			createdAt: now,
		});

		const documentId = await ctx.db.insert("documents", {
			userId: OWNER.subject,
			title: "Mine",
			markdown: "hello",
			wordCount: 1,
			currentNodeId: "root",
			createdAt: now,
			updatedAt: now,
		});
		for (let i = 0; i < 3; i += 1) {
			await ctx.db.insert("docNodes", {
				documentId,
				nodeId: `node-${i}`,
				parentNodeId: i === 0 ? null : `node-${i - 1}`,
				patch: "{}",
				selection: null,
				origin: "test",
				createdAt: now,
			});
		}
		await ctx.db.insert("versions", {
			documentId,
			nodeId: "node-1",
			label: "Checkpoint",
			kind: "manual",
			createdAt: now,
		});
		await ctx.db.insert("documentShares", {
			documentId,
			ownerUserId: OWNER.subject,
			granteeEmail: "reviewer@example.com",
			role: "commenter",
			createdAt: now,
		});
		await ctx.db.insert("reviewBranches", {
			documentId,
			reviewerUserId: "reviewer-user",
			baseNodeId: "node-0",
			headNodeId: "node-1",
			status: "open",
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert("comments", {
			documentId,
			authorUserId: "reviewer-user",
			authorName: "Reviewer",
			anchor: { quote: "hello", prefix: "", suffix: "", offsetHint: 0 },
			body: "nice",
			resolved: false,
			createdAt: now,
		});
		await ctx.db.insert("docChunks", {
			userId: OWNER.subject,
			documentId,
			charStart: 0,
			charEnd: 5,
			text: "hello",
			embedding: new Array(1536).fill(0),
			embeddedNodeId: "node-2",
			updatedAt: now,
		});

		// The owner's traces on ANOTHER user's document.
		await ctx.db.insert("comments", {
			documentId: otherDocumentId,
			authorUserId: OWNER.subject,
			authorName: "Owner",
			anchor: { quote: "not", prefix: "", suffix: "", offsetHint: 0 },
			body: "a note on someone else's draft",
			resolved: false,
			createdAt: now,
		});
		await ctx.db.insert("reviewBranches", {
			documentId: otherDocumentId,
			reviewerUserId: OWNER.subject,
			baseNodeId: "other-root",
			headNodeId: "other-root",
			status: "open",
			createdAt: now,
			updatedAt: now,
		});
		// An invite addressed to the owner's email but never claimed.
		await ctx.db.insert("documentShares", {
			documentId: otherDocumentId,
			ownerUserId: OTHER.subject,
			granteeEmail: OWNER.email.toLowerCase(),
			role: "suggester",
			createdAt: now,
		});
		// And one already resolved to their user id.
		await ctx.db.insert("documentShares", {
			documentId: otherDocumentId,
			ownerUserId: OTHER.subject,
			granteeEmail: "an-alias@example.com",
			granteeUserId: OWNER.subject,
			role: "commenter",
			createdAt: now,
		});

		await ctx.db.insert("writingStats", {
			userId: OWNER.subject,
			date: "2026-08-28",
			words: 100,
			updatedAt: now,
		});
		await ctx.db.insert("writingStats", {
			userId: OTHER.subject,
			date: "2026-08-28",
			words: 5,
			updatedAt: now,
		});
		await ctx.db.insert("workspaces", {
			userId: OWNER.subject,
			deviceId: "web-1",
			deviceClass: "web",
			json: "{}",
			updatedAt: now,
		});
		await ctx.db.insert("settings", {
			userId: OWNER.subject,
			json: '{"theme":"aurora"}',
			updatedAt: now,
		});

		return { documentId, otherDocumentId };
	});
}

async function countAll(t: ReturnType<typeof convexTest>) {
	return await t.run(async (ctx) => ({
		documents: (await ctx.db.query("documents").collect()).length,
		docNodes: (await ctx.db.query("docNodes").collect()).length,
		versions: (await ctx.db.query("versions").collect()).length,
		documentShares: (await ctx.db.query("documentShares").collect()).length,
		reviewBranches: (await ctx.db.query("reviewBranches").collect()).length,
		comments: (await ctx.db.query("comments").collect()).length,
		docChunks: (await ctx.db.query("docChunks").collect()).length,
		writingStats: (await ctx.db.query("writingStats").collect()).length,
		workspaces: (await ctx.db.query("workspaces").collect()).length,
		settings: (await ctx.db.query("settings").collect()).length,
	}));
}

/** Drive the purge mutations the way the action does, and report the rounds. */
async function purgeToCompletion(
	t: ReturnType<typeof convexTest>,
	userId: string,
	granteeEmail?: string,
	limit?: number,
): Promise<{ rounds: number; deleted: number }> {
	let rounds = 0;
	let deleted = 0;
	for (;;) {
		rounds += 1;
		const result = await t.mutation(internal.accountPurge.purgeData, {
			userId,
			granteeEmail,
			limit,
		});
		deleted += result.deleted;
		if (result.done) return { rounds, deleted };
		if (rounds > 200) throw new Error("purge did not converge");
	}
}

describe("accountPurge.purgeData", () => {
	it("removes every row keyed to the user and nothing keyed to anyone else", async () => {
		const t = convexTest(schema, modules);
		const { otherDocumentId } = await seed(t);

		await purgeToCompletion(t, OWNER.subject, OWNER.email);

		expect(await countAll(t)).toEqual({
			documents: 1, // the other user's
			docNodes: 1,
			versions: 0,
			documentShares: 0,
			reviewBranches: 0,
			comments: 0,
			docChunks: 0,
			writingStats: 1,
			workspaces: 0,
			settings: 0,
		});

		const survivor = await t.run((ctx) => ctx.db.get(otherDocumentId));
		expect(survivor?.markdown).toBe("not yours");
	});

	it("removes the user's comments and branches on other people's documents", async () => {
		const t = convexTest(schema, modules);
		const { otherDocumentId } = await seed(t);

		await purgeToCompletion(t, OWNER.subject, OWNER.email);

		const left = await t.run(async (ctx) => ({
			comments: await ctx.db
				.query("comments")
				.withIndex("by_document", (q) => q.eq("documentId", otherDocumentId))
				.collect(),
			branches: await ctx.db
				.query("reviewBranches")
				.withIndex("by_document", (q) => q.eq("documentId", otherDocumentId))
				.collect(),
		}));
		expect(left.comments).toHaveLength(0);
		expect(left.branches).toHaveLength(0);
	});

	it("removes unclaimed invites addressed to the user's email, case-insensitively", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		// OWNER.email is mixed-case; shares store it lowercased.
		await purgeToCompletion(t, OWNER.subject, OWNER.email);

		expect((await countAll(t)).documentShares).toBe(0);
	});

	it("leaves an email-addressed invite alone when no email is supplied", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		await purgeToCompletion(t, OWNER.subject, undefined);

		// The unclaimed invite is the only share that cannot be reached without it.
		const shares = await t.run((ctx) =>
			ctx.db.query("documentShares").collect(),
		);
		expect(shares.map((share) => share.granteeEmail)).toEqual([
			OWNER.email.toLowerCase(),
		]);
	});

	it("is idempotent — a second full purge deletes nothing", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		await purgeToCompletion(t, OWNER.subject, OWNER.email);

		const second = await purgeToCompletion(t, OWNER.subject, OWNER.email);
		expect(second.deleted).toBe(0);
		expect(second.rounds).toBe(1);
	});

	it("resumes from a partial purge", async () => {
		const t = convexTest(schema, modules);
		await seed(t);

		// One tiny batch, then stop — the state a crashed action leaves behind.
		const partial = await t.mutation(internal.accountPurge.purgeData, {
			userId: OWNER.subject,
			granteeEmail: OWNER.email,
			limit: 2,
		});
		expect(partial.deleted).toBe(2);
		expect(partial.done).toBe(false);

		await purgeToCompletion(t, OWNER.subject, OWNER.email);
		expect((await countAll(t)).documents).toBe(1);
	});

	it("clears an account far larger than one batch", async () => {
		const t = convexTest(schema, modules);
		const { documentId } = await seed(t);
		await t.run(async (ctx) => {
			for (let i = 0; i < PURGE_BATCH * 3; i += 1) {
				await ctx.db.insert("docNodes", {
					documentId,
					nodeId: `bulk-${i}`,
					parentNodeId: "node-0",
					patch: "{}",
					selection: null,
					origin: "test",
					createdAt: Date.now(),
				});
			}
		});

		const { rounds } = await purgeToCompletion(t, OWNER.subject, OWNER.email);
		expect(rounds).toBeGreaterThan(1);
		expect((await countAll(t)).docNodes).toBe(1);
	});

	it("does nothing for a user who has never written anything", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		const before = await countAll(t);

		const result = await purgeToCompletion(t, "user-who-never-existed");
		expect(result.deleted).toBe(0);
		expect(await countAll(t)).toEqual(before);
	});
});

describe("accountPurge.purgeStorage", () => {
	it("deletes blobs the user's markdown references and leaves others alone", async () => {
		const t = convexTest(schema, modules);
		const { documentId } = await seed(t);

		const [mine, theirs] = await t.run(async (ctx) => [
			await ctx.storage.store(new Blob(["mine"])),
			await ctx.storage.store(new Blob(["theirs"])),
		]);

		// Point the owner's markdown at their blob the way the editor does — by
		// the served URL, whose last segment is what the reference check matches.
		const url = await t.run((ctx) => ctx.storage.getUrl(mine));
		await t.run((ctx) =>
			ctx.db.patch(documentId, { markdown: `text ![alt](${url}) more` }),
		);

		const result = await t.mutation(internal.accountPurge.purgeStorage, {
			userId: OWNER.subject,
		});
		expect(result).toEqual({ deleted: 1, done: true });

		const left = await t.run((ctx) =>
			ctx.db.system.query("_storage").collect(),
		);
		expect(left.map((file) => file._id)).toEqual([theirs]);
	});

	it("reports done with nothing to do once the user has no documents", async () => {
		const t = convexTest(schema, modules);
		expect(
			await t.mutation(internal.accountPurge.purgeStorage, {
				userId: OWNER.subject,
			}),
		).toEqual({ deleted: 0, done: true });
	});
});

describe("account.deleteEverything", () => {
	const originalSecret = process.env.CLERK_SECRET_KEY;

	beforeEach(() => {
		process.env.CLERK_SECRET_KEY = "sk_test_not_a_real_key";
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		if (originalSecret === undefined) delete process.env.CLERK_SECRET_KEY;
		else process.env.CLERK_SECRET_KEY = originalSecret;
	});

	/** Stand-in for the Clerk Backend API. Records what was asked of it. */
	function stubClerk(
		options: {
			externalAccounts?: { provider: string }[];
			deleteStatus?: number;
			userStatus?: number;
		} = {},
	) {
		const calls: { method: string; url: string }[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				calls.push({ method: init?.method ?? "GET", url });
				if ((init?.method ?? "GET") === "DELETE") {
					return new Response("{}", { status: options.deleteStatus ?? 200 });
				}
				return new Response(
					JSON.stringify({
						external_accounts: options.externalAccounts ?? [],
					}),
					{ status: options.userStatus ?? 200 },
				);
			}),
		);
		return calls;
	}

	it("requires authentication", async () => {
		const t = convexTest(schema, modules);
		stubClerk();
		await expect(t.action(api.account.deleteEverything, {})).rejects.toThrow(
			"Unauthenticated",
		);
	});

	it("refuses, without deleting anything, when CLERK_SECRET_KEY is missing", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		const before = await countAll(t);
		delete process.env.CLERK_SECRET_KEY;

		await expect(
			t.withIdentity(OWNER).action(api.account.deleteEverything, {}),
		).rejects.toThrow(ACCOUNT_DELETION_UNAVAILABLE_MESSAGE);

		// The one failure mode worse than not deleting: data gone, login alive.
		expect(await countAll(t)).toEqual(before);
	});

	it("purges the data and deletes the Clerk user last", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		const calls = stubClerk();

		const result = await t
			.withIdentity(OWNER)
			.action(api.account.deleteEverything, {});

		expect(result.clerkUserDeleted).toBe(true);
		expect(result.rowsDeleted).toBeGreaterThan(0);
		expect(result.appleRevocation).toEqual({ status: "not-applicable" });
		expect((await countAll(t)).documents).toBe(1); // other user's survives

		const deleteCall = calls.find((call) => call.method === "DELETE");
		expect(deleteCall?.url).toBe(
			`https://api.clerk.com/v1/users/${OWNER.subject}`,
		);
	});

	it("reports what blocks Apple revocation when the user signed in with Apple", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		stubClerk({ externalAccounts: [{ provider: "apple" }] });

		const result = await t
			.withIdentity(OWNER)
			.action(api.account.deleteEverything, {});

		expect(result.appleRevocation.status).toBe("skipped");
		expect(result.appleRevocation).toHaveProperty("reason");
	});

	it("also recognises Apple under its oauth_ prefixed spelling", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		stubClerk({ externalAccounts: [{ provider: "oauth_apple" }] });

		const result = await t
			.withIdentity(OWNER)
			.action(api.account.deleteEverything, {});
		expect(result.appleRevocation.status).toBe("skipped");
	});

	it("says 'unknown' rather than 'no Apple account' for a response it cannot read", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				if ((init?.method ?? "GET") === "DELETE") {
					return new Response("{}", { status: 200 });
				}
				// Not the shape the code expects — reporting "no Apple account" here
				// would silently claim a compliance box was ticked.
				return new Response(JSON.stringify({ external_accounts: "nope" }), {
					status: 200,
				});
			}),
		);

		const result = await t
			.withIdentity(OWNER)
			.action(api.account.deleteEverything, {});
		expect(result.appleRevocation.status).toBe("unknown");
	});

	it("treats an already-deleted Clerk user as success", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		stubClerk({ deleteStatus: 404, userStatus: 404 });

		const result = await t
			.withIdentity(OWNER)
			.action(api.account.deleteEverything, {});
		expect(result.clerkUserDeleted).toBe(true);
	});

	it("fails loudly when Clerk refuses, so the caller knows to retry", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		stubClerk({ deleteStatus: 500 });

		await expect(
			t.withIdentity(OWNER).action(api.account.deleteEverything, {}),
		).rejects.toThrow("Clerk refused to delete the user");
		// The data is already gone; the account stays reachable for a retry.
		expect((await countAll(t)).documents).toBe(1);
	});

	it("is idempotent end to end", async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		stubClerk();
		const owner = t.withIdentity(OWNER);

		await owner.action(api.account.deleteEverything, {});
		const second = await owner.action(api.account.deleteEverything, {});
		expect(second.rowsDeleted).toBe(0);
		expect(second.clerkUserDeleted).toBe(true);
	});
});
