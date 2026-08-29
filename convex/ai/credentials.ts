import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import {
	type ActionCtx,
	action,
	internalMutation,
	internalQuery,
	mutation,
	query,
} from "../_generated/server";
import { assertNotDeleting, findTombstone } from "../accountGuard";
import { requireUserId } from "../documents";
import { decryptCredential, encryptCredential } from "./crypto";

const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const OPENROUTER_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";
const OPENROUTER_AUTHORIZE_URL = "https://openrouter.ai/auth";
const MAX_API_KEY_LENGTH = 512;
const MAX_OAUTH_VALUE_LENGTH = 2048;
const CREDENTIAL_KEY_VERSION = 1 as const;
const OAUTH_SESSION_TTL_MS = 10 * 60 * 1000;

export type CredentialSource = "byok" | "house";
export type ResolvedCredential = { apiKey: string; source: CredentialSource };

type CredentialErrorCode =
	| "account_deletion_in_progress"
	| "ai_credential_required"
	| "ai_credential_unreadable"
	| "ai_credentials_unavailable"
	| "ai_provider_unavailable"
	| "invalid_ai_credential"
	| "invalid_argument"
	| "invalid_oauth_code"
	| "invalid_oauth_session"
	| "invalid_provider_response"
	| "unauthenticated";

function credentialError(code: CredentialErrorCode, message: string): never {
	throw new ConvexError({ code, message });
}

function requireEncryptionKey(): string {
	const key = process.env.AI_CREDENTIAL_KEY;
	if (!key) {
		credentialError(
			"ai_credentials_unavailable",
			"AI credential storage is not configured.",
		);
	}
	return key;
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
		credentialError(
			"invalid_ai_credential",
			response.status === 401 || response.status === 403
				? "OpenRouter rejected this API key."
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

async function storeCredential(
	ctx: ActionCtx,
	userId: string,
	apiKey: string,
): Promise<{ provider: "openrouter"; last4: string; updatedAt: number }> {
	const encryptionKey = requireEncryptionKey();
	await validateOpenRouterKey(apiKey);
	const encrypted = await encryptCredential(apiKey, encryptionKey);
	return await ctx.runMutation(internal.ai.credentials.upsertEncrypted, {
		userId,
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
	handler: async (ctx, args) => {
		const userId = await requireActionUserId(ctx);
		return await storeCredential(ctx, userId, normalizeApiKey(args.apiKey));
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
		const encryptionKey = requireEncryptionKey();
		const state = randomToken();
		const verifier = randomToken();
		const [stateHash, codeChallenge, encryptedVerifier] = await Promise.all([
			sha256(state),
			sha256(verifier),
			encryptCredential(verifier, encryptionKey),
		]);
		const expiresAt = Date.now() + OAUTH_SESSION_TTL_MS;
		await ctx.runMutation(internal.ai.credentials.startOAuthSession, {
			userId,
			stateHash,
			verifierCiphertext: encryptedVerifier.ciphertext,
			verifierIv: encryptedVerifier.iv,
			keyVersion: CREDENTIAL_KEY_VERSION,
			expiresAt,
		});
		const authorizeUrl = new URL(OPENROUTER_AUTHORIZE_URL);
		authorizeUrl.searchParams.set("callback_url", callbackUrl);
		authorizeUrl.searchParams.set("code_challenge", codeChallenge);
		authorizeUrl.searchParams.set("code_challenge_method", "S256");
		return { authorizeUrl: authorizeUrl.toString(), state, expiresAt };
	},
});

export const exchangeOAuthCode = action({
	args: { code: v.string(), state: v.string() },
	handler: async (ctx, args) => {
		const userId = await requireActionUserId(ctx);
		if (
			args.code.trim().length === 0 ||
			args.code.length > MAX_OAUTH_VALUE_LENGTH ||
			args.state.length === 0 ||
			args.state.length > MAX_OAUTH_VALUE_LENGTH
		) {
			credentialError("invalid_argument", "Invalid OpenRouter OAuth response.");
		}
		const session = await ctx.runMutation(
			internal.ai.credentials.consumeOAuthSession,
			{ userId, stateHash: await sha256(args.state) },
		);
		if (!session.ok) {
			credentialError(
				"invalid_oauth_session",
				session.reason === "expired"
					? "The OpenRouter authorization expired. Start again."
					: "The OpenRouter authorization is invalid or was already used.",
			);
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
				requireEncryptionKey(),
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
			credentialError(
				"invalid_oauth_code",
				"OpenRouter rejected the authorization response. Start again.",
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
		return await storeCredential(ctx, userId, normalizeApiKey(key));
	},
});

export const remove = mutation({
	args: {},
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		const credential = await ctx.db
			.query("aiCredentials")
			.withIndex("by_user_provider", (q) =>
				q.eq("userId", userId).eq("provider", "openrouter"),
			)
			.unique();
		if (credential) await ctx.db.delete(credential._id);
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

export const upsertEncrypted = internalMutation({
	args: {
		userId: v.string(),
		provider: v.literal("openrouter"),
		ciphertext: v.bytes(),
		iv: v.bytes(),
		keyVersion: v.literal(1),
		last4: v.string(),
	},
	handler: async (ctx, args) => {
		await assertNotDeleting(ctx, args.userId);
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
				provider: args.provider,
				last4: args.last4,
				updatedAt,
			};
		}
		await ctx.db.insert("aiCredentials", {
			...args,
			createdAt: updatedAt,
			updatedAt,
		});
		return { provider: args.provider, last4: args.last4, updatedAt };
	},
});

export const startOAuthSession = internalMutation({
	args: {
		userId: v.string(),
		stateHash: v.string(),
		verifierCiphertext: v.bytes(),
		verifierIv: v.bytes(),
		keyVersion: v.literal(1),
		expiresAt: v.number(),
	},
	handler: async (ctx, args) => {
		await assertNotDeleting(ctx, args.userId);
		const existing = await ctx.db
			.query("aiOAuthSessions")
			.withIndex("by_user", (q) => q.eq("userId", args.userId))
			.collect();
		for (const session of existing) await ctx.db.delete(session._id);
		await ctx.db.insert("aiOAuthSessions", {
			...args,
			createdAt: Date.now(),
		});
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
		try {
			return {
				apiKey: await decryptCredential(
					credential.ciphertext,
					credential.iv,
					requireEncryptionKey(),
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
