import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/** Throwaway Phase 0 spike schema — subset of canon contract. */
export default defineSchema({
	documents: defineTable({
		markdown: v.string(),
		currentNodeId: v.string(),
		updatedAt: v.number(),
	}),

	docNodes: defineTable({
		documentId: v.id("documents"),
		nodeId: v.string(),
		parentNodeId: v.union(v.string(), v.null()),
		patch: v.string(),
		snapshot: v.optional(v.string()),
		selection: v.union(
			v.object({ anchor: v.number(), head: v.number() }),
			v.null(),
		),
		origin: v.string(),
		createdAt: v.number(),
	})
		.index("by_document", ["documentId"])
		.index("by_document_node", ["documentId", "nodeId"]),
});
