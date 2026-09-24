/**
 * Typewriter scrolling that glides (after the Mac app's typewriter): the page
 * eases to the new caret line over a short beat instead of jumping, so Return
 * feels like a carriage moving, not a cut.
 *
 * A frame loop rather than `scrollTo({ behavior: "smooth" })`: the browser's
 * smooth scroll is longer than a keystroke and its duration can't be set, so
 * fast typing would always be catching up.
 */

const GLIDE_MS = 160;

const running = new WeakMap<HTMLElement, () => void>();

function prefersReducedMotion(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

/**
 * Move `scroller` so its `scrollTop` reaches `target`. A new glide on the same
 * scroller starts from wherever the last one had got to. Jumps instead when
 * the writer prefers reduced motion or the move is a screen or more (a jump to
 * another part of the document, not the next line), and stops if the writer
 * scrolls by hand.
 */
export function glideScrollTop(scroller: HTMLElement, target: number): void {
	running.get(scroller)?.();
	const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
	const end = Math.min(max, Math.max(0, target));
	const start = scroller.scrollTop;
	const distance = end - start;
	if (Math.abs(distance) < 1) return;
	if (prefersReducedMotion() || Math.abs(distance) >= scroller.clientHeight) {
		scroller.scrollTop = end;
		return;
	}

	let frame = 0;
	const stop = () => {
		cancelAnimationFrame(frame);
		scroller.removeEventListener("wheel", stop);
		scroller.removeEventListener("touchstart", stop);
		if (running.get(scroller) === stop) running.delete(scroller);
	};
	running.set(scroller, stop);
	scroller.addEventListener("wheel", stop, { passive: true });
	scroller.addEventListener("touchstart", stop, { passive: true });

	const began = performance.now();
	const step = (now: number) => {
		const progress = Math.min(1, (now - began) / GLIDE_MS);
		const eased = 1 - (1 - progress) ** 3;
		scroller.scrollTop = start + distance * eased;
		if (progress < 1) frame = requestAnimationFrame(step);
		else stop();
	};
	frame = requestAnimationFrame(step);
}

/** Glide `scroller` so the caret's vertical middle, in client coordinates, sits at its centre. */
export function glideCaretToCentre(
	scroller: HTMLElement,
	caretTop: number,
	caretBottom: number,
): void {
	const rect = scroller.getBoundingClientRect();
	const caretMid = (caretTop + caretBottom) / 2;
	const viewportMid = rect.top + rect.height / 2;
	glideScrollTop(scroller, scroller.scrollTop + caretMid - viewportMid);
}
