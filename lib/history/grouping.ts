import { computePatch, encodePatch, SNAPSHOT_EVERY_N } from "./patch";
import { ulid } from "./ulid";

/** ~500ms time-gap coalescing, matching the engines' newGroupDelay (07 §4). */
export const GROUP_DELAY_MS = 500;

/**
 * Longest a single draft may absorb changes before it is cut into a node,
 * matching the autosave maxWait. A writer who never pauses for 500ms otherwise
 * produces no nodes at all: their text lives only in `documents.markdown`, so a
 * head divergence has nothing to turn into a branch and the work is device-only
 * until they stop typing.
 */
export const MAX_GROUP_MS = 5_000;

export type NodeSelection = { anchor: number; head: number } | null;

/** One committed undo-tree node, ready to persist + advance the pointer. */
export type GroupCommit = {
	nodeId: string;
	parentNodeId: string;
	patch: string;
	snapshot?: string;
	selection: NodeSelection;
	/** The full materialized markdown of this node (for the pointer/markdown write). */
	markdown: string;
};

type RecordOptions = {
	/** A structural/semantic boundary: paste, block change, mode switch. */
	structural?: boolean;
};

/**
 * Model-level grouping engine (blueprint 07 §4). Keystroke-level changes coalesce
 * into one draft node; a node boundary is committed when any of these fire:
 *   1. a >~500ms typing pause (idle),
 *   2. an adjacency break (the edit jumped to a different region),
 *   3. a structural/semantic boundary (paste, block change, mode switch).
 * Selection-only moves never commit a node. One policy for every lens.
 *
 * Time and commits are injected so the engine is deterministic and unit-testable.
 */
export class GroupingController {
	private parentNodeId: string;
	private parentMarkdown: string;
	private draftMarkdown: string;
	private draftSelection: NodeSelection = null;
	private lastChangeAt = 0;
	private lastChangeEnd = -1;
	/** When the current draft first diverged from its parent; -1 when clean. */
	private draftStartedAt = -1;
	private depthSinceSnapshot: number;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;

	private readonly onCommit: (commit: GroupCommit) => void;
	private readonly now: () => number;
	private readonly schedule: boolean;

	constructor(opts: {
		rootNodeId: string;
		rootMarkdown: string;
		onCommit: (commit: GroupCommit) => void;
		/** Depth below the last snapshot, so cadence survives a reload. */
		depthSinceSnapshot?: number;
		/** Injected clock (defaults to performance.now). */
		now?: () => number;
		/** Whether to arm the idle timer (off in tests; drive via tick()). */
		schedule?: boolean;
	}) {
		this.parentNodeId = opts.rootNodeId;
		this.parentMarkdown = opts.rootMarkdown;
		this.draftMarkdown = opts.rootMarkdown;
		this.onCommit = opts.onCommit;
		this.depthSinceSnapshot = opts.depthSinceSnapshot ?? 0;
		this.now = opts.now ?? (() => performance.now());
		this.schedule = opts.schedule ?? true;
	}

	get currentNodeId(): string {
		return this.parentNodeId;
	}

	/**
	 * Whether local input exists that no node has captured yet. Callers use this
	 * to avoid re-projecting remote state over text the writer just produced.
	 */
	get hasPendingDraft(): boolean {
		return this.draftMarkdown !== this.parentMarkdown;
	}

	/** Reposition the controller after a navigation/restore (no commit). */
	setCurrent(nodeId: string, markdown: string, depthSinceSnapshot = 0): void {
		this.cancelIdle();
		this.parentNodeId = nodeId;
		this.parentMarkdown = markdown;
		this.draftMarkdown = markdown;
		this.draftSelection = null;
		this.lastChangeAt = 0;
		this.lastChangeEnd = -1;
		this.draftStartedAt = -1;
		this.depthSinceSnapshot = depthSinceSnapshot;
	}

	/** Feed a canonical-markdown change from any lens. */
	record(
		markdown: string,
		selection: NodeSelection,
		opts: RecordOptions = {},
	): void {
		// Selection-only move: update the pending caret, never commit (07 §4.4).
		if (markdown === this.draftMarkdown) {
			this.draftSelection = selection;
			return;
		}

		const now = this.now();
		const incremental = computePatch(this.draftMarkdown, markdown);
		const gap = this.lastChangeAt > 0 ? now - this.lastChangeAt : 0;
		const adjacencyBreak =
			this.lastChangeEnd >= 0 &&
			this.draftMarkdown !== this.parentMarkdown &&
			Math.abs(incremental.from - this.lastChangeEnd) > 1;

		const draftAge = this.draftStartedAt >= 0 ? now - this.draftStartedAt : 0;
		const boundaryBefore =
			gap > GROUP_DELAY_MS ||
			adjacencyBreak ||
			draftAge > MAX_GROUP_MS ||
			Boolean(opts.structural);

		if (boundaryBefore && this.draftMarkdown !== this.parentMarkdown) {
			this.commitDraft();
		}

		if (this.draftMarkdown === this.parentMarkdown) this.draftStartedAt = now;
		this.draftMarkdown = markdown;
		this.draftSelection = selection;
		this.lastChangeAt = now;
		this.lastChangeEnd = incremental.from + incremental.insert.length;

		if (opts.structural) {
			// A structural edit is its own node — commit immediately.
			this.commitDraft();
		} else if (this.schedule) {
			this.armIdle();
		}
	}

	/** Idle elapsed (called by the armed timer, or by tests). */
	tick(): void {
		if (this.draftMarkdown !== this.parentMarkdown) this.commitDraft();
	}

	/** Force-commit any pending draft (mode switch, blur, before navigate/persist). */
	flush(): void {
		this.cancelIdle();
		this.tick();
	}

	private commitDraft(): void {
		this.cancelIdle();
		if (this.draftMarkdown === this.parentMarkdown) return;

		const patch = encodePatch(
			computePatch(this.parentMarkdown, this.draftMarkdown),
		);
		this.depthSinceSnapshot += 1;
		const takeSnapshot = this.depthSinceSnapshot >= SNAPSHOT_EVERY_N;
		const snapshot = takeSnapshot ? this.draftMarkdown : undefined;
		if (takeSnapshot) this.depthSinceSnapshot = 0;

		const commit: GroupCommit = {
			nodeId: ulid(),
			parentNodeId: this.parentNodeId,
			patch,
			snapshot,
			selection: this.draftSelection,
			markdown: this.draftMarkdown,
		};

		this.parentNodeId = commit.nodeId;
		this.parentMarkdown = this.draftMarkdown;
		this.lastChangeEnd = -1;
		this.draftStartedAt = -1;
		this.onCommit(commit);
	}

	private armIdle(): void {
		this.cancelIdle();
		this.idleTimer = setTimeout(() => {
			this.idleTimer = null;
			this.tick();
		}, GROUP_DELAY_MS);
	}

	private cancelIdle(): void {
		if (this.idleTimer !== null) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
	}

	dispose(): void {
		this.cancelIdle();
	}
}
