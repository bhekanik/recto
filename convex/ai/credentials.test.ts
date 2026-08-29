import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { MAX_SETTINGS_BYTES } from "../settings";
import { AI_CONSENT_VERSION } from "./consent";

const modules = {
	"./schema.ts": () => import("../schema"),
	"./ai/consent.ts": () => import("./consent"),
	"./ai/credentials.ts": () => import("./credentials"),
	"./ai/crypto.ts": () => import("./crypto"),
	"./accountGuard.ts": () => import("../accountGuard"),
	"./documents.ts": () => import("../documents"),
	"./_generated/api.js": () => import("../_generated/api"),
	"./_generated/server.js": () => import("../_generated/server"),
} satisfies Record<string, () => Promise<unknown>>;

const OWNER = { subject: "owner-user", email: "owner@example.com" };
const OTHER = { subject: "other-user", email: "other@example.com" };
const ENCRYPTION_KEY = btoa("0123456789abcdef0123456789abcdef");
const originalEncryptionKey = process.env.AI_CREDENTIAL_KEY;
const originalCallbacks = process.env.AI_OAUTH_CALLBACK_URLS;
const originalHouseKey = process.env.OPENROUTER_API_KEY;
const originalAllowlist = process.env.AI_UNMETERED_USER_IDS;
const CALLBACK_URL = "https://recto.app/oauth/callback";

beforeEach(() => {
	process.env.AI_CREDENTIAL_KEY = ENCRYPTION_KEY;
	process.env.AI_OAUTH_CALLBACK_URLS = CALLBACK_URL;
});

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalEncryptionKey === undefined) delete process.env.AI_CREDENTIAL_KEY;
	else process.env.AI_CREDENTIAL_KEY = originalEncryptionKey;
	if (originalCallbacks === undefined)
		delete process.env.AI_OAUTH_CALLBACK_URLS;
	else process.env.AI_OAUTH_CALLBACK_URLS = originalCallbacks;
	if (originalHouseKey === undefined) delete process.env.OPENROUTER_API_KEY;
	else process.env.OPENROUTER_API_KEY = originalHouseKey;
	if (originalAllowlist === undefined) delete process.env.AI_UNMETERED_USER_IDS;
	else process.env.AI_UNMETERED_USER_IDS = originalAllowlist;
});

describe("OpenRouter credentials", () => {
	it("validates, encrypts and replaces a pasted key", async () => {
		const fetch = vi.fn(async () => Response.json({ data: { limit: null } }));
		vi.stubGlobal("fetch", fetch);
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);

		const firstResult = await owner.action(api.ai.credentials.saveKey, {
			apiKey: "sk-or-v1-first-key",
		});
		expect(firstResult).not.toHaveProperty("apiKey");
		await owner.action(api.ai.credentials.saveKey, {
			apiKey: "sk-or-v1-second-key",
		});

		expect(fetch).toHaveBeenCalledTimes(2);
		expect(await owner.query(api.ai.credentials.status, {})).toMatchObject({
			configured: true,
			provider: "openrouter",
			last4: "-key",
		});
		const rows = await t.run((ctx) => ctx.db.query("aiCredentials").collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]?.keyVersion).toBe(1);
		expect(new TextDecoder().decode(rows[0]?.ciphertext)).not.toContain(
			"second-key",
		);

		await owner.mutation(api.ai.credentials.remove, {});
		expect(await owner.query(api.ai.credentials.status, {})).toEqual({
			configured: false,
		});
	});

	it("isolates credential metadata and removal by tenant", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({})),
		);
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const other = t.withIdentity(OTHER);
		await owner.action(api.ai.credentials.saveKey, {
			apiKey: "sk-or-v1-owner-secret",
		});

		expect(await other.query(api.ai.credentials.status, {})).toEqual({
			configured: false,
		});
		await other.mutation(api.ai.credentials.remove, {});
		expect(await owner.query(api.ai.credentials.status, {})).toMatchObject({
			configured: true,
			last4: "cret",
		});
	});

	it("resolves BYOK before the allowlisted house key without returning either", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({})),
		);
		process.env.OPENROUTER_API_KEY = "house-secret";
		process.env.AI_UNMETERED_USER_IDS = OWNER.subject;
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		await owner.action(api.ai.credentials.saveKey, { apiKey: "byok-secret" });

		const result = await owner.action(api.ai.credentials.source, {});
		expect(result).toEqual({ source: "byok" });
		expect(result).not.toHaveProperty("apiKey");
	});

	it("allows the house key only for allowlisted users", async () => {
		process.env.OPENROUTER_API_KEY = "house-secret";
		process.env.AI_UNMETERED_USER_IDS = OWNER.subject;
		const t = convexTest(schema, modules);

		expect(
			await t.withIdentity(OWNER).action(api.ai.credentials.source, {}),
		).toEqual({ source: "house" });
		await expect(
			t.withIdentity(OTHER).action(api.ai.credentials.source, {}),
		).rejects.toThrow("Add your own OpenRouter key");
	});

	it("rejects an unknown OAuth state before contacting OpenRouter", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const t = convexTest(schema, modules);

		expect(
			await t.withIdentity(OWNER).action(api.ai.credentials.exchangeOAuthCode, {
				code: "one-time-code",
				state: "unknown-state",
			}),
		).toEqual({ saved: false, superseded: true });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("exchanges an S256 PKCE code and stores only the encrypted key", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ key: "sk-or-v1-oauth-key" }))
			.mockResolvedValueOnce(Response.json({ data: { limit: null } }));
		vi.stubGlobal("fetch", fetch);
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const flow = await owner.action(api.ai.credentials.beginOAuth, {
			callbackUrl: CALLBACK_URL,
		});
		const authorizeUrl = new URL(flow.authorizeUrl);
		expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
			"https://openrouter.ai/auth",
		);
		expect(authorizeUrl.searchParams.get("callback_url")).toBe(CALLBACK_URL);
		expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
		const sessions = await t.run((ctx) =>
			ctx.db.query("aiOAuthSessions").collect(),
		);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.stateHash).not.toBe(flow.state);
		expect(sessions[0]?.keyVersion).toBe(1);
		expect(JSON.stringify(sessions[0])).not.toContain(flow.state);

		await owner.action(api.ai.credentials.exchangeOAuthCode, {
			code: "one-time-code",
			state: flow.state,
		});

		// SAFETY: this call is made by the tested action with a RequestInit body.
		const exchangeInit = fetch.mock.calls[0]?.[1] as RequestInit;
		// SAFETY: the action serializes this fixed OpenRouter request contract.
		const exchangeBody = JSON.parse(String(exchangeInit.body)) as {
			code: string;
			code_verifier: string;
			code_challenge_method: string;
		};
		expect(fetch.mock.calls[0]?.[0]).toBe(
			"https://openrouter.ai/api/v1/auth/keys",
		);
		expect(exchangeBody).toMatchObject({
			code: "one-time-code",
			code_challenge_method: "S256",
		});
		const challenge = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(exchangeBody.code_verifier),
		);
		const encodedChallenge = btoa(
			String.fromCharCode(...new Uint8Array(challenge)),
		)
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replace(/=+$/, "");
		expect(encodedChallenge).toBe(
			authorizeUrl.searchParams.get("code_challenge"),
		);
		expect(fetch).toHaveBeenNthCalledWith(
			2,
			"https://openrouter.ai/api/v1/key",
			expect.objectContaining({
				headers: { Authorization: "Bearer sk-or-v1-oauth-key" },
			}),
		);
	});

	it("consumes an OAuth state before exchange to prevent replay", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ key: "sk-or-v1-oauth-key" }))
			.mockResolvedValueOnce(Response.json({}));
		vi.stubGlobal("fetch", fetch);
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const flow = await owner.action(api.ai.credentials.beginOAuth, {
			callbackUrl: CALLBACK_URL,
		});
		await owner.action(api.ai.credentials.exchangeOAuthCode, {
			code: "one-time-code",
			state: flow.state,
		});

		expect(
			await owner.action(api.ai.credentials.exchangeOAuthCode, {
				code: "one-time-code",
				state: flow.state,
			}),
		).toEqual({ saved: false, superseded: true });
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(
			await t.run((ctx) => ctx.db.query("aiOAuthSessions").collect()),
		).toHaveLength(0);
	});

	it("does not let another tenant consume an OAuth state", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const flow = await owner.action(api.ai.credentials.beginOAuth, {
			callbackUrl: CALLBACK_URL,
		});

		expect(
			await t.withIdentity(OTHER).action(api.ai.credentials.exchangeOAuthCode, {
				code: "one-time-code",
				state: flow.state,
			}),
		).toEqual({ saved: false, superseded: true });
		expect(fetch).not.toHaveBeenCalled();
		const session = await t.run((ctx) =>
			ctx.db.query("aiOAuthSessions").unique(),
		);
		expect(session).not.toBeNull();
	});

	it("expires server-owned OAuth sessions after ten minutes", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const flow = await owner.action(api.ai.credentials.beginOAuth, {
			callbackUrl: CALLBACK_URL,
		});
		await t.run(async (ctx) => {
			const session = await ctx.db.query("aiOAuthSessions").unique();
			if (session)
				await ctx.db.patch(session._id, { expiresAt: Date.now() - 1 });
		});

		await expect(
			owner.action(api.ai.credentials.exchangeOAuthCode, {
				code: "one-time-code",
				state: flow.state,
			}),
		).rejects.toThrow("authorization expired");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects callback URLs outside the deployment allowlist", async () => {
		const t = convexTest(schema, modules);
		await expect(
			t.withIdentity(OWNER).action(api.ai.credentials.beginOAuth, {
				callbackUrl: "https://attacker.example/callback",
			}),
		).rejects.toThrow("callback URL is not allowed");
		expect(
			await t.run((ctx) => ctx.db.query("aiOAuthSessions").collect()),
		).toHaveLength(0);
	});

	it("does not replace a saved key when OpenRouter rejects the new one", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(Response.json({}, { status: 200 }))
			.mockResolvedValueOnce(Response.json({}, { status: 401 }));
		vi.stubGlobal("fetch", fetch);
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		await owner.action(api.ai.credentials.saveKey, { apiKey: "first-key" });

		await expect(
			owner.action(api.ai.credentials.saveKey, { apiKey: "rejected-key" }),
		).rejects.toThrow("OpenRouter rejected this API key");
		expect(await owner.query(api.ai.credentials.status, {})).toMatchObject({
			configured: true,
			last4: "-key",
		});
	});

	it.each([
		429, 503,
	])("classifies provider status %i as retryable", async (status) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({}, { status })),
		);
		const t = convexTest(schema, modules);

		await expect(
			t.withIdentity(OWNER).action(api.ai.credentials.saveKey, {
				apiKey: "otherwise-valid-secret",
			}),
		).rejects.toMatchObject({
			data: { code: "ai_provider_unavailable" },
		});
	});

	it("does not let delayed OAuth preparation recreate a removed session", async () => {
		const t = convexTest(schema, modules);
		const user = t.withIdentity(OWNER);
		const generation = await t.mutation(
			internal.ai.credentials.claimCredentialIntent,
			{ userId: OWNER.subject },
		);

		await user.mutation(api.ai.credentials.remove, {});
		expect(
			await t.mutation(internal.ai.credentials.startOAuthSession, {
				userId: OWNER.subject,
				generation,
				stateHash: "delayed-state",
				verifierCiphertext: new Uint8Array([1]).buffer,
				verifierIv: new Uint8Array(12).buffer,
				keyVersion: 1,
				expiresAt: Date.now() + 60_000,
			}),
		).toBe(false);
		expect(
			await t.run((ctx) => ctx.db.query("aiOAuthSessions").collect()),
		).toHaveLength(0);
	});

	it("does not let in-flight pasted-key validation undo removal", async () => {
		const validation = Promise.withResolvers<Response>();
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(Response.json({}))
			.mockImplementationOnce(() => validation.promise);
		vi.stubGlobal("fetch", fetch);
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		await owner.action(api.ai.credentials.saveKey, { apiKey: "first-secret" });

		const replacement = owner.action(api.ai.credentials.saveKey, {
			apiKey: "replacement-secret",
		});
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		await owner.mutation(api.ai.credentials.remove, {});
		validation.resolve(Response.json({}));
		expect(await replacement).toEqual({ saved: false, superseded: true });
		expect(await owner.query(api.ai.credentials.status, {})).toEqual({
			configured: false,
		});
	});

	it("does not let an in-flight OAuth exchange undo removal", async () => {
		const exchangeResponse = Promise.withResolvers<Response>();
		const fetch = vi
			.fn()
			.mockImplementationOnce(() => exchangeResponse.promise)
			.mockResolvedValueOnce(Response.json({}));
		vi.stubGlobal("fetch", fetch);
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const flow = await owner.action(api.ai.credentials.beginOAuth, {
			callbackUrl: CALLBACK_URL,
		});

		const exchange = owner.action(api.ai.credentials.exchangeOAuthCode, {
			code: "in-flight-code",
			state: flow.state,
		});
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		await owner.mutation(api.ai.credentials.remove, {});
		exchangeResponse.resolve(Response.json({ key: "oauth-secret" }));
		expect(await exchange).toEqual({ saved: false, superseded: true });
		expect(await owner.query(api.ai.credentials.status, {})).toEqual({
			configured: false,
		});
	});

	it("does not let an older OAuth flow resurrect a removed credential", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({})),
		);
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		await owner.action(api.ai.credentials.saveKey, { apiKey: "pasted-secret" });
		const flow = await owner.action(api.ai.credentials.beginOAuth, {
			callbackUrl: CALLBACK_URL,
		});
		await owner.mutation(api.ai.credentials.remove, {});

		expect(
			await owner.action(api.ai.credentials.exchangeOAuthCode, {
				code: "stale-code",
				state: flow.state,
			}),
		).toEqual({ saved: false, superseded: true });
		expect(await owner.query(api.ai.credentials.status, {})).toEqual({
			configured: false,
		});
	});

	it("does not let an older OAuth flow overwrite a newer pasted key", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({})),
		);
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const flow = await owner.action(api.ai.credentials.beginOAuth, {
			callbackUrl: CALLBACK_URL,
		});
		await owner.action(api.ai.credentials.saveKey, { apiKey: "pasted-newer" });

		expect(
			await owner.action(api.ai.credentials.exchangeOAuthCode, {
				code: "stale-code",
				state: flow.state,
			}),
		).toEqual({ saved: false, superseded: true });
		expect(await owner.query(api.ai.credentials.status, {})).toMatchObject({
			configured: true,
			last4: "ewer",
		});
	});

	it("makes the last-started pasted-key intent win across concurrent callers", async () => {
		const firstValidation = Promise.withResolvers<Response>();
		const fetch = vi
			.fn()
			.mockImplementationOnce(() => firstValidation.promise)
			.mockResolvedValueOnce(Response.json({}));
		vi.stubGlobal("fetch", fetch);
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const first = owner.action(api.ai.credentials.saveKey, {
			apiKey: "first-started",
		});
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		await owner.action(api.ai.credentials.saveKey, {
			apiKey: "second-started",
		});
		firstValidation.resolve(Response.json({}));

		expect(await first).toEqual({ saved: false, superseded: true });
		expect(await owner.query(api.ai.credentials.status, {})).toMatchObject({
			configured: true,
			last4: "rted",
		});
	});

	it("refuses writes after account deletion starts", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({})),
		);
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("accountDeletions", {
				userId: OWNER.subject,
				startedAt: now,
				updatedAt: now,
				phase: "rows",
			});
		});

		await expect(
			t
				.withIdentity(OWNER)
				.action(api.ai.credentials.saveKey, { apiKey: "sk-or-key" }),
		).rejects.toThrow("This account is being deleted");
	});
});

describe("AI consent", () => {
	it("merges versioned consent into synced settings", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert("settings", {
				userId: OWNER.subject,
				json: JSON.stringify({ theme: "twilight", futureSetting: 42 }),
				updatedAt: 1,
			});
		});
		const owner = t.withIdentity(OWNER);

		const accepted = await owner.mutation(api.ai.consent.accept, {
			version: AI_CONSENT_VERSION,
		});
		expect(await owner.query(api.ai.consent.get, {})).toEqual({
			version: AI_CONSENT_VERSION,
			acceptedAt: accepted.acceptedAt,
		});
		const row = await t.run((ctx) => ctx.db.query("settings").unique());
		expect(JSON.parse(row?.json ?? "{}")).toEqual({
			theme: "twilight",
			futureSetting: 42,
			aiConsent: accepted,
		});
	});

	it("treats old consent as unaccepted and rejects stale acceptance", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);

		await expect(
			owner.mutation(api.ai.consent.accept, {
				version: AI_CONSENT_VERSION + 1,
			}),
		).rejects.toThrow("AI consent version is out of date");
		expect(await owner.query(api.ai.consent.get, {})).toEqual({
			version: AI_CONSENT_VERSION,
			acceptedAt: null,
		});
	});

	it("revokes consent and disables AI without dropping other settings", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		await owner.mutation(api.ai.consent.accept, {
			version: AI_CONSENT_VERSION,
		});
		await owner.mutation(api.ai.consent.revoke, {});

		const row = await t.run((ctx) => ctx.db.query("settings").unique());
		expect(JSON.parse(row?.json ?? "{}")).toEqual({});
		expect(await owner.query(api.ai.consent.get, {})).toEqual({
			version: AI_CONSENT_VERSION,
			acceptedAt: null,
		});
	});

	it("does not grow settings beyond the 64 KiB ceiling on revoke", async () => {
		const t = convexTest(schema, modules);
		const json = JSON.stringify({
			filler: "x".repeat(MAX_SETTINGS_BYTES - 13),
		});
		expect(new TextEncoder().encode(json)).toHaveLength(MAX_SETTINGS_BYTES);
		await t.run(async (ctx) => {
			await ctx.db.insert("settings", {
				userId: OWNER.subject,
				json,
				updatedAt: 1,
			});
		});

		await t.withIdentity(OWNER).mutation(api.ai.consent.revoke, {});
		const row = await t.run((ctx) => ctx.db.query("settings").unique());
		expect(new TextEncoder().encode(row?.json ?? "")).toHaveLength(
			MAX_SETTINGS_BYTES,
		);
	});
});
