import { internal } from "./_generated/api";
import { action } from "./_generated/server";

/**
 * In-app account deletion (plan 023 §4.1(4); App Store guideline 5.1.1(v),
 * which requires an in-app path that deletes the account itself, not just its
 * data, and not a "email us to delete" link).
 *
 * Shape of the operation:
 *
 *  1. blobs the user's documents reference,
 *  2. every row keyed to the user, in bounded batches,
 *  3. the Clerk user, LAST.
 *
 * Clerk goes last on purpose. Every step before it is idempotent, so a failure
 * anywhere leaves an account that can still sign in and press the button again;
 * deleting the identity first would strand the data with nobody able to reach
 * it. The cost is that a caller who dies between step 2 and step 3 leaves an
 * empty-but-live account — recoverable, which the other order is not.
 */

const CLERK_API_BASE = "https://api.clerk.com/v1";

/** Bound on purge rounds, so a bug cannot spin an action until it is killed. */
const MAX_PURGE_PASSES = 500;

export const ACCOUNT_DELETION_UNAVAILABLE_MESSAGE =
	"Account deletion is not configured on this deployment (CLERK_SECRET_KEY is missing). No data was deleted.";

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

const MISSING_APPLE_CREDENTIALS =
	"An Apple external account exists, but Apple-side revocation was not attempted: this deployment holds no Apple signing credentials (Team ID, Services ID, Key ID, .p8 key) and Clerk exposes no Apple refresh token, both of which TN3194's /auth/revoke call needs. Deleting the Clerk user does not revoke on Apple's side. Ask the user to remove the app under Settings > Apple Account > Sign in with Apple until this is wired up.";

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

export const deleteEverything = action({
	args: {},
	handler: async (
		ctx,
	): Promise<{
		userId: string;
		rowsDeleted: number;
		blobsDeleted: number;
		clerkUserDeleted: boolean;
		appleRevocation: AppleRevocation;
	}> => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw new Error("Unauthenticated");

		// Checked BEFORE anything is deleted. Without it the data would go and the
		// login would survive, which is the one outcome guideline 5.1.1(v) is
		// about; better to refuse while everything is still intact.
		const secret = process.env.CLERK_SECRET_KEY;
		if (!secret) throw new Error(ACCOUNT_DELETION_UNAVAILABLE_MESSAGE);

		const userId = identity.subject;
		const granteeEmail =
			typeof identity.email === "string" ? identity.email : undefined;

		const blobs = await drain(() =>
			ctx.runMutation(internal.accountPurge.purgeStorage, { userId }),
		);
		const blobsDeleted = blobs.deleted;

		const rows = await drain(() =>
			ctx.runMutation(internal.accountPurge.purgeData, {
				userId,
				granteeEmail,
			}),
		);
		const rowsDeleted = rows.deleted;
		if (!rows.done) {
			// Deliberately before the Clerk delete: the account must stay reachable
			// so the user (or support) can run this again and finish it.
			throw new Error(
				`Account data purge did not finish in ${MAX_PURGE_PASSES} passes (${rowsDeleted} rows deleted). Run it again to continue.`,
			);
		}

		const appleRevocation = await checkAppleRevocation(secret, userId);

		const deleteResponse = await clerkRequest(secret, `/users/${userId}`, {
			method: "DELETE",
		});
		// 404 means a previous attempt already removed the user — that is this
		// action succeeding twice, not failing.
		if (!deleteResponse.ok && deleteResponse.status !== 404) {
			throw new Error(
				`Data was deleted, but Clerk refused to delete the user (HTTP ${deleteResponse.status}). Sign in and try again.`,
			);
		}

		return {
			userId,
			rowsDeleted,
			blobsDeleted,
			clerkUserDeleted: true,
			appleRevocation,
		};
	},
});
