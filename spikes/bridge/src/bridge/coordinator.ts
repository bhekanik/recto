import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
	defaultValueCtx,
	Editor,
	editorViewCtx,
	parserCtx,
	rootCtx,
} from "@milkdown/core";
import type { Ctx } from "@milkdown/ctx";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import type { Parser } from "@milkdown/transformer";
import { getMarkdown } from "@milkdown/utils";
import type { Root } from "mdast";
import type { EditorView as PMEditorView } from "prosemirror-view";

import {
	normalizeMarkdown,
	parseMarkdown,
	stringifyMdast,
} from "../canonical/markdown.ts";
import { BRIDGE_THROTTLE_MS, Bridge, bridgeOrigin } from "./protocol.ts";
import { propagateRawToRich, type RawToRichMetrics } from "./raw-to-rich.ts";
import { propagateRichToRaw, type RichToRawMetrics } from "./rich-to-raw.ts";
import { throttleTrailing } from "./schedule.ts";

export type BridgeMetrics = {
	richToRaw: RichToRawMetrics[];
	rawToRich: RawToRichMetrics[];
};

export const SAMPLE_MARKDOWN = `---
title: Spike A
---

# Hello Recto

This is a **live bridge** spike between Milkdown and CodeMirror.

- item one
- item two

| col a | col b |
| ----- | ----- |
| 1     | 2     |

> A blockquote with _emphasis_.
`;

/** Wires Milkdown + CodeMirror to one in-memory MDAST bus. */
export class BridgeCoordinator {
	readonly bridge = new Bridge();
	readonly metrics: BridgeMetrics = { richToRaw: [], rawToRich: [] };

	private mdast: Root;
	private cmView: EditorView | null = null;
	private pmView: PMEditorView | null = null;
	private milkdownParser: Parser | null = null;
	private milkdownEditor: Editor | null = null;

	private scheduleRichToRawFn = throttleTrailing(() => {
		if (!this.cmView) return;
		propagateRichToRaw(this.cmView, this.mdast, this.bridge, (m) =>
			this.metrics.richToRaw.push(m),
		);
	}, BRIDGE_THROTTLE_MS);

	private scheduleRawToRichFn = throttleTrailing(
		(text: string, version: number) => {
			if (this.bridge.isStale(version)) return;
			if (!this.pmView || !this.milkdownParser) return;
			this.mdast = parseMarkdown(text);
			const nextDoc = this.milkdownParser(normalizeMarkdown(text));
			propagateRawToRich(this.pmView, nextDoc, this.bridge, (m) =>
				this.metrics.rawToRich.push(m),
			);
		},
		BRIDGE_THROTTLE_MS,
	);

	constructor(initialMarkdown = SAMPLE_MARKDOWN) {
		this.mdast = parseMarkdown(normalizeMarkdown(initialMarkdown));
	}

	get canonicalMarkdown(): string {
		return stringifyMdast(this.mdast);
	}

	getMdast(): Root {
		return this.mdast;
	}

	setMdast(mdast: Root): void {
		this.mdast = mdast;
	}

	getCmView(): EditorView | null {
		return this.cmView;
	}

	getPmView(): PMEditorView | null {
		return this.pmView;
	}

	async mountRich(container: HTMLElement): Promise<void> {
		const initial = this.canonicalMarkdown;

		this.milkdownEditor = await Editor.make()
			.config((ctx: Ctx) => {
				ctx.set(rootCtx, container);
				ctx.set(defaultValueCtx, initial);
				this.milkdownParser = ctx.get(parserCtx);
				this.pmView = ctx.get(editorViewCtx);
			})
			.use(commonmark)
			.use(gfm)
			.use(listener)
			.config((ctx: Ctx) => {
				ctx.get(listenerCtx).markdownUpdated((_ctx, md, prevMd) => {
					if (md === prevMd) return;
					if (!this.bridge.shouldPropagate(false)) return;

					this.bridge.bumpVersion();
					this.mdast = parseMarkdown(normalizeMarkdown(md));
					this.scheduleRichToRawFn();
				});
			})
			.create();
	}

	mountRaw(container: HTMLElement): void {
		const initial = this.canonicalMarkdown;

		this.cmView = new EditorView({
			state: EditorState.create({
				doc: initial,
				extensions: [
					markdown(),
					EditorView.updateListener.of((update) => {
						if (!update.docChanged) return;
						const isProgrammatic = update.transactions.some(
							(t) => t.annotation(bridgeOrigin) != null,
						);
						if (!this.bridge.shouldPropagate(isProgrammatic)) return;

						const version = this.bridge.bumpVersion();
						this.scheduleRawToRichFn(update.state.doc.toString(), version);
					}),
				],
			}),
			parent: container,
		});
	}

	/** Read live rich markdown via Milkdown serializer (for tests). */
	readRichMarkdown(): string {
		if (!this.milkdownEditor) return this.canonicalMarkdown;
		return this.milkdownEditor.action(getMarkdown());
	}

	async destroy(): Promise<void> {
		await this.milkdownEditor?.destroy();
		this.cmView?.destroy();
		this.cmView = null;
		this.pmView = null;
	}
}
