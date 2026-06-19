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

	private scheduleRichToRawFn = throttleTrailing((version: number) => {
		// Mirror the raw→rich stale check: if a later RAW edit bumped the version
		// after this rich edit was scheduled, this rich→raw apply is superseded —
		// dropping it stops a stale rich snapshot from clobbering the newer raw text
		// in the complementary pane (the version, not the live mdast, encodes edit
		// ordering; raw→rich will apply the winning text).
		if (this.bridge.isStale(version)) return;
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
		const version = this.bridge.bumpVersion();
		this.mdast = parseMarkdown(normalizeMarkdown(markdown));
		// Capture this edit's version so a later raw edit can supersede a still-queued
		// rich→raw apply (symmetry with handleRawUpdate / scheduleRawToRichFn).
		this.scheduleRichToRawFn(version);
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
