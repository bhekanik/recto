const KEY = "recto:device-origin";
let cached: string | null = null;

/**
 * A stable per-device id used as docNodes.origin (provenance + origin-guard,
 * blueprint 07 §3.1). Persisted in localStorage so it survives reloads.
 */
export function getDeviceOrigin(): string {
	if (cached) return cached;
	if (typeof window === "undefined") return "server";
	try {
		const existing = window.localStorage.getItem(KEY);
		if (existing) {
			cached = existing;
			return existing;
		}
		const fresh = crypto.randomUUID();
		window.localStorage.setItem(KEY, fresh);
		cached = fresh;
		return fresh;
	} catch {
		cached = crypto.randomUUID();
		return cached;
	}
}
