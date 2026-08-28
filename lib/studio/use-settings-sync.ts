"use client";

import { useConvexAuth, useMutation, useQuery } from "convex/react";
import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useDebouncedCallback } from "use-debounce";

import { api } from "@/convex/_generated/api";
import { SETTINGS_STORAGE_KEY } from "@/lib/studio/appearance";
import {
	changedSyncedKeys,
	mergeSyncedJson,
	pickUnknown,
	type StudioSettings,
	SYNCED_KEYS,
	type SyncedKey,
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
 *  3. **Every push is compare-and-set, and nothing is lost when it fails.** The
 *     hook tracks which settings THIS device changed and has not had accepted,
 *     each with the revision it was at when the request went out. A failed save
 *     (offline, a rejected transaction) keeps them dirty and retries; a lost
 *     CAS takes the winner's values for everything else and keeps the writer's
 *     own change, then writes again on top of the winner's stamp.
 *  4. **Settings this build does not know about are carried through untouched**
 *     (`pickUnknown`), so an older web client cannot delete a newer native
 *     client's settings by writing back "the whole object".
 */

/**
 * Settings changes are deliberate clicks, not keystrokes, so this only needs to
 * coalesce a burst (dragging the zoom, cycling a theme) rather than debounce
 * typing.
 */
export const SETTINGS_SAVE_DEBOUNCE_MS = 800;

/** Backoff floor for a retry after a failed save; doubles per attempt. */
export const SETTINGS_RETRY_BASE_MS = 2000;

/**
 * After this many consecutive failures the timer stops — but the work does not
 * go away. A local change or the browser coming back online resets the count
 * and sends again; a retry loop that gives up permanently is how a laptop that
 * was offline at bedtime is still holding the change at breakfast.
 */
const MAX_RETRY_ATTEMPTS = 6;

/** Where the unsent-key set survives a reload. */
export const SETTINGS_DIRTY_STORAGE_KEY = "recto:settings-dirty";

function writeLocalStorage(settings: StudioSettings): void {
	try {
		window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
	} catch {
		// Private mode / quota — settings simply won't persist on this device.
	}
}

const SYNCED_KEY_SET = new Set<string>(SYNCED_KEYS);

function readDirtyKeys(): SyncedKey[] {
	try {
		const raw = window.localStorage.getItem(SETTINGS_DIRTY_STORAGE_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((key): key is SyncedKey =>
			typeof key === "string" ? SYNCED_KEY_SET.has(key) : false,
		);
	} catch {
		return [];
	}
}

function writeDirtyKeys(keys: Iterable<SyncedKey>): void {
	try {
		const list = [...keys];
		if (list.length === 0) {
			window.localStorage.removeItem(SETTINGS_DIRTY_STORAGE_KEY);
		} else {
			window.localStorage.setItem(
				SETTINGS_DIRTY_STORAGE_KEY,
				JSON.stringify(list),
			);
		}
	} catch {
		// Same posture as the settings blob itself: unavailable storage costs
		// durability across a reload, not correctness in this session.
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
	 * The synced JSON this device believes the server holds, and the stamp it
	 * came with. The stamp is what every write compare-and-sets against; the
	 * JSON is what stops the reactive echo of our own write being read as a
	 * change from another device.
	 */
	const serverJsonRef = useRef<string | null>(null);
	const serverStampRef = useRef<number | null>(null);
	/**
	 * Settings this device changed that the server has not accepted yet, each
	 * mapped to the revision it was last touched at.
	 *
	 * The revision is the whole point. A save carries a snapshot of the values
	 * at the moment it was sent; if the writer changes one of those keys while
	 * the request is in flight, the acknowledgement covers the OLD value and
	 * clearing the key outright would mark the newer one saved. Comparing
	 * revisions clears only what the server actually received.
	 */
	const dirtyRef = useRef(new Map<SyncedKey, number>());
	const revisionRef = useRef(0);
	/** Properties in the stored object this build does not know about. */
	const unknownRef = useRef<Record<string, unknown>>({});
	/** True from the moment a save is sent until it settles. */
	const savingRef = useRef(false);
	/**
	 * Consecutive failed saves. State rather than a ref because the retry effect
	 * is driven by it: the event it waits for — the network coming back —
	 * produces no other change to re-run on.
	 */
	const [attempts, setAttempts] = useState(0);
	const settingsRef = useRef(settings);
	settingsRef.current = settings;
	/**
	 * Indirection so `flush` can schedule its own follow-up without depending on
	 * the debounced callback that wraps it.
	 */
	const resendRef = useRef<() => void>(() => {});

	const markDirty = useCallback((keys: Iterable<SyncedKey>) => {
		revisionRef.current += 1;
		for (const key of keys) dirtyRef.current.set(key, revisionRef.current);
		writeDirtyKeys(dirtyRef.current.keys());
	}, []);

	useEffect(() => {
		writeLocalStorage(settings);
	}, [settings]);

	// Unsent work from a previous session. Restored before the first push so a
	// reload mid-outage does not quietly drop the change.
	useEffect(() => {
		const restored = readDirtyKeys();
		if (restored.length > 0) markDirty(restored);
	}, [markDirty]);

	const flush = useCallback(async (): Promise<void> => {
		if (savingRef.current) return;
		const json = serializeSynced(settingsRef.current, unknownRef.current);
		if (json === serverJsonRef.current) {
			dirtyRef.current.clear();
			writeDirtyKeys([]);
			return;
		}

		// What this request is answering for. Anything touched after this point
		// keeps its newer revision and stays dirty.
		const sent = new Map(dirtyRef.current);
		savingRef.current = true;
		try {
			const stamp = serverStampRef.current;
			const result = await save({
				json,
				// Undefined only before this device has ever seen a row, where there
				// is nothing to be stale against.
				expectedUpdatedAt: stamp ?? undefined,
			});

			if (result.saved) {
				serverJsonRef.current = json;
				serverStampRef.current = result.updatedAt;
				for (const [key, revision] of sent) {
					if (dirtyRef.current.get(key) === revision) {
						dirtyRef.current.delete(key);
					}
				}
				writeDirtyKeys(dirtyRef.current.keys());
				setAttempts((count) => (count === 0 ? count : 0));
				// Keys the writer changed while this request was in flight are still
				// dirty. Nothing else will notice — there is no new change to react
				// to and no failure to retry — so the follow-up is arranged here.
				if (dirtyRef.current.size > 0) resendRef.current();
				return;
			}

			// Lost the compare-and-set. Adopt everything the winner changed EXCEPT
			// the settings this device is still holding — those are the writer's
			// most recent intent and get written again on top of the winner.
			const winner = result.json;
			serverStampRef.current = result.updatedAt;
			if (winner === null) {
				serverJsonRef.current = null;
			} else {
				serverJsonRef.current = winner;
				unknownRef.current = pickUnknown(winner);
				const held = new Set(dirtyRef.current.keys());
				setSettings((current) => mergeSyncedJson(current, winner, held));
			}
			setAttempts((count) => (count === 0 ? count : 0));
		} catch {
			// Offline, or the transaction was rejected. The dirty map is untouched,
			// so nothing is lost; localStorage already holds the change.
			setAttempts((count) => count + 1);
		} finally {
			savingRef.current = false;
		}
	}, [save, setSettings]);

	const push = useDebouncedCallback(() => {
		void flush();
	}, SETTINGS_SAVE_DEBOUNCE_MS);
	resendRef.current = push;

	// Hydrate once, then adopt changes made on other devices.
	useEffect(() => {
		if (!isAuthenticated || remote === undefined) return;

		if (!hydrated) {
			setHydrated(true);
			if (remote === null) {
				// First run on this account: this device's settings become the
				// starting point rather than being reset to defaults. The whole
				// object is this device's to establish, so every synced key counts
				// as unsent work until the seed is accepted.
				markDirty(SYNCED_KEYS);
				serverJsonRef.current = null;
				serverStampRef.current = null;
				push();
				push.flush();
				return;
			}
			serverJsonRef.current = remote.json;
			serverStampRef.current = remote.updatedAt;
			unknownRef.current = pickUnknown(remote.json);
			setSettings((current) => mergeSyncedJson(current, remote.json));
			return;
		}

		if (remote === null) return;
		// Our own write coming back, or one we are about to overwrite.
		if (remote.json === serverJsonRef.current) return;
		serverStampRef.current = remote.updatedAt;
		serverJsonRef.current = remote.json;
		unknownRef.current = pickUnknown(remote.json);
		if (savingRef.current || dirtyRef.current.size > 0) {
			// Another device wrote while this one has unsent work. Take the new
			// stamp so the next attempt compare-and-sets against it, adopt the
			// settings this device is not holding, and let the flush re-send the
			// rest.
			const held = new Set(dirtyRef.current.keys());
			setSettings((current) => mergeSyncedJson(current, remote.json, held));
			push();
			return;
		}
		setSettings((current) => mergeSyncedJson(current, remote.json));
	}, [isAuthenticated, remote, hydrated, push, setSettings, markDirty]);

	// Track local changes and schedule a push. Device-local settings change this
	// object too and must not cost a mutation, so the comparison is over the
	// synced subset only.
	const previousRef = useRef(settings);
	useEffect(() => {
		const previous = previousRef.current;
		previousRef.current = settings;
		if (!isAuthenticated || !hydrated) return;

		const changed = changedSyncedKeys(previous, settings);
		if (changed.length === 0) return;
		markDirty(changed);
		// A new change is new information: whatever made the last attempt fail is
		// worth trying again for, so the backoff starts over.
		setAttempts((count) => (count === 0 ? count : 0));
		push();
	}, [isAuthenticated, settings, hydrated, push, markDirty]);

	// Retry unsent work with backoff.
	useEffect(() => {
		if (!isAuthenticated || !hydrated) return;
		if (attempts === 0 || attempts > MAX_RETRY_ATTEMPTS) return;
		const delay = SETTINGS_RETRY_BASE_MS * 2 ** (attempts - 1);
		const timer = setTimeout(() => {
			if (dirtyRef.current.size > 0) void flush();
		}, delay);
		return () => clearTimeout(timer);
	}, [isAuthenticated, hydrated, flush, attempts]);

	// Coming back online is the event the backoff was waiting for, and the one
	// case where giving up after six tries would strand a change indefinitely.
	useEffect(() => {
		const onOnline = () => {
			if (dirtyRef.current.size === 0) return;
			setAttempts(0);
			void flush();
		};
		window.addEventListener("online", onOnline);
		return () => window.removeEventListener("online", onOnline);
	}, [flush]);

	// A toggle flipped in the last 800 ms would otherwise be lost on navigation.
	useEffect(() => {
		const flushNow = () => push.flush();
		const onVisibility = () => {
			if (document.visibilityState === "hidden") flushNow();
		};
		window.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("beforeunload", flushNow);
		return () => {
			window.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("beforeunload", flushNow);
			push.flush();
		};
	}, [push]);
}
