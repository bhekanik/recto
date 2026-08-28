import type { GenericActionCtx } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import {
	action,
	internalAction,
	internalMutation,
	internalQuery,
} from "./_generated/server";
import { TOMBSTONE_RETENTION_MS } from "./accountGuard";

/**
 * In-app account deletion (plan 023 §4.1(4); App Store guideline 5.1.1(v),
 * which requires an in-app path that deletes the account itself, not just its
 * data, and not a "email us to delete" link).
 *
 * The shape of the operation, and why it is in this order:
 *
 *  0. **Verify Clerk first.** If the secret cannot reach this user, nothing is
 *     deleted. A wrong-instance secret returns 404 for every call, and a
 *     version of this that skipped the check happily purged the data and then
 *     reported the Clerk user deleted when it had never existed to that key.
 *  1. **Write a tombstone.** Deletion spans many transactions and an HTTP call;
 *     the user's JWT stays valid throughout. Without the tombstone a stale tab
 *     or an offline outbox recreates rows behind the purge — `settings.save`,
 *     `workspaces.saveForDevice`, `documents.create` — and they end up owned by
 *     an account nobody can reach. Every user-facing mutation refuses while it
 *     exists (`accountGuard.ts`).
 *  2. **Blobs, then rows**, each in bounded batches. Rows are not touched until
 *     the blob phase reports itself finished.
 *  3. **The Clerk user, last.** Every step before it is idempotent, so a
 *     failure anywhere leaves an account that can still sign in and press the
 *     button again. Deleting the identity first would strand the data with
 *     nobody able to reach it.
 *  4. **A final purge**, catching anything that landed between the last pass
 *     and the identity going away.
 *
 * The tombstone is kept for `TOMBSTONE_RETENTION_MS` afterwards and swept by a
 * daily cron.
 */

const CLERK_API_BASE = "https://api.clerk.com/v1";

/** Bound on purge rounds, so a bug cannot spin an action until it is killed. */
const MAX_PURGE_PASSES = 500;

/**
 * How long after the client's call the server-owned resume job runs. Deletion
 * does not depend on the caller staying connected: if the action is cut off
 * mid-purge, this picks it up.
 */
const RESUME_DELAY_MS = 60 * 1000;

/** How many times the resume job will re-arm itself before giving up. */
const MAX_RESUME_ATTEMPTS = 10;

export const ACCOUNT_DELETION_UNAVAILABLE_MESSAGE =
	"Account deletion is not configured on this deployment (CLERK_SECRET_KEY is missing). No data was deleted.";

export const CLERK_USER_UNREACHABLE_MESSAGE =
	"Account deletion could not reach this user in Clerk, so nothing was deleted. This usually means the deployment's CLERK_SECRET_KEY belongs to a different Clerk instance.";

export const ACCOUNT_DELETION_UPLOAD_CUTOVER_MESSAGE =
	"Account deletion is temporarily unavailable while upload security is updated. Try again later; no data was deleted.";

export const ACCOUNT_DELETION_BLOB_MIGRATIONS_MESSAGE =
	"Account deletion is temporarily unavailable while stored files are being prepared. Try again later; no data was deleted.";

const REQUIRED_BLOB_MIGRATIONS = [
	"scanDocumentRefs",
	"scanNodeRefs",
	"backfillBlobOwners",
] as const;

/**
 * Sign in with Apple token revocation: DETECTED HERE, NOT PERFORMED. Read this
 * before shipping the iOS app — it is an open item on plan 023 §10.
 *
 * Apple TN3194 ("Handling account deletions and revoking tokens for Sign in
 * with Apple") wants `POST https://appleid.apple.com/auth/revoke` with the
 * user's Apple refresh **or** access token plus a `client_secret` JWT signed
 * ES256 with the team's `.p8` key (`iss` = Team ID, `sub`/`client_id` =
 * App/Services ID, `kid` = Key ID, `aud` = https://appleid.apple.com).
 *
 * Two things are missing, and neither is a matter of writing more code here:
 *
 *  1. **The Apple signing credentials.** Team ID, Services ID, Key ID and the
 *     `.p8` private key are Apple Developer credentials. None are on this
 *     deployment, and Clerk never holds them either.
 *  2. **An Apple token to revoke.** Clerk's `OauthAccessToken` object has no
 *     `refresh_token` field for any provider, and Apple has no general-purpose
 *     API the access token would be used against, so what
 *     `GET /users/{id}/oauth_access_tokens/oauth_apple` returns for an Apple
 *     account is unverified — nobody has run it against a live Apple-linked
 *     user, because Sign in with Apple is not yet enabled on the Clerk
 *     instance (W5, N0a).
 *
 * And deleting the Clerk user does NOT cover it: Clerk's own Sign in with
 * Apple guide says in as many words that "deleting the user from Clerk does
 * not reset this on Apple's side."
 *
 * So the action detects an Apple external account and reports exactly what
 * stopped it, rather than silently implying the revocation happened or
 * shipping ES256 signing that has never run against a real Apple account.
 */
export type AppleRevocation =
	| { status: "not-applicable" }
	| { status: "skipped"; reason: string }
	| { status: "unknown"; reason: string };

export type DeletionResult = {
	userId: string;
	rowsDeleted: number;
	blobsDeleted: number;
	/** Files kept only because another account still references them. */
	blobsRetained: number;
	clerkUserDeleted: boolean;
	appleRevocation: AppleRevocation;
};

/**
 * Clerk spells Apple two ways: `oauth_apple` is the sign-in STRATEGY and the
 * path segment of the oauth-token endpoint, while `external_accounts[].provider`
 * appears to carry the bare `apple`. Match both rather than pick the wrong one
 * and silently report "no Apple account" for every Apple user.
 */
const APPLE_PROVIDERS = new Set(["apple", "oauth_apple"]);

/**
 * Clerk's Backend API version. Pinned to the same version `@clerk/backend`
 * 3.8.4 pins, so this raw `fetch` cannot drift onto a newer response shape
 * than the one `appleAccountPresent` reads.
 */
const CLERK_API_VERSION = "2026-05-12";

const MISSING_APPLE_CREDENTIALS =
	"An Apple external account exists, but Apple-side revocation was not attempted: this deployment holds no Apple signing credentials (Team ID, Services ID, Key ID, .p8 key) and Clerk exposes no Apple refresh token, both of which TN3194's /auth/revoke call needs. Deleting the Clerk user does not revoke on Apple's side. Ask the user to remove the app under Settings > Apple Account > Sign in with Apple until this is wired up.";

/**
 * Whether this Clerk user has an Apple external account — `null` when the
 * response cannot answer. Clerk's body is external input, so it is narrowed
 * from `unknown` rather than cast to a trusted shape: a response that does not
 * look like this must read as "cannot tell", never as "no Apple account",
 * because the second silently claims a compliance box was ticked.
 */
function appleAccountPresent(body: unknown): boolean | null {
	if (typeof body !== "object" || body === null) return null;
	const accounts = (body as { external_accounts?: unknown }).external_accounts;
	if (accounts === undefined) return false;
	if (!Array.isArray(accounts)) return null;
	return accounts.some((account) => {
		if (typeof account !== "object" || account === null) return false;
		const provider = (account as { provider?: unknown }).provider;
		return typeof provider === "string" && APPLE_PROVIDERS.has(provider);
	});
}

async function clerkRequest(
	secret: string,
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	return await fetch(`${CLERK_API_BASE}${path}`, {
		...init,
		headers: {
			...init.headers,
			// Never logged, never returned to the caller.
			Authorization: `Bearer ${secret}`,
			"Clerk-API-Version": CLERK_API_VERSION,
			"Content-Type": "application/json",
		},
	});
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Run one purge step until it reports nothing left. The pass bound is a
 * stop-loss, not an expected outcome: `done: false` after this many rounds
 * means a step is not making progress, and looping forever would burn the
 * action's time budget instead of saying so.
 */
async function drain(
	step: () => Promise<{ deleted: number; done: boolean }>,
): Promise<{ deleted: number; done: boolean }> {
	let deleted = 0;
	for (let pass = 0; pass < MAX_PURGE_PASSES; pass += 1) {
		const result = await step();
		deleted += result.deleted;
		if (result.done) return { deleted, done: true };
	}
	return { deleted, done: false };
}

async function drainBlobs(
	step: () => Promise<{ deleted: number; kept: number; done: boolean }>,
): Promise<{ deleted: number; kept: number; done: boolean }> {
	let deleted = 0;
	let kept = 0;
	for (let pass = 0; pass < MAX_PURGE_PASSES; pass += 1) {
		const result = await step();
		deleted += result.deleted;
		kept += result.kept;
		if (result.done) return { deleted, kept, done: true };
	}
	return { deleted, kept, done: false };
}

async function assertLegacyUploadsExpired(
	ctx: GenericActionCtx<DataModel>,
): Promise<void> {
	const cutover = await ctx.runQuery(internal.files.getLegacyUploadCutover, {});
	if (!cutover || cutover.safeAfter > Date.now()) {
		throw new Error(ACCOUNT_DELETION_UPLOAD_CUTOVER_MESSAGE);
	}
}

export const getBlobMigrationReadiness = internalQuery({
	args: {},
	handler: async (ctx) => {
		const progress = await Promise.all(
			REQUIRED_BLOB_MIGRATIONS.map((name) =>
				ctx.db
					.query("migrationProgress")
					.withIndex("by_name", (q) => q.eq("name", name))
					.unique(),
			),
		);
		return {
			ready: progress.every((row) => row?.done === true),
			pending: REQUIRED_BLOB_MIGRATIONS.filter(
				(_name, index) => progress[index]?.done !== true,
			),
		};
	},
});

async function assertBlobMigrationsComplete(
	ctx: GenericActionCtx<DataModel>,
): Promise<void> {
	const readiness = await ctx.runQuery(
		internal.account.getBlobMigrationReadiness,
		{},
	);
	if (!readiness.ready) {
		throw new Error(ACCOUNT_DELETION_BLOB_MIGRATIONS_MESSAGE);
	}
}

// ---------------------------------------------------------------------------
// Tombstone lifecycle
// ---------------------------------------------------------------------------

const phaseValidator = v.union(
	v.literal("blobs"),
	v.literal("rows"),
	v.literal("identity"),
	v.literal("purged"),
);

/**
 * Create the tombstone, or return the existing one. Idempotent: a retry after
 * a partial failure must resume the same deletion, not start a second one, and
 * must not reset the phase that tells a Clerk 404 apart from a wrong-instance
 * 404.
 */
export const beginDeletion = internalMutation({
	args: { userId: v.string(), granteeEmail: v.optional(v.string()) },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("accountDeletions")
			.withIndex("by_user", (q) => q.eq("userId", args.userId))
			.unique();
		const now = Date.now();

		if (existing) {
			// A response-lost retry after completion must not make the tombstone
			// immortal by clearing the expiry it already earned.
			await ctx.db.patch(existing._id, {
				updatedAt: now,
				expiresAt: existing.phase === "purged" ? existing.expiresAt : undefined,
				granteeEmail: args.granteeEmail ?? existing.granteeEmail,
			});
			return { phase: existing.phase, resumed: true as const };
		}

		await ctx.db.insert("accountDeletions", {
			userId: args.userId,
			granteeEmail: args.granteeEmail,
			startedAt: now,
			updatedAt: now,
			phase: "blobs",
		});

		// Scheduled from INSIDE the transaction that creates the tombstone, so
		// the two commit together: a crash between "the account is fenced" and
		// "something is going to finish it" would otherwise leave an inert
		// account with no continuation. Only on creation, so a retry cannot
		// stack up another job.
		await ctx.scheduler.runAfter(
			RESUME_DELAY_MS,
			internal.account.resumeDeletion,
			{ userId: args.userId, attempt: 1 },
		);

		return { phase: "blobs" as const, resumed: false as const };
	},
});

/**
 * Phases only ever move forward. Two runs of the same deletion can overlap —
 * the user pressing the button again while the scheduled continuation is
 * working — and an older run writing `rows` over `purged` would clear
 * `expiresAt` and un-finish a deletion that every other job had already
 * observed as complete.
 */
const PHASE_ORDER = ["blobs", "rows", "identity", "purged"] as const;

export const setDeletionPhase = internalMutation({
	args: { userId: v.string(), phase: phaseValidator },
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("accountDeletions")
			.withIndex("by_user", (q) => q.eq("userId", args.userId))
			.unique();
		if (!row) return { phase: null };

		if (PHASE_ORDER.indexOf(args.phase) <= PHASE_ORDER.indexOf(row.phase)) {
			if (
				args.phase === "purged" &&
				row.phase === "purged" &&
				row.expiresAt === undefined
			) {
				const now = Date.now();
				await ctx.db.patch(row._id, {
					updatedAt: now,
					expiresAt: now + TOMBSTONE_RETENTION_MS,
				});
			}
			return { phase: row.phase };
		}

		const now = Date.now();
		await ctx.db.patch(row._id, {
			phase: args.phase,
			updatedAt: now,
			// The tombstone only becomes sweepable once the deletion is finished.
			expiresAt:
				args.phase === "purged" ? now + TOMBSTONE_RETENTION_MS : undefined,
		});
		return { phase: args.phase };
	},
});

export const getDeletion = internalQuery({
	args: { userId: v.string() },
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("accountDeletions")
			.withIndex("by_user", (q) => q.eq("userId", args.userId))
			.unique();
		if (!row) return null;
		return {
			phase: row.phase,
			granteeEmail: row.granteeEmail,
			startedAt: row.startedAt,
			expiresAt: row.expiresAt,
		};
	},
});

/**
 * Drop tombstones whose retention window has passed. Run daily by cron — until
 * then the row is what makes a late mutation from a not-yet-expired JWT fail.
 */
export const sweepTombstones = internalMutation({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const now = Date.now();
		const expired = await ctx.db
			.query("accountDeletions")
			.withIndex("by_expires", (q) => q.lte("expiresAt", now))
			.take(Math.max(1, Math.min(args.limit ?? 256, 256)));

		let deleted = 0;
		for (const row of expired) {
			// The index range includes rows with no expiry (undefined sorts first),
			// which are deletions still in flight.
			if (row.expiresAt === undefined) continue;
			await ctx.db.delete(row._id);
			deleted += 1;
		}
		return { deleted };
	},
});

// ---------------------------------------------------------------------------
// The deletion itself
// ---------------------------------------------------------------------------

/**
 * Everything after the tombstone exists. Shared by the user-facing action and
 * the server-owned resume job so both take exactly the same path.
 */
async function runDeletion(
	ctx: GenericActionCtx<DataModel>,
	secret: string,
	userId: string,
	granteeEmail: string | undefined,
	startPhase: "blobs" | "rows" | "identity" | "purged",
): Promise<DeletionResult> {
	let blobsDeleted = 0;
	let blobsRetained = 0;
	let rowsDeleted = 0;

	if (startPhase === "blobs") {
		const blobs = await drainBlobs(() =>
			ctx.runMutation(internal.accountPurge.purgeBlobs, { userId }),
		);
		blobsDeleted += blobs.deleted;
		blobsRetained += blobs.kept;
		if (!blobs.done) {
			// Deliberately before the row purge and the Clerk delete: files the
			// purge has not reached are still fetchable by anyone holding their
			// bearer URL, and removing the identity now would leave nobody able to
			// finish the job.
			throw new Error(
				`Blob purge did not finish in ${MAX_PURGE_PASSES} passes (${blobsDeleted} deleted). Run it again to continue.`,
			);
		}

		// Files a pre-`/upload-image` browser tab stored without ever recording
		// ownership. Bounded, and conservative: only tokens nobody else mentions.
		const orphans = await drain(() =>
			ctx.runMutation(internal.accountPurge.purgeUnattributedBlobs, { userId }),
		);
		blobsDeleted += orphans.deleted;
		if (!orphans.done) {
			throw new Error(
				`Unattributed blob purge did not finish in ${MAX_PURGE_PASSES} passes. Run it again to continue.`,
			);
		}

		await ctx.runMutation(internal.account.setDeletionPhase, {
			userId,
			phase: "rows",
		});
	}

	if (startPhase === "blobs" || startPhase === "rows") {
		const rows = await drain(() =>
			ctx.runMutation(internal.accountPurge.purgeData, {
				userId,
				granteeEmail,
			}),
		);
		rowsDeleted += rows.deleted;
		if (!rows.done) {
			throw new Error(
				`Account data purge did not finish in ${MAX_PURGE_PASSES} passes (${rowsDeleted} rows deleted). Run it again to continue.`,
			);
		}
		await ctx.runMutation(internal.account.setDeletionPhase, {
			userId,
			phase: "identity",
		});
	}

	// Read Apple attribution before the user is deleted; after that there is
	// nothing left to read it from.
	const appleRevocation = await checkAppleRevocation(secret, userId);

	const deleteResponse = await clerkRequest(secret, `/users/${userId}`, {
		method: "DELETE",
	});
	// A 404 here is safe to accept: reaching this point means a GET for this
	// user returned 200 on the deployment's own secret, so the instance is the
	// right one and the user is simply already gone (this action running twice).
	if (!deleteResponse.ok && deleteResponse.status !== 404) {
		throw new Error(
			`Data was deleted, but Clerk refused to delete the user (HTTP ${deleteResponse.status}). Sign in and try again.`,
		);
	}

	// Anything that landed between the last pass and the identity going away.
	const tail = await drain(() =>
		ctx.runMutation(internal.accountPurge.purgeData, { userId, granteeEmail }),
	);
	rowsDeleted += tail.deleted;
	const tailBlobs = await drainBlobs(() =>
		ctx.runMutation(internal.accountPurge.purgeBlobs, { userId }),
	);
	blobsDeleted += tailBlobs.deleted;
	blobsRetained += tailBlobs.kept;
	const tailUnattributed = await drain(() =>
		ctx.runMutation(internal.accountPurge.purgeUnattributedBlobs, { userId }),
	);
	blobsDeleted += tailUnattributed.deleted;

	// Not `purged`: the phase stays `identity` so the scheduled continuation
	// picks this up, rather than the tombstone starting to expire over work
	// that is demonstrably unfinished.
	if (!tail.done || !tailBlobs.done || !tailUnattributed.done) {
		throw new Error(
			"The final sweep did not finish; the account stays fenced and the deletion will be retried.",
		);
	}

	await ctx.runMutation(internal.account.setDeletionPhase, {
		userId,
		phase: "purged",
	});

	return {
		userId,
		rowsDeleted,
		blobsDeleted,
		blobsRetained,
		clerkUserDeleted: true,
		appleRevocation,
	};
}

/**
 * Look up whether this identity signed in with Apple. A failure here is not
 * fatal — it only means the response cannot say for certain, which is what
 * `status: "unknown"` records.
 */
async function checkAppleRevocation(
	secret: string,
	clerkUserId: string,
): Promise<AppleRevocation> {
	let response: Response;
	try {
		response = await clerkRequest(secret, `/users/${clerkUserId}`);
	} catch (error) {
		return {
			status: "unknown",
			reason: `Could not read the Clerk user: ${errorText(error)}`,
		};
	}
	if (response.status === 404) return { status: "not-applicable" };
	if (!response.ok) {
		return {
			status: "unknown",
			reason: `Clerk returned ${response.status} for the user lookup.`,
		};
	}

	const hasApple = appleAccountPresent(await response.json());
	if (hasApple === null) {
		return {
			status: "unknown",
			reason:
				"Clerk's user response did not carry a readable external_accounts list.",
		};
	}
	if (!hasApple) return { status: "not-applicable" };
	return { status: "skipped", reason: MISSING_APPLE_CREDENTIALS };
}

export const deleteEverything = action({
	args: {},
	handler: async (ctx): Promise<DeletionResult> => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw new Error("Unauthenticated");

		// Checked BEFORE anything is deleted. Without it the data would go and the
		// login would survive, which is the one outcome guideline 5.1.1(v) is
		// about; better to refuse while everything is still intact.
		const secret = process.env.CLERK_SECRET_KEY;
		if (!secret) throw new Error(ACCOUNT_DELETION_UNAVAILABLE_MESSAGE);
		await assertLegacyUploadsExpired(ctx);
		await assertBlobMigrationsComplete(ctx);

		const userId = identity.subject;
		const granteeEmail =
			typeof identity.email === "string" ? identity.email : undefined;

		const existing = await ctx.runQuery(internal.account.getDeletion, {
			userId,
		});

		// On a NEW deletion the secret must be able to SEE this user. A secret for
		// the wrong Clerk instance answers 404 to every call, which is
		// indistinguishable from "already deleted" unless you know whether this
		// deployment has ever asked Clerk to delete them — which is exactly what
		// the tombstone's phase records.
		const alreadyAskedClerk =
			existing?.phase === "identity" || existing?.phase === "purged";
		if (!alreadyAskedClerk) {
			const probe = await clerkRequest(secret, `/users/${userId}`);
			if (!probe.ok) throw new Error(CLERK_USER_UNREACHABLE_MESSAGE);
		}

		const started = await ctx.runMutation(internal.account.beginDeletion, {
			userId,
			granteeEmail,
		});

		// The server-owned continuation is scheduled inside `beginDeletion`, in
		// the same transaction that writes the tombstone — scheduling it here
		// instead left a crash window where the account was fenced with nothing
		// arranged to finish it, and stacked another job on every retry.

		return await runDeletion(
			ctx,
			secret,
			userId,
			existing?.granteeEmail ?? granteeEmail,
			started.phase,
		);
	},
});

/**
 * Finish a deletion the user-facing action did not. Re-arms itself while there
 * is still work, so a client that closed its laptop mid-delete does not leave
 * an account half gone.
 */
export const resumeDeletion = internalAction({
	args: { userId: v.string(), attempt: v.number() },
	handler: async (ctx, args): Promise<void> => {
		const tombstone = await ctx.runQuery(internal.account.getDeletion, {
			userId: args.userId,
		});
		if (!tombstone || tombstone.phase === "purged") return;

		const secret = process.env.CLERK_SECRET_KEY;
		if (!secret) return; // nothing this job can do; the tombstone stays

		try {
			await assertLegacyUploadsExpired(ctx);
			await assertBlobMigrationsComplete(ctx);
			await runDeletion(
				ctx,
				secret,
				args.userId,
				tombstone.granteeEmail,
				tombstone.phase,
			);
		} catch {
			// Swallowed on purpose: the tombstone still blocks writes, and
			// rethrowing would only fill the logs with the same failure. Re-arm
			// instead, with a bound so a permanently failing deletion stops.
			if (args.attempt < MAX_RESUME_ATTEMPTS) {
				await ctx.scheduler.runAfter(
					RESUME_DELAY_MS * args.attempt,
					internal.account.resumeDeletion,
					{ userId: args.userId, attempt: args.attempt + 1 },
				);
			}
		}
	},
});
