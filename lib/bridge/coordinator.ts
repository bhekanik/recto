import type { EditorView } from "@codemirror/view";
import type { Parser } from "@milkdown/transformer";
import type { Root } from "mdast";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView as PMEditorView } from "prosemirror-view";

import {
	normalizeMarkdown,
	parseMarkdown,
	splitFrontmatter,
	stringifyMdast,
} from "@/lib/markdown";
import { BRIDGE_THROTTLE_MS, Bridge } from "./protocol";
import { propagateRawToRich } from "./raw-to-rich";
import { propagateRichToRaw } from "./rich-to-raw";
import { throttleTrailing } from "./schedule";

/** Live bridge between rich and raw panes sharing one MDAST bus. */
export class BridgeSession {
	readonly bridge = new Bridge();

	private mdast: Root;
	private cmView: EditorView | null = null;
	private pmView: PMEditorView | null = null;
	private milkdownParser: Parser | null = null;

	private scheduleRichToRawFn = throttleTrailing(() => {
		if (!this.cmView) return;
		propagateRichToRaw(this.cmView, this.mdast, this.bridge);
	}, BRIDGE_THROTTLE_MS);

	private scheduleRawToRichFn = throttleTrailing(
		(text: string, version: number) => {
			if (this.bridge.isStale(version)) return;
			if (!this.pmView || !this.milkdownParser) return;
			this.mdast = parseMarkdown(text);
			// The rich surface renders BODY only — strip frontmatter so the raw
			// pane's `---` block never lands as content in ProseMirror.
			const { body } = splitFrontmatter(text);
			const nextDoc = this.milkdownParser(normalizeMarkdown(body));
			propagateRawToRich(this.pmView, nextDoc, this.bridge);
		},
		BRIDGE_THROTTLE_MS,
	);

	constructor(initialMarkdown = "") {
		this.mdast = parseMarkdown(normalizeMarkdown(initialMarkdown));
	}

	get canonicalMarkdown(): string {
		return stringifyMdast(this.mdast);
	}

	setMarkdown(markdown: string): void {
		this.mdast = parseMarkdown(normalizeMarkdown(markdown));
	}

	connectRaw(cmView: EditorView): void {
		this.cmView = cmView;
	}

	connectRich(pmView: PMEditorView, parser: Parser): void {
		this.pmView = pmView;
		this.milkdownParser = parser;
	}

	disconnectRaw(): void {
		this.cmView = null;
	}

	disconnectRich(): void {
		this.pmView = null;
		this.milkdownParser = null;
	}

	isActive(): boolean {
		return this.cmView !== null && this.pmView !== null;
	}

	handleRichUpdate(markdown: string): void {
		if (!this.bridge.shouldPropagate(false)) return;
		this.bridge.bumpVersion();
		this.mdast = parseMarkdown(normalizeMarkdown(markdown));
		this.scheduleRichToRawFn();
	}

	handleRawUpdate(text: string, isProgrammatic: boolean): void {
		if (!this.bridge.shouldPropagate(isProgrammatic)) return;
		const version = this.bridge.bumpVersion();
		this.scheduleRawToRichFn(text, version);
	}

	destroy(): void {
		this.disconnectRaw();
		this.disconnectRich();
	}
}

export type { PMNode };
