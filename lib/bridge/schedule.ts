/** Trailing throttle with leading edge — coalesce bursts, project first keystroke immediately. */
export function throttleTrailing<T extends unknown[]>(
	fn: (...args: T) => void,
	ms: number,
): (...args: T) => void {
	let last = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let pending: T | null = null;

	return (...args: T) => {
		pending = args;
		const now = performance.now();
		const wait = Math.max(0, ms - (now - last));

		if (wait === 0 && timer === null) {
			last = now;
			fn(...(pending as T));
			pending = null;
		} else if (timer === null) {
			timer = setTimeout(() => {
				timer = null;
				last = performance.now();
				if (pending) {
					fn(...pending);
					pending = null;
				}
			}, wait);
		}
	};
}
