import type { GenericQueryCtx } from "convex/server";
import { v } from "convex/values";
import type { DataModel } from "../_generated/dataModel";
import { internalQuery, mutation, query } from "../_generated/server";
import { requireUserId, utf8Length } from "../documents";
import { MAX_SETTINGS_BYTES, SETTINGS_TOO_LARGE_MESSAGE } from "../settings";

export const AI_CONSENT_VERSION = 1;

type AiConsent = { version: number; acceptedAt: number };

function parseSettings(json: string | undefined): Record<string, unknown> {
	if (json === undefined) return {};
	try {
		const value: unknown = JSON.parse(json);
		return value !== null && typeof value === "object" && !Array.isArray(value)
			? { ...value }
			: {};
	} catch {
		return {};
	}
}

function readConsent(value: unknown): AiConsent | null {
	if (value === null || typeof value !== "object") return null;
	const version = "version" in value ? value.version : undefined;
	const acceptedAt = "acceptedAt" in value ? value.acceptedAt : undefined;
	return typeof version === "number" &&
		Number.isInteger(version) &&
		typeof acceptedAt === "number" &&
		Number.isFinite(acceptedAt)
		? { version, acceptedAt }
		: null;
}

async function consentForUser(
	ctx: GenericQueryCtx<DataModel>,
	userId: string,
): Promise<AiConsent | null> {
	const row = await ctx.db
		.query("settings")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.unique();
	return readConsent(parseSettings(row?.json).aiConsent);
}

export const get = query({
	args: {},
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		const consent = await consentForUser(ctx, userId);
		return {
			version: AI_CONSENT_VERSION,
			acceptedAt:
				consent?.version === AI_CONSENT_VERSION ? consent.acceptedAt : null,
		};
	},
});

export const getForUser = internalQuery({
	args: { userId: v.string() },
	handler: async (ctx, args) => await consentForUser(ctx, args.userId),
});

export const accept = mutation({
	args: { version: v.number() },
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		if (args.version !== AI_CONSENT_VERSION) {
			throw new Error("AI consent version is out of date.");
		}
		const row = await ctx.db
			.query("settings")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.unique();
		const settings = parseSettings(row?.json);
		const acceptedAt = Date.now();
		settings.aiConsent = { version: args.version, acceptedAt };
		const json = JSON.stringify(settings);
		if (utf8Length(json) > MAX_SETTINGS_BYTES) {
			throw new Error(SETTINGS_TOO_LARGE_MESSAGE);
		}
		const updatedAt = Math.max(acceptedAt, (row?.updatedAt ?? 0) + 1);
		if (row) {
			await ctx.db.patch(row._id, {
				json,
				updatedAt,
			});
		} else {
			await ctx.db.insert("settings", {
				userId,
				json,
				updatedAt,
			});
		}
		return { version: args.version, acceptedAt };
	},
});

export const revoke = mutation({
	args: {},
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		const row = await ctx.db
			.query("settings")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.unique();
		if (!row) return;
		const settings = parseSettings(row.json);
		delete settings.aiConsent;
		delete settings.aiEnabled;
		const json = JSON.stringify(settings);
		if (json === row.json) return;
		if (utf8Length(json) > MAX_SETTINGS_BYTES) {
			throw new Error(SETTINGS_TOO_LARGE_MESSAGE);
		}
		await ctx.db.patch(row._id, {
			json,
			updatedAt: Math.max(Date.now(), row.updatedAt + 1),
		});
	},
});
