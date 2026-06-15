import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { recreateTransform } from "@manuscripts/prosemirror-recreate-steps";
import { Schema } from "prosemirror-model";
import { EditorState as PMEditorState, TextSelection } from "prosemirror-state";
import { EditorView as PMEditorView } from "prosemirror-view";
import { afterEach, describe, expect, it } from "vitest";
import { Bridge } from "../src/bridge/protocol.ts";
import { propagateRawToRich } from "../src/bridge/raw-to-rich.ts";
import { propagateRichToRaw } from "../src/bridge/rich-to-raw.ts";
import {
	normalizeMarkdown,
	parseMarkdown,
	stringifyMdast,
} from "../src/canonical/markdown.ts";

const schema = new Schema({
	nodes: {
		doc: { content: "block+" },
		paragraph: {
			content: "inline*",
			group: "block",
			parseDOM: [{ tag: "p" }],
			toDOM: () => ["p", 0],
		},
		text: { group: "inline" },
	},
});

function pmDoc(text: string) {
	const para = schema.node("paragraph", null, text ? [schema.text(text)] : []);
	return schema.node("doc", null, [para]);
}

function mountCm(initial: string): EditorView {
	const parent = document.createElement("div");
	document.body.appendChild(parent);
	return new EditorView({
		state: EditorState.create({ doc: initial, extensions: [markdown()] }),
		parent,
	});
}

function mountPm(initial: string): PMEditorView {
	const parent = document.createElement("div");
	document.body.appendChild(parent);
	const state = PMEditorState.create({ doc: pmDoc(initial) });
	return new PMEditorView(parent, { state });
}

const views: EditorView[] = [];
const pmViews: PMEditorView[] = [];

afterEach(() => {
	for (const v of views) v.destroy();
	for (const v of pmViews) v.destroy();
	views.length = 0;
	pmViews.length = 0;
});

describe("cursor stability harness", () => {
	it("maps CM selection through rich→raw diff when edit is after caret", () => {
		const bridge = new Bridge();
		const prev = "# Title\n\nBody text here.\n";
		const next = "# Title\n\nBody text here!!!\n";
		const cm = mountCm(prev);
		views.push(cm);

		// Caret in "Body" word (offset 16).
		cm.dispatch({ selection: { anchor: 16, head: 16 } });
		const caretBefore = cm.state.selection.main.head;

		const mdast = parseMarkdown(next);
		propagateRichToRaw(cm, mdast, bridge);

		expect(cm.state.selection.main.head).toBe(caretBefore);
	});

	it("maps PM selection through raw→rich when insert is before caret", () => {
		const bridge = new Bridge();
		const pm = mountPm("Hello world");
		pmViews.push(pm);

		pm.dispatch(
			pm.state.tr.setSelection(TextSelection.create(pm.state.doc, 8)),
		);
		const caretBefore = pm.state.selection.from;

		propagateRawToRich(pm, pmDoc("Hello brave world"), bridge);

		// Insert before caret shifts position forward by inserted length.
		expect(pm.state.selection.from).toBe(caretBefore + "brave ".length);
	});
});

describe("no-drift over alternating edits", () => {
	it("stays byte-identical to canonical serialize(parse) after many CM-only cycles", () => {
		const bridge = new Bridge();
		let text = normalizeMarkdown("# Start\n\nParagraph one.\n");
		const cm = mountCm(text);
		views.push(cm);

		for (let i = 0; i < 30; i++) {
			const op = i % 2 === 0 ? "!" : "?";
			text = cm.state.doc.toString();
			const next = text.replace("Paragraph one.", `Paragraph one${op}`);
			const mdast = parseMarkdown(next);
			const canonical = stringifyMdast(mdast);
			propagateRichToRaw(cm, mdast, bridge);
			expect(cm.state.doc.toString()).toBe(canonical);
			text = canonical;
		}

		const finalCanonical = normalizeMarkdown(cm.state.doc.toString());
		expect(finalCanonical).toBe(
			normalizeMarkdown(stringifyMdast(parseMarkdown(finalCanonical))),
		);
	});

	it("dispatches zero transactions when converged", () => {
		const bridge = new Bridge();
		const md = "# Same\n\nContent.\n";
		const cm = mountCm(md);
		views.push(cm);
		const mdast = parseMarkdown(md);

		let dispatched = false;
		propagateRichToRaw(cm, mdast, bridge, (m) => {
			dispatched = m.dispatched;
		});
		expect(dispatched).toBe(false);
	});
});

describe("propagation latency", () => {
	it("captures sub-frame rich→raw latency distribution", () => {
		const bridge = new Bridge();
		const samples: number[] = [];
		const mdast = parseMarkdown("# Latency\n\nTest.\n");
		const cm = mountCm(stringifyMdast(mdast));
		views.push(cm);

		for (let i = 0; i < 20; i++) {
			mdast.children[1] = {
				type: "paragraph",
				children: [{ type: "text", value: `Test ${i}.` }],
			};
			propagateRichToRaw(cm, mdast, bridge, (m) => samples.push(m.latencyMs));
		}

		samples.sort((a, b) => a - b);
		const p50 = samples[Math.floor(samples.length * 0.5)] ?? 0;
		const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
		expect(p50).toBeLessThan(16);
		expect(p95).toBeLessThan(32);
	});

	it("raw→rich recreateTransform stays sub-frame at p50", () => {
		const bridge = new Bridge();
		const pm = mountPm("Hello");
		pmViews.push(pm);
		const samples: number[] = [];

		for (let i = 0; i < 10; i++) {
			propagateRawToRich(pm, pmDoc(`Hello iteration ${i}`), bridge, (m) =>
				samples.push(m.latencyMs),
			);
		}

		samples.sort((a, b) => a - b);
		const p50 = samples[Math.floor(samples.length * 0.5)] ?? 0;
		expect(p50).toBeLessThan(16);
	});
});

describe("recreateTransform package", () => {
	it("produces steps between two docs (@manuscripts/prosemirror-recreate-steps@0.1.4)", () => {
		const a = pmDoc("abc");
		const b = pmDoc("axxc");
		const tr = recreateTransform(a, b, true, false);
		expect(tr.steps.length).toBeGreaterThan(0);
	});
});
