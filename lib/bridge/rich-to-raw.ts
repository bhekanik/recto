import type { EditorView } from "@codemirror/view";
import type { Root } from "mdast";

import { stringifyMdast } from "@/lib/markdown";
import { diffRanges } from "./diff-ranges";
import { type Bridge, bridgeOrigin } from "./protocol";

export type RichToRawMetrics = {
	dispatched: boolean;
	latencyMs: number;
};

/** Serialize MDAST and apply minimal diff to CodeMirror. */
export function propagateRichToRaw(
	cm: EditorView,
	mdast: Root,
	bridge: Bridge,
	onMetrics?: (m: RichToRawMetrics) => void,
): void {
	const start = performance.now();
	const next = stringifyMdast(mdast);
	const prev = cm.state.doc.toString();

	if (next === prev) {
		onMetrics?.({ dispatched: false, latencyMs: performance.now() - start });
		return;
	}

	const change = diffRanges(prev, next);
	bridge.beginApplying();
	try {
		cm.dispatch({
			changes: change,
			annotations: bridgeOrigin.of(bridge.nextVersion()),
			scrollIntoView: false,
		});
	} finally {
		bridge.endApplying();
	}

	onMetrics?.({ dispatched: true, latencyMs: performance.now() - start });
}
