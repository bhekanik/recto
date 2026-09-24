/**
 * Focus blur (after the Mac app's `MarkdownFocusBlur`): the caret's block stays
 * sharp and every other block blurs more the further away it is. Both editors
 * call this, so the curve lives in one place.
 *
 * Only blocks inside the ramp get their own radius; everything past it takes
 * the container's maximum from CSS (`--focus-blur-max`), so the work per caret
 * move is bounded by the ramp, not by the document's length.
 */

/** The blur at the end of the ramp, in CSS px (a Gaussian's standard deviation). */
export const FOCUS_BLUR_MAX_PX = 3;
/** How many blocks it takes to reach the maximum. */
export const FOCUS_BLUR_RAMP = 6;

/**
 * Blur radius for a block `distance` blocks from the caret's (0 = the caret's).
 * The nearest neighbour already starts at 30% so it reads as out of focus,
 * then the rest eases in to the maximum; quantised so neighbouring caret
 * positions reuse the same values.
 */
export function focusBlurRadius(distance: number): number {
	if (distance <= 0) return 0;
	const t = Math.min(1, distance / FOCUS_BLUR_RAMP);
	const eased = t * t * (3 - 2 * t);
	const radius = FOCUS_BLUR_MAX_PX * (0.3 + 0.7 * eased);
	return Math.round(radius * 4) / 4;
}

export type BlurredBlock = { index: number; distance: number };

/**
 * The blocks inside the ramp around `active`, each with its distance in
 * blocks. Blank blocks (empty lines in the source lenses) don't count
 * towards the distance, so a blank line doesn't make a paragraph look
 * further away than its neighbour. Blocks at the ramp's end or beyond are
 * left out: the container's CSS blurs them to the maximum.
 */
export function blocksInRamp(
	count: number,
	active: number,
	isBlank: (index: number) => boolean = () => false,
): BlurredBlock[] {
	if (count <= 0 || active < 0 || active >= count) return [];
	const blocks: BlurredBlock[] = [{ index: active, distance: 0 }];
	for (const step of [-1, 1]) {
		let distance = 0;
		for (
			let index = active + step;
			index >= 0 && index < count;
			index += step
		) {
			if (!isBlank(index)) distance += 1;
			if (distance >= FOCUS_BLUR_RAMP) break;
			blocks.push({ index, distance: Math.max(distance, 1) });
		}
	}
	return blocks.sort((a, b) => a.index - b.index);
}

/** Inline style for a block in the ramp; the caret's block is explicitly sharp. */
export function focusBlurStyle(distance: number): string {
	const radius = focusBlurRadius(distance);
	return radius === 0 ? "filter: none" : `filter: blur(${radius}px)`;
}
