/**
 * This browser's identity for per-device workspace rows (plan 023 §4.1(3)).
 *
 * A layout belongs to a screen, not to a person: the pane tree a writer builds
 * on a 27" monitor is not one an iPhone can render. Convex keys workspaces by
 * `(userId, deviceId)`, so the web needs a stable id of its own.
 *
 * It lives in localStorage and is deliberately meaningless — a random UUID,
 * no fingerprinting, nothing derived from the machine. Clearing site data mints
 * a new one, which costs the writer their stored layout on that browser and
 * nothing else (`workspaces.saveForDevice` evicts the least recently used row
 * so abandoned ids cannot pile up).
 */

export const DEVICE_ID_STORAGE_KEY = "recto:device-id";

/** What this client reports itself as. The native apps send mac/ipad/iphone. */
export const WEB_DEVICE_CLASS = "web" as const;

/**
 * Falls back to a per-session id when localStorage is unavailable (private
 * mode, blocked storage). That device's layout then resets each reload, which
 * is the same thing that happens to every other setting there — better than
 * refusing to save a layout at all.
 */
let sessionDeviceId: string | null = null;

export function getDeviceId(): string {
	try {
		const stored = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY);
		if (stored) return stored;
		const minted = crypto.randomUUID();
		window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, minted);
		return minted;
	} catch {
		sessionDeviceId ??= crypto.randomUUID();
		return sessionDeviceId;
	}
}
