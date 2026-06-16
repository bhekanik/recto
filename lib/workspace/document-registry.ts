import type { Id } from "@/convex/_generated/dataModel";
import type { BridgeSession } from "@/lib/bridge/coordinator";
import type { CodeMirrorEditorHandle } from "@/lib/editor/codemirror";
import type { EditorHandle } from "@/lib/editor/handle";
import type { MilkdownEditorHandle } from "@/lib/editor/milkdown";
import type { Mode } from "@/lib/modes/types";

/**
 * The registration stores the editor *ref objects* (not a snapshot of `.current`)
 * so the handles are read lazily. This survives the editor remounting during a
 * pane's document rebind — a snapshot would freeze a transient `null`.
 */
export type PaneRegistration = {
	paneId: string;
	mode: Mode;
	richRef: { current: MilkdownEditorHandle | null };
	cmRef: { current: CodeMirrorEditorHandle | null };
};

export type DocumentEntry = {
	refCount: number;
	paneIds: Set<string>;
	registrations: Map<string, PaneRegistration>;
	bridge: BridgeSession | null;
};

/** In-memory registry keyed by documentId — one canonical model bus per doc. */
export class DocumentModelRegistry {
	private entries = new Map<Id<"documents">, DocumentEntry>();
	private manuallyRenamed = new Set<Id<"documents">>();

	isManuallyRenamed(documentId: Id<"documents">): boolean {
		return this.manuallyRenamed.has(documentId);
	}

	markManualRename(documentId: Id<"documents">): void {
		this.manuallyRenamed.add(documentId);
	}

	acquire(documentId: Id<"documents">): void {
		const entry = this.entries.get(documentId);
		if (entry) {
			entry.refCount++;
			return;
		}
		this.entries.set(documentId, {
			refCount: 1,
			paneIds: new Set(),
			registrations: new Map(),
			bridge: null,
		});
	}

	release(documentId: Id<"documents">): void {
		const entry = this.entries.get(documentId);
		if (!entry) return;
		entry.refCount--;
		if (entry.refCount <= 0) {
			entry.bridge?.destroy();
			this.entries.delete(documentId);
		}
	}

	registerPane(
		documentId: Id<"documents">,
		registration: PaneRegistration,
	): void {
		const entry = this.entries.get(documentId);
		if (!entry) return;
		entry.paneIds.add(registration.paneId);
		entry.registrations.set(registration.paneId, registration);
	}

	unregisterPane(documentId: Id<"documents">, paneId: string): void {
		const entry = this.entries.get(documentId);
		if (!entry) return;
		entry.paneIds.delete(paneId);
		entry.registrations.delete(paneId);
	}

	getBridge(documentId: Id<"documents">): BridgeSession | null {
		return this.entries.get(documentId)?.bridge ?? null;
	}

	setBridge(documentId: Id<"documents">, bridge: BridgeSession | null): void {
		const entry = this.entries.get(documentId);
		if (!entry) return;
		if (entry.bridge && entry.bridge !== bridge) {
			entry.bridge.destroy();
		}
		entry.bridge = bridge;
	}

	getPrimaryHandle(
		documentId: Id<"documents">,
		activePaneId: string | null,
	): EditorHandle | null {
		const entry = this.entries.get(documentId);
		if (!entry) return null;

		const tryRegistration = (
			reg: PaneRegistration | undefined,
		): EditorHandle | null => {
			if (!reg) return null;
			if (reg.mode === "rich") return reg.richRef.current;
			if (reg.mode === "raw" || reg.mode === "vim") return reg.cmRef.current;
			return null;
		};

		if (activePaneId) {
			const active = entry.registrations.get(activePaneId);
			const handle = tryRegistration(active);
			if (handle) return handle;
		}

		for (const reg of entry.registrations.values()) {
			const handle = tryRegistration(reg);
			if (handle) return handle;
		}
		return null;
	}

	/**
	 * Declaratively sync the bridge's editor connections to the current pane
	 * registrations. Returns `true` when wiring is settled — either every
	 * complementary pane that exists is connected, or there is nothing to bridge.
	 * Returns `false` while a needed editor view is still mounting (the caller
	 * should retry — Milkdown creates its ProseMirror view asynchronously, so
	 * `getPmView()` can be null for a few frames after the pane registers).
	 */
	wireBridge(documentId: Id<"documents">): boolean {
		const entry = this.entries.get(documentId);
		if (!entry?.bridge) return true;

		let richPane: PaneRegistration | undefined;
		let rawPane: PaneRegistration | undefined;

		for (const reg of entry.registrations.values()) {
			if (reg.mode === "rich") richPane = reg;
			if (reg.mode === "raw" || reg.mode === "vim") rawPane = reg;
		}

		const pmView = richPane?.richRef.current?.getPmView() ?? null;
		const parser = richPane?.richRef.current?.getParser() ?? null;
		const cmView = rawPane?.cmRef.current?.getCmView() ?? null;

		if (richPane && pmView && parser) {
			entry.bridge.connectRich(pmView, parser);
		} else {
			entry.bridge.disconnectRich();
		}

		if (rawPane && cmView) {
			entry.bridge.connectRaw(cmView);
		} else {
			entry.bridge.disconnectRaw();
		}

		const richReady = !richPane || Boolean(pmView && parser);
		const rawReady = !rawPane || Boolean(cmView);
		return richReady && rawReady;
	}
}
