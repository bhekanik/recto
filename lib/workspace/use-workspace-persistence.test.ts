import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The migration from the single shared `workspaces` row to per-device rows is
 * the one change here that every existing user walks through on their next
 * page load, and getting it wrong resets their panes. These tests drive the
 * real hook with the Convex query results mocked, because that ordering — wait
 * for the device row, only then fall back to the legacy row — is the whole
 * behaviour.
 */
type DeviceRow = { json: string; updatedAt: number } | null | undefined;
type LegacyRow =
	| {
			paneTree: string;
			activePaneId: string;
			perPaneViewState: string;
	  }
	| null
	| undefined;

const state = {
	device: undefined as DeviceRow,
	legacy: undefined as LegacyRow,
};

const saveMock = vi.fn(
	async (_args: { deviceId: string; deviceClass: string; json: string }) => ({
		updatedAt: 1,
	}),
);
const queryCalls: { name: string; args: unknown }[] = [];

vi.mock("convex/react", async () => {
	// `api.x.y` is a fresh proxy on every access and throws when stringified;
	// getFunctionName is the supported way to identify one.
	const { getFunctionName } = await import("convex/server");
	return {
		useQuery: (
			reference: Parameters<typeof getFunctionName>[0],
			args: unknown,
		) => {
			const name = getFunctionName(reference);
			queryCalls.push({ name, args });
			if (args === "skip") return undefined;
			return name.includes("getForDevice") ? state.device : state.legacy;
		},
		useMutation: () => saveMock,
	};
});

const { useWorkspacePersistence } = await import("./use-workspace-persistence");
const { DEVICE_ID_STORAGE_KEY } = await import("./device");
const { collectLeaves } = await import("./queries");
const { serializeWorkspace } = await import("./operations");
const { createDefaultWorkspace } = await import("./defaults");

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
let latest: ReturnType<typeof useWorkspacePersistence> | null = null;

function Harness() {
	latest = useWorkspacePersistence({
		enabled: true,
		validDocumentIds: new Set<string>(),
	});
	return null;
}

function render() {
	act(() => {
		root.render(createElement(Harness));
	});
}

/** A saved layout with two panes, so a reset to the default is visible. */
function twoPaneLayout() {
	const workspace = createDefaultWorkspace();
	const serialized = serializeWorkspace(workspace.paneTree);
	return {
		paneTree: serialized.paneTree,
		activePaneId: workspace.activePaneId,
		perPaneViewState: serialized.perPaneViewState,
	};
}

beforeEach(() => {
	// @ts-expect-error React's act environment flag is not in the DOM typings.
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	saveMock.mockClear();
	queryCalls.length = 0;
	state.device = undefined;
	state.legacy = undefined;
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
});

describe("useWorkspacePersistence device migration", () => {
	it("mints and persists a device id on first run", () => {
		state.device = null;
		state.legacy = null;
		render();

		const minted = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY);
		expect(minted).toBeTruthy();

		// A second mount reuses it — a fresh id every reload would abandon the
		// layout row on every visit.
		act(() => root.render(createElement(Harness)));
		expect(window.localStorage.getItem(DEVICE_ID_STORAGE_KEY)).toBe(minted);
	});

	it("stays loading until the device row has been answered", () => {
		state.device = undefined;
		render();
		expect(latest?.loading).toBe(true);
		expect(latest?.workspace).toBeNull();
	});

	it("does not hydrate a default over a legacy row that has not arrived yet", () => {
		// The failure this guards: device row null, legacy query still in flight,
		// hook decides "nothing saved" and resets the writer's panes.
		state.device = null;
		state.legacy = undefined;
		render();

		expect(latest?.isHydrated).toBe(false);
		expect(latest?.workspace).toBeNull();
	});

	it("migrates the legacy row when this device has none", () => {
		const legacy = twoPaneLayout();
		state.device = null;
		state.legacy = legacy;
		render();

		expect(latest?.isHydrated).toBe(true);
		expect(latest?.workspace?.activePaneId).toBe(legacy.activePaneId);
	});

	it("prefers this device's own row over the legacy row", () => {
		const own = twoPaneLayout();
		state.device = { json: JSON.stringify(own), updatedAt: 5 };
		state.legacy = { ...twoPaneLayout(), activePaneId: "legacy-pane" };
		render();

		expect(latest?.workspace?.activePaneId).toBe(own.activePaneId);
	});

	it("skips the legacy query entirely once this device has a row", () => {
		state.device = { json: JSON.stringify(twoPaneLayout()), updatedAt: 5 };
		render();

		const legacyCalls = queryCalls.filter(
			(call) => !call.name.includes("getForDevice"),
		);
		expect(legacyCalls).not.toHaveLength(0);
		expect(legacyCalls.every((call) => call.args === "skip")).toBe(true);
	});

	it("falls back to a fresh workspace when the stored blob is unusable", () => {
		state.device = { json: "not json at all", updatedAt: 5 };
		render();

		expect(latest?.isHydrated).toBe(true);
		expect(collectLeaves(latest?.workspace?.paneTree as never)).toHaveLength(1);
	});

	it("writes layout changes to this device's row, tagged as web", async () => {
		state.device = null;
		state.legacy = null;
		render();

		const workspace = latest?.workspace;
		expect(workspace).not.toBeNull();
		await act(async () => {
			await latest?.flushSave();
		});

		expect(saveMock).toHaveBeenCalled();
		const sent = saveMock.mock.calls[0]?.[0];
		expect(sent).toBeDefined();
		if (!sent) return;
		expect(sent.deviceClass).toBe("web");
		expect(sent.deviceId).toBe(
			window.localStorage.getItem(DEVICE_ID_STORAGE_KEY),
		);
		expect(JSON.parse(sent.json)).toHaveProperty("paneTree");
	});
});
