import type {
	AlternativeCandidate,
	AlternativeGroup,
	GhostSpan,
	WritingState,
} from "./state";
import { mapWritingState } from "./state";

/** The ghost under `location`, edges included (`WritingState.ghost(containing:)`). */
export function ghostContaining(
	state: WritingState,
	location: number,
): GhostSpan | undefined {
	return state.ghosts.find(
		(ghost) =>
			ghost.location <= location && location <= ghost.location + ghost.length,
	);
}

/** Ghost `[from, to)`, joining any ghost it touches (`WritingState.ghosting`). */
export function ghosting(
	state: WritingState,
	from: number,
	to: number,
	newId: () => string,
): WritingState | null {
	if (to <= from) return null;
	let start = from;
	let end = to;
	const kept = state.ghosts.filter((ghost) => {
		const touches =
			ghost.location <= end && start <= ghost.location + ghost.length;
		if (touches) {
			start = Math.min(start, ghost.location);
			end = Math.max(end, ghost.location + ghost.length);
		}
		return !touches;
	});
	const ghosts = [
		...kept,
		{ id: newId(), location: start, length: end - start },
	].sort((a, b) => a.location - b.location);
	return { ...state, ghosts };
}

export function reviving(state: WritingState, ghostId: string): WritingState {
	return {
		...state,
		ghosts: state.ghosts.filter((ghost) => ghost.id !== ghostId),
	};
}

/** The attached passage containing `location`, edges included. */
export function groupContaining(
	state: WritingState,
	location: number,
): AlternativeGroup | undefined {
	return state.alternatives.find(
		(group) =>
			!group.detached &&
			group.location <= location &&
			location <= group.location + group.length,
	);
}

/**
 * Add `text` as a wording for `[from, to)` of `markdown`, starting a passage
 * there (its current text as the original) when none covers it. Null for a
 * range that overlaps another passage, so passages never nest.
 */
export function adding(
	state: WritingState,
	text: string,
	author: AlternativeCandidate["author"],
	scope: AlternativeGroup["scope"],
	from: number,
	to: number,
	markdown: string,
	newId: () => string,
): WritingState | null {
	if (to <= from || to > markdown.length || text.length === 0) return null;
	const exact = state.alternatives.findIndex(
		(group) =>
			!group.detached && group.location === from && group.length === to - from,
	);
	if (exact !== -1) {
		const group = state.alternatives[exact];
		if (!group || group.candidates.some((candidate) => candidate.text === text))
			return state;
		const alternatives = [...state.alternatives];
		alternatives[exact] = {
			...group,
			candidates: [...group.candidates, { id: newId(), text, author }],
		};
		return { ...state, alternatives };
	}
	const overlaps = state.alternatives.some(
		(group) =>
			!group.detached &&
			group.location < to &&
			from < group.location + group.length,
	);
	if (overlaps) return null;
	const original: AlternativeCandidate = {
		id: newId(),
		text: markdown.slice(from, to),
		author: "human",
	};
	const candidates =
		text === original.text
			? [original]
			: [original, { id: newId(), text, author }];
	return {
		...state,
		alternatives: [
			...state.alternatives,
			{
				id: newId(),
				scope,
				location: from,
				length: to - from,
				candidates,
				activeId: original.id,
				detached: false,
			},
		],
	};
}

/**
 * Show `candidateId` in its passage: the replacement to make (`[from, to)` of
 * `markdown` → `text`) and the state for the resulting text. `article`
 * replaces the a/an before the passage in the same change.
 */
export function choosing(
	state: WritingState,
	candidateId: string,
	groupId: string,
	markdown: string,
	article?: { from: number; to: number; text: string },
): { state: WritingState; from: number; to: number; text: string } | null {
	const index = state.alternatives.findIndex(
		(group) => group.id === groupId && !group.detached,
	);
	const group = state.alternatives[index];
	const candidate = group?.candidates.find((c) => c.id === candidateId);
	if (!group || !candidate || group.location + group.length > markdown.length)
		return null;
	if (article && article.to > group.location) return null;
	const alternatives = [...state.alternatives];
	alternatives[index] = { ...group, activeId: candidateId };
	let next: WritingState = { ...state, alternatives };
	let text = markdown;
	if (article) {
		text = text.slice(0, article.from) + article.text + text.slice(article.to);
		next = mapWritingState(
			next,
			{ from: article.from, to: article.to, insert: article.text },
			text,
		);
	}
	const shifted = next.alternatives[index];
	if (!shifted) return null;
	const end = shifted.location + shifted.length;
	text = text.slice(0, shifted.location) + candidate.text + text.slice(end);
	next = mapWritingState(
		next,
		{ from: shifted.location, to: end, insert: candidate.text },
		text,
	);
	const from = article?.from ?? group.location;
	const to = group.location + group.length;
	return {
		state: next,
		from,
		to,
		text: text.slice(from, to + text.length - markdown.length),
	};
}

/** Remove a wording that is not showing; a passage left with its original goes. */
export function removing(
	state: WritingState,
	candidateId: string,
	groupId: string,
): WritingState | null {
	const index = state.alternatives.findIndex((group) => group.id === groupId);
	const group = state.alternatives[index];
	if (
		!group ||
		group.activeId === candidateId ||
		!group.candidates.some((c) => c.id === candidateId)
	) {
		return null;
	}
	const candidates = group.candidates.filter((c) => c.id !== candidateId);
	const alternatives = [...state.alternatives];
	if (candidates.length <= 1) alternatives.splice(index, 1);
	else alternatives[index] = { ...group, candidates };
	return { ...state, alternatives };
}
