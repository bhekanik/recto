import { recreateTransform } from "@manuscripts/prosemirror-recreate-steps";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView as PMEditorView } from "prosemirror-view";

import { BRIDGE_META, type Bridge } from "./protocol.ts";

export type RawToRichMetrics = {
	dispatched: boolean;
	latencyMs: number;
};

/** Parse target doc and apply recreated steps to live ProseMirror view. */
export function propagateRawToRich(
	pmView: PMEditorView,
	nextDoc: PMNode,
	bridge: Bridge,
	onMetrics?: (m: RawToRichMetrics) => void,
): void {
	const start = performance.now();
	const { state } = pmView;
	const curDoc = state.doc;

	if (curDoc.eq(nextDoc)) {
		onMetrics?.({ dispatched: false, latencyMs: performance.now() - start });
		return;
	}

	const tr = recreateTransform(curDoc, nextDoc, true, false);
	const live = state.tr;

	for (const step of tr.steps) {
		const mapped = step.map(live.mapping);
		if (mapped) live.step(mapped);
	}

	live.setSelection(state.selection.map(live.doc, live.mapping));
	live.setMeta(BRIDGE_META, bridge.nextVersion());
	live.setMeta("addToHistory", false);

	bridge.beginApplying();
	try {
		pmView.dispatch(live);
	} finally {
		bridge.endApplying();
	}

	onMetrics?.({ dispatched: true, latencyMs: performance.now() - start });
}
