import type { GenericQueryCtx } from "convex/server";
import { v } from "convex/values";
import type { DataModel } from "../_generated/dataModel";
import { internalQuery, mutation, query } from "../_generated/server";
import { assertNotDeleting } from "../accountGuard";
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

async function consentForUser(
	ctx: GenericQueryCtx<DataModel>,
	userId: string,
): Promise<AiConsent | null> {
	// Never infer consent from settings.json. Older dev rows can contain an
	// aiConsent key, but settings are client-writable and therefore untrusted.
	const row = await ctx.db
		.query("aiConsents")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.unique();
	return row ? { version: row.version, acceptedAt: row.acceptedAt } : null;
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
		await assertNotDeleting(ctx, userId);
		if (args.version !== AI_CONSENT_VERSION) {
			throw new Error("AI consent version is out of date.");
		}
		const existing = await ctx.db
			.query("aiConsents")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.unique();
		const acceptedAt = Math.max(Date.now(), (existing?.acceptedAt ?? 0) + 1);
		if (existing) {
			await ctx.db.patch(existing._id, {
				version: args.version,
				acceptedAt,
			});
		} else {
			await ctx.db.insert("aiConsents", {
				userId,
				version: args.version,
				acceptedAt,
			});
		}
		return { version: args.version, acceptedAt };
	},
});

export const revoke = mutation({
	args: {},
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		await assertNotDeleting(ctx, userId);
		const consent = await ctx.db
			.query("aiConsents")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.unique();
		if (consent) await ctx.db.delete(consent._id);
		const row = await ctx.db
			.query("settings")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.unique();
		if (!row) return;
		const settings = parseSettings(row.json);
		if (
			!Object.hasOwn(settings, "aiConsent") &&
			!Object.hasOwn(settings, "aiEnabled")
		) {
			return;
		}
		delete settings.aiConsent;
		delete settings.aiEnabled;
		const json = JSON.stringify(settings);
		if (utf8Length(json) > MAX_SETTINGS_BYTES) {
			throw new Error(SETTINGS_TOO_LARGE_MESSAGE);
		}
		await ctx.db.patch(row._id, {
			json,
			updatedAt: Math.max(Date.now(), row.updatedAt + 1),
		});
	},
});
