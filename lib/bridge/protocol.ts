import { Annotation } from "@codemirror/state";

/** CodeMirror annotation — tags programmatic bridge/switch transactions. */
export const bridgeOrigin = Annotation.define<number>();

/** ProseMirror transaction meta key. */
export const BRIDGE_META = "recto/bridge";

/** Throttle window for Phase 3 live bridge (ms). */
export const BRIDGE_THROTTLE_MS = 50;

/** Feedback-loop guards for switch/hydrate (Phase 2 scope). */
export class Bridge {
	private version = 0;
	private applyingDepth = 0;

	get isApplying(): boolean {
		return this.applyingDepth > 0;
	}

	beginApplying(): void {
		this.applyingDepth++;
	}

	endApplying(): void {
		this.applyingDepth = Math.max(0, this.applyingDepth - 1);
	}

	bumpVersion(): number {
		return ++this.version;
	}

	get currentVersion(): number {
		return this.version;
	}

	shouldPropagate(isProgrammatic: boolean): boolean {
		if (this.isApplying) return false;
		if (isProgrammatic) return false;
		return true;
	}

	isStale(derivedFromVersion: number): boolean {
		return derivedFromVersion < this.version;
	}
}
