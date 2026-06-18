import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUserId } from "./documents";

/**
 * Upsert the caller's daily word total for a local calendar `date`.
 *
 * `words` is a per-day high-water mark: an existing row is only patched when the
 * incoming count is higher, so a later flush with a lower count (the user
 * deleted text) never shrinks the day's recorded total. "Words written" for the
 * streak is monotonic, not the live document count. `updatedAt` always advances.
 */
export const record = mutation({
	args: {
		date: v.string(),
		words: v.number(),
	},
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const updatedAt = Date.now();

		const existing = await ctx.db
			.query("writingStats")
			.withIndex("by_user_date", (q) =>
				q.eq("userId", userId).eq("date", args.date),
			)
			.unique();

		if (existing) {
			await ctx.db.patch(existing._id, {
				words: Math.max(existing.words, args.words),
				updatedAt,
			});
			return { updatedAt };
		}

		await ctx.db.insert("writingStats", {
			userId,
			date: args.date,
			words: args.words,
			updatedAt,
		});

		return { updatedAt };
	},
});

/**
 * Return all daily stat rows for the caller as `{ date, words }`. The client
 * computes the streak and "today's words" — the server does no date math because
 * it cannot know the user's timezone (date keys are local, computed client-side).
 */
export const list = query({
	args: {},
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		const rows = await ctx.db
			.query("writingStats")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.collect();
		return rows.map((row) => ({ date: row.date, words: row.words }));
	},
});
