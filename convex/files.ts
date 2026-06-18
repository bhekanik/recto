import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUserId } from "./documents";

/**
 * Image (and other blob) storage lives in Convex's built-in `_storage` system
 * table — NOT inline in the Markdown string, whose ~1 MiB ceiling governs the
 * document text only (overview §8). The client uploads bytes to a signed,
 * short-lived URL and inserts a canonical `![alt](url)` reference.
 */

/** Signed, short-lived URL the client POSTs the image bytes to. Auth-gated. */
export const generateUploadUrl = mutation({
	args: {},
	handler: async (ctx) => {
		await requireUserId(ctx); // single-user; only the owner may upload
		return await ctx.storage.generateUploadUrl();
	},
});

/** Resolve a stored file id to a servable URL (null if missing). Auth-gated. */
export const getImageUrl = query({
	args: { storageId: v.id("_storage") },
	handler: async (ctx, args) => {
		await requireUserId(ctx);
		return await ctx.storage.getUrl(args.storageId);
	},
});
