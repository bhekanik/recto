import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import {
	type ActionCtx,
	action,
	internalMutation,
	internalQuery,
	type MutationCtx,
	mutation,
	query,
} from "../_generated/server";
import { assertNotDeleting, findTombstone } from "../accountGuard";
import { requireUserId } from "../documents";
import {
	decryptCredential,
	encryptCredential,
	importCredentialKey,
} from "./crypto";

const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const OPENROUTER_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";
const OPENROUTER_AUTHORIZE_URL = "https://openrouter.ai/auth";
const MAX_API_KEY_LENGTH = 512;
const MAX_OAUTH_VALUE_LENGTH = 2048;
const CREDENTIAL_KEY_VERSION = 1 as const;
const OAUTH_SESSION_TTL_MS = 10 * 60 * 1000;

export type CredentialSource = "byok" | "house";
export type ResolvedCredential = { apiKey: string; source: CredentialSource };
type CredentialSaveResult =
	| {
			saved: true;
			provider: "openrouter";
			last4: string;
			updatedAt: number;
	  }
	| { saved: false; superseded: true };
type OAuthSessionConsumeResult =
	| { ok: false; reason: "expired" | "invalid" }
	| {
			ok: true;
			generation: number;
			verifierCiphertext: ArrayBuffer;
			verifierIv: ArrayBuffer;
			keyVersion: 1;
	  };

type CredentialErrorCode =
	| "account_deletion_in_progress"
	| "ai_credential_required"
	| "ai_credential_unreadable"
	| "ai_credentials_unavailable"
	| "ai_provider_unavailable"
	| "credential_intent_superseded"
	| "invalid_ai_credential"
	| "invalid_argument"
	| "invalid_oauth_code"
	| "invalid_oauth_session"
	| "invalid_provider_response"
	| "unauthenticated";

function credentialError(code: CredentialErrorCode, message: string): never {
	throw new ConvexError({ code, message });
}

async function requireEncryptionKey(): Promise<CryptoKey> {
	const encodedKey = process.env.AI_CREDENTIAL_KEY;
	if (!encodedKey) {
		credentialError(
			"ai_credentials_unavailable",
			"AI credential storage is not configured.",
		);
	}
	try {
		return await importCredentialKey(encodedKey);
	} catch {
		credentialError(
			"ai_credentials_unavailable",
			"AI credential storage is not configured correctly.",
		);
	}
}

function normalizeApiKey(value: string): string {
	const key = value.trim();
	if (key.length === 0 || key.length > MAX_API_KEY_LENGTH) {
		credentialError("invalid_ai_credential", "Invalid OpenRouter API key.");
	}
	return key;
}

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function randomToken(): string {
	return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256(value: string): Promise<string> {
	return base64Url(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
		),
	);
}

function requireAllowedCallback(callbackUrl: string): string {
	let normalized: string;
	try {
		normalized = new URL(callbackUrl).toString();
	} catch {
		credentialError("invalid_argument", "Invalid AI OAuth callback URL.");
	}
	const allowed = new Set(
		(process.env.AI_OAUTH_CALLBACK_URLS ?? "")
			.split(",")
			.map((entry) => {
				try {
					return new URL(entry.trim()).toString();
				} catch {
					return "";
				}
			})
			.filter(Boolean),
	);
	if (!allowed.has(normalized)) {
		credentialError(
			"invalid_argument",
			"This AI OAuth callback URL is not allowed.",
		);
	}
	return normalized;
}

async function validateOpenRouterKey(apiKey: string): Promise<void> {
	let response: Response;
	try {
		response = await fetch(OPENROUTER_KEY_URL, {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
	} catch {
		credentialError(
			"ai_provider_unavailable",
			"OpenRouter could not be reached. Try again.",
		);
	}
	if (!response.ok) {
		if (response.status === 401 || response.status === 403) {
			credentialError(
				"invalid_ai_credential",
				"OpenRouter rejected this API key.",
			);
		}
		credentialError(
			"ai_provider_unavailable",
			response.status === 429
				? "OpenRouter is rate-limiting key validation. Try again later."
				: "OpenRouter could not validate this API key. Try again.",
		);
	}
}

async function requireActionUserId(ctx: ActionCtx): Promise<string> {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) credentialError("unauthenticated", "Unauthenticated");
	const active = await ctx.runQuery(internal.ai.credentials.isAccountActive, {
		userId: identity.subject,
	});
	if (!active) {
		credentialError(
			"account_deletion_in_progress",
			"This account is being deleted; no further changes can be saved.",
		);
	}
	return identity.subject;
}

async function commitCredential(
	ctx: ActionCtx,
	userId: string,
	apiKey: string,
	generation: number,
	encryptionKey: CryptoKey,
): Promise<CredentialSaveResult> {
	const encrypted = await encryptCredential(apiKey, encryptionKey);
	return await ctx.runMutation(internal.ai.credentials.commitEncrypted, {
		userId,
		generation,
		provider: "openrouter",
		ciphertext: encrypted.ciphertext,
		iv: encrypted.iv,
		keyVersion: CREDENTIAL_KEY_VERSION,
		last4: apiKey.slice(-4),
	});
}

export const status = query({
	args: {},
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		const credential = await ctx.db
			.query("aiCredentials")
			.withIndex("by_user_provider", (q) =>
				q.eq("userId", userId).eq("provider", "openrouter"),
			)
			.unique();
		return credential
			? {
					configured: true as const,
					provider: credential.provider,
					last4: credential.last4,
					createdAt: credential.createdAt,
					updatedAt: credential.updatedAt,
				}
			: { configured: false as const };
	},
});

export const saveKey = action({
	args: { apiKey: v.string() },
	handler: async (ctx, args): Promise<CredentialSaveResult> => {
		const userId = await requireActionUserId(ctx);
		const encryptionKey = await requireEncryptionKey();
		const generation: number = await ctx.runMutation(
			internal.ai.credentials.claimCredentialIntent,
			{ userId },
		);
		const apiKey = normalizeApiKey(args.apiKey);
		await validateOpenRouterKey(apiKey);
		return await commitCredential(
			ctx,
			userId,
			apiKey,
			generation,
			encryptionKey,
		);
	},
});

export const source = action({
	args: {},
	handler: async (ctx) => {
		const userId = await requireActionUserId(ctx);
		const credential = await resolveCredential(ctx, userId);
		return { source: credential.source };
	},
});

export const beginOAuth = action({
	args: { callbackUrl: v.string() },
	handler: async (ctx, args) => {
		const userId = await requireActionUserId(ctx);
		const callbackUrl = requireAllowedCallback(args.callbackUrl);
		const encryptionKey = await requireEncryptionKey();
		const generation: number = await ctx.runMutation(
			internal.ai.credentials.claimCredentialIntent,
			{ userId },
		);
		const state = randomToken();
		const verifier = randomToken();
		const [stateHash, codeChallenge, encryptedVerifier] = await Promise.all([
			sha256(state),
			sha256(verifier),
			encryptCredential(verifier, encryptionKey),
		]);
		const expiresAt = Date.now() + OAUTH_SESSION_TTL_MS;
		const started: boolean = await ctx.runMutation(
			internal.ai.credentials.startOAuthSession,
			{
				userId,
				generation,
				stateHash,
				verifierCiphertext: encryptedVerifier.ciphertext,
				verifierIv: encryptedVerifier.iv,
				keyVersion: CREDENTIAL_KEY_VERSION,
				expiresAt,
			},
		);
		if (!started) {
			credentialError(
				"credential_intent_superseded",
				"A newer credential change superseded this OpenRouter authorization.",
			);
		}
		const authorizeUrl = new URL(OPENROUTER_AUTHORIZE_URL);
		authorizeUrl.searchParams.set("callback_url", callbackUrl);
		authorizeUrl.searchParams.set("code_challenge", codeChallenge);
		authorizeUrl.searchParams.set("code_challenge_method", "S256");
		return { authorizeUrl: authorizeUrl.toString(), state, expiresAt };
	},
});

export const exchangeOAuthCode = action({
	args: { code: v.string(), state: v.string() },
	handler: async (ctx, args): Promise<CredentialSaveResult> => {
		const userId = await requireActionUserId(ctx);
		if (
			args.code.trim().length === 0 ||
			args.code.length > MAX_OAUTH_VALUE_LENGTH ||
			args.state.length === 0 ||
			args.state.length > MAX_OAUTH_VALUE_LENGTH
		) {
			credentialError("invalid_argument", "Invalid OpenRouter OAuth response.");
		}
		const encryptionKey = await requireEncryptionKey();
		const session: OAuthSessionConsumeResult = await ctx.runMutation(
			internal.ai.credentials.consumeOAuthSession,
			{ userId, stateHash: await sha256(args.state) },
		);
		if (!session.ok) {
			if (session.reason === "expired") {
				credentialError(
					"invalid_oauth_session",
					"The OpenRouter authorization expired. Start again.",
				);
			}
			return { saved: false as const, superseded: true as const };
		}
		if (session.keyVersion !== CREDENTIAL_KEY_VERSION) {
			credentialError(
				"invalid_oauth_session",
				"The OpenRouter authorization uses an unsupported encryption key version.",
			);
		}
		let codeVerifier: string;
		try {
			codeVerifier = await decryptCredential(
				session.verifierCiphertext,
				session.verifierIv,
				encryptionKey,
			);
		} catch {
			credentialError(
				"invalid_oauth_session",
				"The OpenRouter authorization cannot be read. Start again.",
			);
		}
		let response: Response;
		try {
			// OpenRouter's PKCE guide specifies a code/verifier exchange with no
			// bearer header. There is no app secret in this flow.
			response = await fetch(OPENROUTER_EXCHANGE_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					code: args.code,
					code_verifier: codeVerifier,
					code_challenge_method: "S256",
				}),
			});
		} catch {
			credentialError(
				"ai_provider_unavailable",
				"OpenRouter could not be reached. Try again.",
			);
		}
		if (!response.ok) {
			if (response.status === 400 || response.status === 403) {
				credentialError(
					"invalid_oauth_code",
					"OpenRouter rejected the authorization response. Start again.",
				);
			}
			credentialError(
				"ai_provider_unavailable",
				response.status === 429
					? "OpenRouter is rate-limiting authorization. Start again later."
					: "OpenRouter could not complete authorization. Start again later.",
			);
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			credentialError(
				"invalid_provider_response",
				"OpenRouter returned an invalid authorization response.",
			);
		}
		if (body === null || typeof body !== "object") {
			credentialError(
				"invalid_provider_response",
				"OpenRouter returned an invalid authorization response.",
			);
		}
		const key = "key" in body ? body.key : undefined;
		if (typeof key !== "string") {
			credentialError(
				"invalid_provider_response",
				"OpenRouter returned an invalid authorization response.",
			);
		}
		return await commitCredential(
			ctx,
			userId,
			normalizeApiKey(key),
			session.generation,
			encryptionKey,
		);
	},
});

export const remove = mutation({
	args: {},
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		await advanceIntent(ctx, userId);
		const credential = await ctx.db
			.query("aiCredentials")
			.withIndex("by_user_provider", (q) =>
				q.eq("userId", userId).eq("provider", "openrouter"),
			)
			.unique();
		if (credential) await ctx.db.delete(credential._id);
		await deleteOAuthSessions(ctx, userId);
	},
});

export const isAccountActive = internalQuery({
	args: { userId: v.string() },
	handler: async (ctx, args) =>
		(await findTombstone(ctx, args.userId)) === null,
});

export const readForResolution = internalQuery({
	args: { userId: v.string() },
	handler: async (ctx, args): Promise<Doc<"aiCredentials"> | null> =>
		await ctx.db
			.query("aiCredentials")
			.withIndex("by_user_provider", (q) =>
				q.eq("userId", args.userId).eq("provider", "openrouter"),
			)
			.unique(),
});

export const commitEncrypted = internalMutation({
	args: {
		userId: v.string(),
		generation: v.number(),
		provider: v.literal("openrouter"),
		ciphertext: v.bytes(),
		iv: v.bytes(),
		keyVersion: v.literal(1),
		last4: v.string(),
	},
	handler: async (ctx, args) => {
		await assertNotDeleting(ctx, args.userId);
		const intent = await ctx.db
			.query("aiCredentialIntents")
			.withIndex("by_user", (q) => q.eq("userId", args.userId))
			.unique();
		if (intent?.generation !== args.generation) {
			return { saved: false as const, superseded: true as const };
		}
		const existing = await ctx.db
			.query("aiCredentials")
			.withIndex("by_user_provider", (q) =>
				q.eq("userId", args.userId).eq("provider", args.provider),
			)
			.unique();
		const updatedAt = Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1);
		if (existing) {
			await ctx.db.patch(existing._id, {
				ciphertext: args.ciphertext,
				iv: args.iv,
				keyVersion: args.keyVersion,
				last4: args.last4,
				updatedAt,
			});
			return {
				saved: true as const,
				provider: args.provider,
				last4: args.last4,
				updatedAt,
			};
		}
		await ctx.db.insert("aiCredentials", {
			userId: args.userId,
			provider: args.provider,
			ciphertext: args.ciphertext,
			iv: args.iv,
			keyVersion: args.keyVersion,
			last4: args.last4,
			createdAt: updatedAt,
			updatedAt,
		});
		return {
			saved: true as const,
			provider: args.provider,
			last4: args.last4,
			updatedAt,
		};
	},
});

async function advanceIntent(
	ctx: MutationCtx,
	userId: string,
): Promise<number> {
	// Provider calls run outside Convex transactions. This durable generation lets
	// the last user-started credential change reject an older completion.
	const intent = await ctx.db
		.query("aiCredentialIntents")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.unique();
	const generation = (intent?.generation ?? 0) + 1;
	const updatedAt = Math.max(Date.now(), (intent?.updatedAt ?? 0) + 1);
	if (intent) {
		await ctx.db.patch(intent._id, { generation, updatedAt });
	} else {
		await ctx.db.insert("aiCredentialIntents", {
			userId,
			generation,
			updatedAt,
		});
	}
	return generation;
}

async function deleteOAuthSessions(
	ctx: MutationCtx,
	userId: string,
): Promise<void> {
	const sessions = await ctx.db
		.query("aiOAuthSessions")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.collect();
	for (const session of sessions) await ctx.db.delete(session._id);
}

export const claimCredentialIntent = internalMutation({
	args: { userId: v.string() },
	handler: async (ctx, args) => {
		await assertNotDeleting(ctx, args.userId);
		const generation = await advanceIntent(ctx, args.userId);
		await deleteOAuthSessions(ctx, args.userId);
		return generation;
	},
});

export const startOAuthSession = internalMutation({
	args: {
		userId: v.string(),
		generation: v.number(),
		stateHash: v.string(),
		verifierCiphertext: v.bytes(),
		verifierIv: v.bytes(),
		keyVersion: v.literal(1),
		expiresAt: v.number(),
	},
	handler: async (ctx, args) => {
		await assertNotDeleting(ctx, args.userId);
		const intent = await ctx.db
			.query("aiCredentialIntents")
			.withIndex("by_user", (q) => q.eq("userId", args.userId))
			.unique();
		if (intent?.generation !== args.generation) return false;
		await ctx.db.insert("aiOAuthSessions", {
			...args,
			createdAt: Date.now(),
		});
		return true;
	},
});

export const consumeOAuthSession = internalMutation({
	args: { userId: v.string(), stateHash: v.string() },
	handler: async (ctx, args) => {
		await assertNotDeleting(ctx, args.userId);
		const session = await ctx.db
			.query("aiOAuthSessions")
			.withIndex("by_state_hash", (q) => q.eq("stateHash", args.stateHash))
			.unique();
		if (!session || session.userId !== args.userId) {
			return { ok: false as const, reason: "invalid" as const };
		}
		const now = Date.now();
		if (session.expiresAt <= now) {
			await ctx.db.delete(session._id);
			return { ok: false as const, reason: "expired" as const };
		}
		await ctx.db.delete(session._id);
		return {
			ok: true as const,
			generation: session.generation,
			verifierCiphertext: session.verifierCiphertext,
			verifierIv: session.verifierIv,
			keyVersion: session.keyVersion,
		};
	},
});

export async function resolveCredential(
	ctx: ActionCtx,
	userId: string,
): Promise<ResolvedCredential> {
	const credential = await ctx.runQuery(
		internal.ai.credentials.readForResolution,
		{ userId },
	);
	if (credential) {
		if (credential.keyVersion !== CREDENTIAL_KEY_VERSION) {
			credentialError(
				"ai_credential_unreadable",
				"The saved AI credential uses an unsupported encryption key version.",
			);
		}
		const encryptionKey = await requireEncryptionKey();
		try {
			return {
				apiKey: await decryptCredential(
					credential.ciphertext,
					credential.iv,
					encryptionKey,
				),
				source: "byok",
			};
		} catch {
			credentialError(
				"ai_credential_unreadable",
				"The saved AI credential cannot be read. Replace it in Settings.",
			);
		}
	}

	const allowlist = new Set(
		(process.env.AI_UNMETERED_USER_IDS ?? "")
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean),
	);
	const houseKey = process.env.OPENROUTER_API_KEY?.trim();
	if (allowlist.has(userId) && houseKey) {
		return { apiKey: houseKey, source: "house" };
	}
	credentialError(
		"ai_credential_required",
		"Add your own OpenRouter key to use AI.",
	);
}
