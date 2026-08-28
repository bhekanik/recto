"use client";

import { useConvexAuth, useMutation, useQuery } from "convex/react";
import {
	type Dispatch,
	type SetStateAction,
	useEffect,
	useRef,
	useState,
} from "react";
import { useDebouncedCallback } from "use-debounce";

import { api } from "@/convex/_generated/api";
import { SETTINGS_STORAGE_KEY } from "@/lib/studio/appearance";
import {
	mergeSyncedJson,
	type StudioSettings,
	serializeSynced,
} from "@/lib/studio/settings-schema";

/**
 * Keeps the synced subset of the studio settings in step with Convex (ADR-21).
 *
 * The rules, in order of precedence:
 *
 *  1. **localStorage is always written**, signed in or not. It holds every
 *     setting including the device-local ones, it is what the pre-paint
 *     appearance script reads, and it is the only store when offline.
 *  2. **On first hydration the server wins.** A device that has never signed in
 *     on this account seeds the server from its own localStorage; after that,
 *     signing in on a new machine adopts the writer's settings rather than
 *     pushing this machine's defaults over them.
 *  3. **Pushes are plain last-write-wins.** `settings.save` offers a
 *     compare-and-set, and this hook deliberately does not use it: on a lost
 *     CAS the only sane resolution here would be to discard the change the
 *     writer just made, one keystroke ago, in favour of another device's older
 *     one. Two devices changing the same setting within a second of each other
 *     is not a real scenario for one person's writing app; silently undoing
 *     their click is a real annoyance. The CAS stays in the API for the native
 *     outbox, which replays writes minutes late and does need to be told.
 */

/**
 * Settings changes are deliberate clicks, not keystrokes, so this only needs to
 * coalesce a burst (dragging the zoom, cycling a theme) rather than debounce
 * typing.
 */
export const SETTINGS_SAVE_DEBOUNCE_MS = 800;

function writeLocalStorage(settings: StudioSettings): void {
	try {
		window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
	} catch {
		// Private mode / quota — settings simply won't persist on this device.
	}
}

export function useSettingsSync(
	settings: StudioSettings,
	setSettings: Dispatch<SetStateAction<StudioSettings>>,
): void {
	const { isAuthenticated } = useConvexAuth();
	const remote = useQuery(api.settings.get, isAuthenticated ? {} : "skip");
	const save = useMutation(api.settings.save);

	/**
	 * State, not a ref, and load-bearing: the push effect must not run in the
	 * same commit that hydration happens in. Both effects see the same
	 * `settings`, so a ref flipped by the first one would let the second push
	 * this device's PRE-hydration settings straight back over the server's —
	 * exactly the state hydration had just decided to discard.
	 */
	const [hydrated, setHydrated] = useState(false);
	/**
	 * The synced JSON this device believes the server holds — set both when we
	 * push and when we adopt. Comparing against it is what stops the reactive
	 * echo of our own write from being read as a change from another device.
	 */
	const serverJsonRef = useRef<string | null>(null);
	/** True from a local change until its save resolves. */
	const savingRef = useRef(false);
	const settingsRef = useRef(settings);
	settingsRef.current = settings;

	useEffect(() => {
		writeLocalStorage(settings);
	}, [settings]);

	const push = useDebouncedCallback((json: string) => {
		savingRef.current = true;
		void save({ json })
			.catch(() => {
				// Offline or rejected: localStorage still holds the change and the
				// next one re-sends the whole object, so nothing needs queueing here.
				serverJsonRef.current = null;
			})
			.finally(() => {
				savingRef.current = false;
			});
	}, SETTINGS_SAVE_DEBOUNCE_MS);

	// Hydrate once, then adopt changes made on other devices.
	useEffect(() => {
		if (!isAuthenticated || remote === undefined) return;

		if (!hydrated) {
			setHydrated(true);
			if (remote === null) {
				// First run on this account: this device's settings become the
				// starting point rather than being reset to defaults.
				const json = serializeSynced(settingsRef.current);
				serverJsonRef.current = json;
				push(json);
				push.flush();
				return;
			}
			serverJsonRef.current = remote.json;
			setSettings((current) => mergeSyncedJson(current, remote.json));
			return;
		}

		if (remote === null) return;
		// Our own write coming back, or a write we are about to overwrite.
		if (remote.json === serverJsonRef.current || savingRef.current) return;
		serverJsonRef.current = remote.json;
		setSettings((current) => mergeSyncedJson(current, remote.json));
	}, [isAuthenticated, remote, hydrated, push, setSettings]);

	// Push local changes to the synced subset. Device-local settings change this
	// object too, and must not cost a mutation — hence comparing the serialized
	// synced subset rather than the settings object.
	useEffect(() => {
		if (!isAuthenticated || !hydrated) return;
		const json = serializeSynced(settings);
		if (json === serverJsonRef.current) return;
		serverJsonRef.current = json;
		push(json);
	}, [isAuthenticated, hydrated, settings, push]);

	// A toggle flipped in the last 800 ms would otherwise be lost on navigation.
	useEffect(() => {
		const flush = () => push.flush();
		const onVisibility = () => {
			if (document.visibilityState === "hidden") flush();
		};
		window.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("beforeunload", flush);
		return () => {
			window.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("beforeunload", flush);
			push.flush();
		};
	}, [push]);
}
