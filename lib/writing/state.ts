import { type DocNode, materialize } from "@/lib/history/materialize";
import { computePatch, decodePatch, type TextPatch } from "@/lib/history/patch";

/**
 * Working material attached to a draft's text, as the Mac stores it on history
 * nodes (`RectoHistory/WritingState.swift`): alternatives and ghosts, in
 * UTF-16 offsets of the node's Markdown. Field names match the Swift encoding
 * so either side reads the other's state.
 */
export type AlternativeCandidate = {
	id: string;
	text: string;
	author: "human" | "ai";
};

export type AlternativeGroup = {
	id: string;
	scope: "word" | "sentence" | "paragraph";
	location: number;
	length: number;
	candidates: AlternativeCandidate[];
	activeId: string;
	detached: boolean;
};

export type GhostSpan = { id: string; location: number; length: number };

export type WritingState = {
	version: number;
	alternatives: AlternativeGroup[];
	ghosts: GhostSpan[];
};

export const WRITING_STATE_VERSION = 1;

export function emptyWritingState(): WritingState {
	return { version: WRITING_STATE_VERSION, alternatives: [], ghosts: [] };
}

/** A state from a newer client is treated as absent rather than misread. */
export function decodeWritingState(raw: string): WritingState | null {
	try {
		const parsed = JSON.parse(raw) as Partial<WritingState>;
		if (parsed.version !== WRITING_STATE_VERSION) return null;
		return {
			version: WRITING_STATE_VERSION,
			alternatives: Array.isArray(parsed.alternatives)
				? parsed.alternatives
				: [],
			ghosts: Array.isArray(parsed.ghosts) ? parsed.ghosts : [],
		};
	} catch {
		return null;
	}
}

/**
 * The state after `patch` turned the parent's text into `markdown`. Insertions
 * at a passage's edges stay outside it; an edit inside it edits the wording on
 * show; an edit across an edge detaches it. Ghosts keep what an edit left.
 */
export function mapWritingState(
	state: WritingState,
	patch: TextPatch,
	markdown: string,
): WritingState {
	const delta = patch.insert.length - (patch.to - patch.from);
	const alternatives = state.alternatives.map((original) => {
		if (original.detached) return original;
		const group: AlternativeGroup = {
			...original,
			candidates: original.candidates.map((candidate) => ({ ...candidate })),
		};
		const start = group.location;
		const end = group.location + group.length;
		if (patch.to <= start) {
			group.location += delta;
		} else if (patch.from >= end) {
			// After the passage: untouched.
		} else if (patch.from >= start && patch.to <= end) {
			group.length += delta;
			const active = group.candidates.find((c) => c.id === group.activeId);
			if (group.length === 0 || !active) {
				group.detached = true;
			} else {
				active.text = markdown.slice(
					group.location,
					group.location + group.length,
				);
			}
		} else {
			group.detached = true;
		}
		return group;
	});
	const ghosts: GhostSpan[] = [];
	for (const original of state.ghosts) {
		const ghost = { ...original };
		const start = ghost.location;
		const end = ghost.location + ghost.length;
		if (patch.to <= start) {
			ghost.location += delta;
		} else if (patch.from >= end) {
			// Untouched.
		} else if (patch.from >= start && patch.to <= end) {
			ghost.length += delta;
		} else if (patch.from <= start && patch.to >= end) {
			continue;
		} else if (patch.from <= start) {
			ghost.location = patch.from + patch.insert.length;
			ghost.length = end - patch.to;
		} else {
			ghost.length = patch.from - start;
		}
		if (ghost.length > 0) ghosts.push(ghost);
	}
	return { version: state.version, alternatives, ghosts };
}

/** Detach groups and drop ghosts whose ranges disagree with `markdown`. */
export function validateWritingState(
	state: WritingState,
	markdown: string,
): WritingState {
	return {
		version: state.version,
		alternatives: state.alternatives.map((group) => {
			if (group.detached) return group;
			const end = group.location + group.length;
			const active = group.candidates.find((c) => c.id === group.activeId);
			const fits =
				group.location >= 0 &&
				group.length > 0 &&
				end <= markdown.length &&
				active !== undefined &&
				markdown.slice(group.location, end) === active.text;
			return fits ? group : { ...group, detached: true };
		}),
		ghosts: state.ghosts.filter(
			(ghost) =>
				ghost.location >= 0 &&
				ghost.length > 0 &&
				ghost.location + ghost.length <= markdown.length,
		),
	};
}

export type WritingNode = DocNode & { writing?: string };

/**
 * The writing state at `targetNodeId`: the nearest explicit state at or above
 * it, mapped down through every patch in between.
 */
export function materializeWriting(
	targetNodeId: string,
	nodesById: ReadonlyMap<string, WritingNode>,
): WritingState {
	const chain: WritingNode[] = [];
	const seen = new Set<string>();
	let cursor: string | null = targetNodeId;
	let explicit: WritingState | null = null;
	while (cursor !== null && !seen.has(cursor)) {
		const node = nodesById.get(cursor);
		if (!node) break;
		seen.add(cursor);
		const state = node.writing ? decodeWritingState(node.writing) : null;
		if (state) {
			explicit = state;
			break;
		}
		chain.push(node);
		cursor = node.parentNodeId;
	}
	if (!explicit || cursor === null) return emptyWritingState();
	let markdown = materialize(cursor, nodesById as Map<string, DocNode>);
	let state = validateWritingState(explicit, markdown);
	for (const node of chain.reverse()) {
		const patch = decodePatch(node.patch);
		markdown =
			markdown.slice(0, patch.from) + patch.insert + markdown.slice(patch.to);
		state = mapWritingState(state, patch, markdown);
	}
	return state;
}

/** The state carried from `before` to `after`, for text ahead of the head. */
export function followWritingState(
	state: WritingState,
	before: string,
	after: string,
): WritingState {
	if (before === after) return state;
	return mapWritingState(state, computePatch(before, after), after);
}

/** The history fields reading the writing state needs. */
type WritingHistory = {
	nodes: readonly WritingNode[];
	getHeadNodeId: () => string | null;
	materializeAt: (nodeId: string) => string | null;
};

/**
 * The ghosts on `markdown`, the text a pane shows: derived at the history's
 * head and carried through any typing the head does not have yet.
 */
export function ghostRangesFor(
	markdown: string,
	history: WritingHistory | null,
): { from: number; to: number }[] {
	const head = history?.getHeadNodeId() ?? null;
	if (!history || !head) return [];
	const nodes = new Map(history.nodes.map((node) => [node.nodeId, node]));
	const atHead = materializeWriting(head, nodes);
	if (atHead.ghosts.length === 0) return [];
	const headMarkdown = history.materializeAt(head);
	if (headMarkdown === null) return [];
	return followWritingState(atHead, headMarkdown, markdown).ghosts.map(
		(ghost) => ({
			from: ghost.location,
			to: ghost.location + ghost.length,
		}),
	);
}
