import type { GroupCommit } from "@/lib/history/grouping";

/**
 * Pure helpers for the reviewer-mode branch controller (plan 010 Phase C).
 *
 * A reviewer's edits append to THEIR OWN shadow branch off the owner's tree and
 * must never advance the owner's pointer. The controller tracks its own branch
 * head client-side; these helpers compute the next branch node and the args for
 * `review.reviewerAppend` from a grouping commit — kept pure so they can be unit
 * tested without a live editor or Convex.
 */

export type ReviewerNode = {
	nodeId: string;
	parentNodeId: string | null;
	patch: string;
	snapshot?: string;
	selection: { anchor: number; head: number } | null;
	origin: string;
	createdAt: number;
};

/**
 * Reparent a grouping commit onto the reviewer's CURRENT branch head. The
 * grouping controller is seeded with the owner's base node as its root, so its
 * first commit's `parentNodeId` is the base; subsequent commits chain off the
 * previous reviewer node. We force `parentNodeId` to the supplied branch head so
 * the reviewer's nodes always form a contiguous branch even across re-seeds.
 */
export function reviewerNodeFromCommit(
	commit: GroupCommit,
	branchHeadNodeId: string,
	reviewerUserId: string,
	createdAt: number,
): ReviewerNode {
	return {
		nodeId: commit.nodeId,
		parentNodeId: branchHeadNodeId,
		patch: commit.patch,
		snapshot: commit.snapshot,
		selection: commit.selection,
		origin: `review:${reviewerUserId}`,
		createdAt,
	};
}

/**
 * The mutation args for `review.reviewerAppend` built from a reviewer node. The
 * server stamps the canonical `review:<userId>` origin itself, so origin is not
 * forwarded — only the append-only node payload + the optional known branch id.
 */
export function appendArgsFromNode(
	documentId: string,
	node: ReviewerNode,
	branchId: string | undefined,
): {
	documentId: string;
	branchId?: string;
	nodeId: string;
	parentNodeId: string;
	patch: string;
	snapshot?: string;
	selection: { anchor: number; head: number } | null;
	createdAt: number;
} {
	return {
		documentId,
		branchId,
		nodeId: node.nodeId,
		parentNodeId: node.parentNodeId ?? "",
		patch: node.patch,
		snapshot: node.snapshot,
		selection: node.selection,
		createdAt: node.createdAt,
	};
}
