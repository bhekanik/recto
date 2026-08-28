import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SETTINGS_STORAGE_KEY } from "./appearance";
import {
	DEFAULTS,
	type StudioSettings,
	serializeSynced,
} from "./settings-schema";
import {
	SETTINGS_DIRTY_STORAGE_KEY,
	SETTINGS_RETRY_BASE_MS,
} from "./use-settings-sync";

/**
 * The Convex side is mocked rather than mounted: the behaviour under test is
 * the ordering (hydrate, then adopt, then push) and what does NOT get sent, and
 * a real ConvexProvider would only add a socket to that. The mutation and the
 * query results are the contract `convex/settings.test.ts` pins on the server.
 */
type RemoteSettings = { json: string; updatedAt: number } | null | undefined;

const state = {
	isAuthenticated: true,
	remote: undefined as RemoteSettings,
};

type SaveResult =
	| { saved: true; conflict: false; updatedAt: number; json?: undefined }
	| {
			saved: false;
			conflict: true;
			json: string | null;
			updatedAt: number | null;
	  };

const saveMock = vi.fn(
	async (_args: {
		json: string;
		expectedUpdatedAt?: number;
	}): Promise<SaveResult> => ({ saved: true, conflict: false, updatedAt: 1 }),
);

/** The `json` the mocked mutation was called with, parsed. */
function sentJson(call: number): Record<string, unknown> {
	const args = saveMock.mock.calls[call]?.[0];
	expect(args).toBeDefined();
	return JSON.parse((args as { json: string }).json);
}

vi.mock("convex/react", () => ({
	useConvexAuth: () => ({
		isAuthenticated: state.isAuthenticated,
		isLoading: false,
	}),
	useQuery: (_reference: unknown, args: unknown) =>
		args === "skip" ? undefined : state.remote,
	useMutation: () => saveMock,
}));

const { useSettingsSync } = await import("./use-settings-sync");

/**
 * happy-dom in this project's vitest config exposes no `window.localStorage`,
 * and the hook's whole device-storage half depends on it, so the tests supply a
 * minimal one rather than skipping that half.
 */
const storageBacking = new Map<string, string>();
const localStorageStub: Storage = {
	getItem: (key) => storageBacking.get(key) ?? null,
	setItem: (key, value) => {
		storageBacking.set(key, String(value));
	},
	removeItem: (key) => {
		storageBacking.delete(key);
	},
	clear: () => storageBacking.clear(),
	key: (index) => [...storageBacking.keys()][index] ?? null,
	get length() {
		return storageBacking.size;
	},
};

let container: HTMLDivElement;
let root: Root;
let latest: StudioSettings = DEFAULTS;
let setSettingsExternally: ((next: StudioSettings) => void) | null = null;

function Harness({ initial }: { initial: StudioSettings }) {
	const [settings, setSettings] = useState(initial);
	useSettingsSync(settings, setSettings);
	latest = settings;
	setSettingsExternally = (next) => setSettings(next);
	return null;
}

function render(initial: StudioSettings) {
	act(() => {
		root.render(createElement(Harness, { initial }));
	});
}

function flushDebounce() {
	act(() => {
		vi.advanceTimersByTime(2000);
	});
}

beforeEach(() => {
	// @ts-expect-error React's act environment flag is not in the DOM typings.
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	vi.useFakeTimers();
	saveMock.mockClear();
	state.isAuthenticated = true;
	state.remote = undefined;
	Object.defineProperty(window, "localStorage", {
		value: localStorageStub,
		configurable: true,
	});
	storageBacking.clear();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.useRealTimers();
});

describe("useSettingsSync", () => {
	it("writes every setting to localStorage, device-local ones included", () => {
		state.isAuthenticated = false;
		render({ ...DEFAULTS, appearance: "dark", theme: "aurora" });

		const stored = JSON.parse(
			window.localStorage.getItem(SETTINGS_STORAGE_KEY) as string,
		);
		expect(stored.appearance).toBe("dark");
		expect(stored.theme).toBe("aurora");
	});

	it("does not touch Convex while signed out", () => {
		state.isAuthenticated = false;
		render({ ...DEFAULTS, theme: "dawn" });
		flushDebounce();
		expect(saveMock).not.toHaveBeenCalled();
	});

	it("waits for the query before deciding anything", () => {
		state.remote = undefined;
		render(DEFAULTS);
		flushDebounce();
		expect(saveMock).not.toHaveBeenCalled();
	});

	it("seeds the server from this device when the account has no settings yet", () => {
		state.remote = null;
		render({ ...DEFAULTS, theme: "aurora", appearance: "dark" });
		flushDebounce();

		expect(saveMock).toHaveBeenCalledTimes(1);
		const sent = sentJson(0);
		expect(sent.theme).toBe("aurora");
		// The seed must not carry this screen's preferences onto every other device.
		expect(sent).not.toHaveProperty("appearance");
	});

	it("lets the server win on first hydration, but only over synced keys", () => {
		state.remote = {
			json: JSON.stringify({ theme: "dawn", lint: true }),
			updatedAt: 10,
		};
		render({
			...DEFAULTS,
			theme: "aurora",
			appearance: "dark",
			readingScale: 1.5,
		});

		expect(latest.theme).toBe("dawn");
		expect(latest.lint).toBe(true);
		// Hydrating from another machine must not restyle this one.
		expect(latest.appearance).toBe("dark");
		expect(latest.readingScale).toBe(1.5);
	});

	it("keeps and re-sends a dirty value restored after an offline reload", () => {
		window.localStorage.setItem(
			SETTINGS_DIRTY_STORAGE_KEY,
			JSON.stringify(["theme"]),
		);
		state.remote = {
			json: serializeSynced({ ...DEFAULTS, theme: "dawn" }),
			updatedAt: 10,
		};
		render({ ...DEFAULTS, theme: "moonlit" });

		expect(latest.theme).toBe("moonlit");
		flushDebounce();
		expect(saveMock).toHaveBeenCalledTimes(1);
		expect(sentJson(0).theme).toBe("moonlit");
	});

	it("does not push straight back what it just hydrated", () => {
		state.remote = {
			json: serializeSynced({ ...DEFAULTS, theme: "dawn" }),
			updatedAt: 10,
		};
		render(DEFAULTS);
		flushDebounce();
		expect(saveMock).not.toHaveBeenCalled();
	});

	it("pushes a change to a synced setting", () => {
		state.remote = { json: serializeSynced(DEFAULTS), updatedAt: 10 };
		render(DEFAULTS);
		flushDebounce();
		saveMock.mockClear();

		act(() => setSettingsExternally?.({ ...latest, theme: "moonlit" }));
		flushDebounce();

		expect(saveMock).toHaveBeenCalledTimes(1);
		const sent = sentJson(0);
		expect(sent.theme).toBe("moonlit");
	});

	it("costs no mutation when only a device-local setting changes", () => {
		state.remote = { json: serializeSynced(DEFAULTS), updatedAt: 10 };
		render(DEFAULTS);
		flushDebounce();
		saveMock.mockClear();

		act(() =>
			setSettingsExternally?.({
				...latest,
				appearance: "light",
				readingScale: 1.2,
				topToolbar: false,
				outlineOpen: true,
			}),
		);
		flushDebounce();

		expect(saveMock).not.toHaveBeenCalled();
	});

	it("coalesces a burst of changes into one write", () => {
		state.remote = { json: serializeSynced(DEFAULTS), updatedAt: 10 };
		render(DEFAULTS);
		flushDebounce();
		saveMock.mockClear();

		act(() => setSettingsExternally?.({ ...latest, theme: "aurora" }));
		act(() => setSettingsExternally?.({ ...latest, theme: "dawn" }));
		act(() => setSettingsExternally?.({ ...latest, theme: "moonlit" }));
		flushDebounce();

		expect(saveMock).toHaveBeenCalledTimes(1);
		expect(sentJson(0).theme).toBe("moonlit");
	});

	it("adopts a change made on another device", () => {
		state.remote = { json: serializeSynced(DEFAULTS), updatedAt: 10 };
		render(DEFAULTS);
		flushDebounce();
		saveMock.mockClear();

		state.remote = {
			json: serializeSynced({ ...DEFAULTS, readingFont: "serif" }),
			updatedAt: 20,
		};
		// Re-render so the mocked `useQuery` is read again with the new state.
		render(DEFAULTS);

		expect(latest.readingFont).toBe("serif");
		// Adopting is not a local change; echoing it back would loop.
		flushDebounce();
		expect(saveMock).not.toHaveBeenCalled();
	});

	it("ignores the reactive echo of its own write", () => {
		state.remote = { json: serializeSynced(DEFAULTS), updatedAt: 10 };
		render(DEFAULTS);
		flushDebounce();
		saveMock.mockClear();

		act(() => setSettingsExternally?.({ ...latest, theme: "aurora" }));
		flushDebounce();
		expect(saveMock).toHaveBeenCalledTimes(1);

		// The server now reports exactly what we sent.
		state.remote = {
			json: serializeSynced({ ...DEFAULTS, theme: "aurora" }),
			updatedAt: 30,
		};
		// Re-render so the mocked `useQuery` is read again with the new state.
		render(DEFAULTS);
		flushDebounce();

		expect(latest.theme).toBe("aurora");
		expect(saveMock).toHaveBeenCalledTimes(1);
	});

	it("compare-and-sets against the stamp it last saw", async () => {
		state.remote = { json: serializeSynced(DEFAULTS), updatedAt: 42 };
		render(DEFAULTS);
		flushDebounce();
		saveMock.mockClear();

		act(() => setSettingsExternally?.({ ...latest, theme: "aurora" }));
		flushDebounce();

		// An unconditional write is how a tab left open overnight reverts another
		// device's settings the moment someone toggles one thing in it.
		expect(saveMock.mock.calls[0]?.[0]?.expectedUpdatedAt).toBe(42);
	});

	it("carries settings this build does not know about straight back", async () => {
		// What a newer native client wrote and this older web build cannot name.
		const stored = JSON.stringify({
			...JSON.parse(serializeSynced(DEFAULTS)),
			futureSetting: { nested: true },
		});
		state.remote = { json: stored, updatedAt: 7 };
		render(DEFAULTS);
		flushDebounce();
		saveMock.mockClear();

		act(() => setSettingsExternally?.({ ...latest, theme: "aurora" }));
		flushDebounce();

		const sent = sentJson(0);
		expect(sent.theme).toBe("aurora");
		// Dropping this key would silently reset that setting on every device.
		expect(sent.futureSetting).toEqual({ nested: true });
	});

	it("retries a failed save instead of dropping the change", async () => {
		state.remote = { json: serializeSynced(DEFAULTS), updatedAt: 1 };
		render(DEFAULTS);
		flushDebounce();
		saveMock.mockClear();
		saveMock.mockRejectedValueOnce(new Error("offline"));

		act(() => setSettingsExternally?.({ ...latest, theme: "moonlit" }));
		flushDebounce();
		await act(async () => {});
		expect(saveMock).toHaveBeenCalledTimes(1);

		// The backoff timer fires and the same change goes again.
		await act(async () => {
			vi.advanceTimersByTime(SETTINGS_RETRY_BASE_MS + 100);
		});
		await act(async () => {});

		expect(saveMock).toHaveBeenCalledTimes(2);
		expect(sentJson(1).theme).toBe("moonlit");
	});

	it("on a lost compare-and-set, keeps this device's change and adopts the rest", async () => {
		state.remote = { json: serializeSynced(DEFAULTS), updatedAt: 1 };
		render(DEFAULTS);
		flushDebounce();
		saveMock.mockClear();

		// Another device changed the reading font while this one changed the
		// theme, and got there first.
		const winner = serializeSynced({
			...DEFAULTS,
			readingFont: "serif",
			theme: "dawn",
		});
		saveMock.mockResolvedValueOnce({
			saved: false,
			conflict: true,
			json: winner,
			updatedAt: 99,
		});

		act(() => setSettingsExternally?.({ ...latest, theme: "moonlit" }));
		flushDebounce();
		await act(async () => {});

		// The setting the writer just changed survives; the one they did not
		// touch takes the other device's value.
		expect(latest.theme).toBe("moonlit");
		expect(latest.readingFont).toBe("serif");
	});

	it("re-sends when the winner changed only the same held key", async () => {
		state.remote = { json: serializeSynced(DEFAULTS), updatedAt: 1 };
		render(DEFAULTS);
		flushDebounce();
		saveMock.mockClear();
		saveMock.mockResolvedValueOnce({
			saved: false,
			conflict: true,
			json: serializeSynced({ ...DEFAULTS, theme: "dawn" }),
			updatedAt: 99,
		});

		act(() => setSettingsExternally?.({ ...latest, theme: "moonlit" }));
		flushDebounce();
		await act(async () => {});
		flushDebounce();
		await act(async () => {});

		expect(saveMock.mock.calls.length).toBeGreaterThanOrEqual(2);
		const retry = saveMock.mock.calls.at(-1)?.[0];
		expect(retry?.expectedUpdatedAt).toBe(99);
		expect(JSON.parse(retry?.json as string).theme).toBe("moonlit");
	});

	it("keeps the local change when the save fails, so nothing is silently lost", async () => {
		state.remote = { json: serializeSynced(DEFAULTS), updatedAt: 10 };
		render(DEFAULTS);
		flushDebounce();
		saveMock.mockClear();
		saveMock.mockRejectedValueOnce(new Error("offline"));

		act(() => setSettingsExternally?.({ ...latest, theme: "moonlit" }));
		flushDebounce();
		await act(async () => {});

		expect(latest.theme).toBe("moonlit");
		expect(
			JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) as string)
				.theme,
		).toBe("moonlit");
	});
});
