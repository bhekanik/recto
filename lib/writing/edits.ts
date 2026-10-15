import type { GhostSpan, WritingState } from "./state";

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
