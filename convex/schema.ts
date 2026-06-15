import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/** Phase 1 — documents table only. users owned by Better Auth component. */
export default defineSchema({
	documents: defineTable({
		userId: v.string(),
		title: v.string(),
		markdown: v.string(),
		wordCount: v.number(),
		currentNodeId: v.string(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_user", ["userId"])
		.index("by_user_updated", ["userId", "updatedAt"]),
});
