import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/** Phase 1 — documents; Phase 3 — workspaces. users owned by Better Auth component. */
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

	workspaces: defineTable({
		userId: v.string(),
		paneTree: v.string(),
		openDocumentIds: v.array(v.id("documents")),
		activePaneId: v.string(),
		perPaneViewState: v.string(),
		updatedAt: v.number(),
	}).index("by_user", ["userId"]),

	// Append-only branching undo-tree DAG; nodes are immutable (blueprint 03 §2, 07).
	docNodes: defineTable({
		documentId: v.id("documents"),
		nodeId: v.string(), // client-generated ULID; globally unique
		parentNodeId: v.union(v.string(), v.null()), // null only on the root
		patch: v.string(), // delta of canonical Markdown vs parent's materialized state
		snapshot: v.optional(v.string()), // occasional full snapshot (root + every Nth)
		selection: v.union(
			v.object({ anchor: v.number(), head: v.number() }),
			v.null(),
		),
		origin: v.string(), // device/client id that created the node
		createdAt: v.number(),
	})
		.index("by_document", ["documentId"])
		.index("by_document_node", ["documentId", "nodeId"]),

	// Tagged versions — named references into docNodes (blueprint 03 §2, 08).
	versions: defineTable({
		documentId: v.id("documents"),
		nodeId: v.string(), // the docNodes.nodeId this version points at
		label: v.string(),
		kind: v.union(v.literal("auto"), v.literal("manual")),
		createdAt: v.number(),
	}).index("by_document", ["documentId"]),
});
