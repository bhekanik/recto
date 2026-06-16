import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { recreateTransform } from "@manuscripts/prosemirror-recreate-steps";
import { Schema } from "prosemirror-model";
import { EditorState as PMEditorState, TextSelection } from "prosemirror-state";
import { EditorView as PMEditorView } from "prosemirror-view";
import { afterEach, describe, expect, it } from "vitest";

import {
	normalizeMarkdown,
	parseMarkdown,
	stringifyMdast,
} from "@/lib/markdown";
import { diffRanges } from "./diff-ranges";
import { Bridge } from "./protocol";
import { propagateRawToRich } from "./raw-to-rich";
import { propagateRichToRaw } from "./rich-to-raw";

/**
 * Production bridge guard tests (blueprint 05 §11). These mirror the proven
 * Phase-0 spike against the real `lib/bridge` + `lib/markdown` modules, so the
 * D6 live two-mode contract is regression-tested in-app, not only in the spike.
 */

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

const cmViews: EditorView[] = [];
const pmViews: PMEditorView[] = [];

afterEach(() => {
	for (const v of cmViews) v.destroy();
	for (const v of pmViews) v.destroy();
	cmViews.length = 0;
	pmViews.length = 0;
});

describe("diffRanges (minimal change)", () => {
	it("finds the minimal contiguous change", () => {
		expect(diffRanges("hello world", "hello brave world")).toEqual({
			from: 6,
			to: 6,
			insert: "brave ",
		});
	});

	it("returns an empty-range insert for an append", () => {
		expect(diffRanges("ab", "abc")).toEqual({ from: 2, to: 2, insert: "c" });
	});
});

describe("Bridge feedback-loop guards (blueprint 05 §5)", () => {
	it("blocks propagation while applying a programmatic update", () => {
		const bridge = new Bridge();
		bridge.beginApplying();
		expect(bridge.shouldPropagate(false)).toBe(false);
		bridge.endApplying();
		expect(bridge.shouldPropagate(false)).toBe(true);
	});

	it("blocks programmatic (bridge-origin) changes", () => {
		const bridge = new Bridge();
		expect(bridge.shouldPropagate(true)).toBe(false);
	});

	it("drops stale projections by version", () => {
		const bridge = new Bridge();
		bridge.bumpVersion();
		bridge.bumpVersion();
		expect(bridge.isStale(1)).toBe(true);
		expect(bridge.isStale(2)).toBe(false);
	});

	it("a single human edit yields one bumpVersion with no echo", () => {
		const bridge = new Bridge();
		const start = bridge.currentVersion;
		expect(bridge.shouldPropagate(false)).toBe(true);
		const v = bridge.bumpVersion();
		expect(v).toBe(start + 1);
		// The programmatic projection back into this pane must not re-propagate.
		expect(bridge.shouldPropagate(true)).toBe(false);
		expect(bridge.currentVersion).toBe(v);
	});
});

describe("cursor stability across reprojection (blueprint 05 §7)", () => {
	it("keeps the CM caret put when a rich→raw edit lands after it", () => {
		const bridge = new Bridge();
		const cm = mountCm("# Title\n\nBody text here.\n");
		cmViews.push(cm);
		cm.dispatch({ selection: { anchor: 16, head: 16 } });
		const before = cm.state.selection.main.head;

		propagateRichToRaw(
			cm,
			parseMarkdown("# Title\n\nBody text here!!!\n"),
			bridge,
		);

		expect(cm.state.selection.main.head).toBe(before);
	});

	it("maps the PM caret forward when a raw→rich insert precedes it", () => {
		const bridge = new Bridge();
		const pm = mountPm("Hello world");
		pmViews.push(pm);
		pm.dispatch(
			pm.state.tr.setSelection(TextSelection.create(pm.state.doc, 8)),
		);
		const before = pm.state.selection.from;

		propagateRawToRich(pm, pmDoc("Hello brave world"), bridge);

		expect(pm.state.selection.from).toBe(before + "brave ".length);
	});
});

describe("no progressive drift (blueprint 05 §10, anti-#7147)", () => {
	it("stays byte-identical to canonical serialize(parse) over 30 cycles", () => {
		const bridge = new Bridge();
		let text = normalizeMarkdown("# Start\n\nParagraph one.\n");
		const cm = mountCm(text);
		cmViews.push(cm);

		for (let i = 0; i < 30; i++) {
			const op = i % 2 === 0 ? "!" : "?";
			text = cm.state.doc.toString();
			const next = text.replace(/Paragraph one[!?.]*/, `Paragraph one${op}`);
			const mdast = parseMarkdown(next);
			const canonical = stringifyMdast(mdast);
			propagateRichToRaw(cm, mdast, bridge);
			expect(cm.state.doc.toString()).toBe(canonical);
		}

		const final = normalizeMarkdown(cm.state.doc.toString());
		expect(final).toBe(normalizeMarkdown(stringifyMdast(parseMarkdown(final))));
	});

	it("dispatches zero transactions when the panes are already converged", () => {
		const bridge = new Bridge();
		const md = "# Same\n\nContent.\n";
		const cm = mountCm(normalizeMarkdown(md));
		cmViews.push(cm);

		let dispatched = true;
		propagateRichToRaw(cm, parseMarkdown(md), bridge, (m) => {
			dispatched = m.dispatched;
		});
		expect(dispatched).toBe(false);
	});
});

describe("propagation latency (blueprint 05 §6, ADR-15)", () => {
	it("keeps rich→raw p50 sub-frame", () => {
		const bridge = new Bridge();
		const samples: number[] = [];
		const mdast = parseMarkdown("# Latency\n\nTest.\n");
		const cm = mountCm(stringifyMdast(mdast));
		cmViews.push(cm);

		for (let i = 0; i < 20; i++) {
			mdast.children[1] = {
				type: "paragraph",
				children: [{ type: "text", value: `Test ${i}.` }],
			};
			propagateRichToRaw(cm, mdast, bridge, (m) => samples.push(m.latencyMs));
		}

		samples.sort((a, b) => a - b);
		expect(samples[Math.floor(samples.length * 0.5)] ?? 0).toBeLessThan(16);
	});
});

describe("recreateTransform package pin (ADR-15)", () => {
	it("produces steps between two docs", () => {
		const tr = recreateTransform(pmDoc("abc"), pmDoc("axxc"), true, false);
		expect(tr.steps.length).toBeGreaterThan(0);
	});
});
