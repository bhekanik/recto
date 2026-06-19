import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Schema } from "prosemirror-model";
import { EditorState as PMEditorState } from "prosemirror-state";
import { EditorView as PMEditorView } from "prosemirror-view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeMarkdown } from "@/lib/markdown";
import { BridgeSession } from "./coordinator";
import { BRIDGE_THROTTLE_MS } from "./protocol";

/**
 * Race-fix regression tests for the live rich/raw bridge (worker: race-fixes).
 *
 * Covers:
 *  - Finding 1: `isActive()` is the gate `useBridgeSession` uses to decide whether
 *    a reactive server-markdown echo may re-seed the bus (`setMarkdown`). Only an
 *    INACTIVE bridge may be re-seeded; an active one's mdast is owned by the panes.
 *  - Finding 2: rich→raw now carries the edit version and drops a superseded apply
 *    (mirror of raw→rich's stale check), so a later raw edit can't be clobbered by
 *    a still-queued rich→raw projection.
 */

// Minimal ProseMirror schema (mirrors bridge.test.ts) so a real PM view mounts.
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

function mountCm(initial: string): EditorView {
	const parent = document.createElement("div");
	document.body.appendChild(parent);
	return new EditorView({
		state: EditorState.create({ doc: initial, extensions: [markdown()] }),
		parent,
	});
}

function mountPm(): PMEditorView {
	const parent = document.createElement("div");
	document.body.appendChild(parent);
	const state = PMEditorState.create({
		doc: schema.node("doc", null, [schema.node("paragraph")]),
	});
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

describe("BridgeSession.isActive (finding 1 gate)", () => {
	it("is inactive until BOTH rich and raw are connected", () => {
		const session = new BridgeSession("# Hi\n");
		expect(session.isActive()).toBe(false);

		const cm = mountCm("# Hi\n");
		cmViews.push(cm);
		session.connectRaw(cm);
		expect(session.isActive()).toBe(false); // raw only

		const pm = mountPm();
		pmViews.push(pm);
		// A trivial parser stub: the rich connection only needs a non-null parser to
		// flip isActive; mode-switch propagation isn't exercised here.
		session.connectRich(pm, ((_text: string) => pm.state.doc) as never);
		expect(session.isActive()).toBe(true); // both connected

		session.disconnectRaw();
		expect(session.isActive()).toBe(false);
	});
});

describe("BridgeSession.setMarkdown (finding 1 — what the gate protects)", () => {
	it("re-seeds the canonical bus from server markdown", () => {
		const session = new BridgeSession("# Old\n");
		session.setMarkdown("# New body\n");
		expect(normalizeMarkdown(session.canonicalMarkdown)).toBe(
			normalizeMarkdown("# New body\n"),
		);
	});
});

describe("BridgeSession rich→raw stale drop (finding 2)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("drops a queued rich→raw apply once a later raw edit bumps the version", () => {
		const session = new BridgeSession("para zero\n");
		const cm = mountCm("para zero\n");
		cmViews.push(cm);
		const pm = mountPm();
		pmViews.push(pm);
		session.connectRaw(cm);
		// Rich is connected but we never let raw→rich touch CM (it targets PM), so CM
		// only ever changes via rich→raw — making the stale-drop directly observable.
		session.connectRich(pm, ((_text: string) => pm.state.doc) as never);

		// Leading edge fires synchronously → CM = "settled". Advance past the window
		// so the next rich edit is a fresh leading edge too.
		session.handleRichUpdate("settled\n");
		vi.advanceTimersByTime(BRIDGE_THROTTLE_MS + 1);
		expect(cm.state.doc.toString()).toBe("settled\n");

		// Leading edge of a new rich burst projects "settled" already in CM. The
		// SECOND call in the same window queues a TRAILING rich→raw carrying this
		// rich edit's version, with the live mdast = parse("stale rich").
		session.handleRichUpdate("settled\n"); // leading edge: no-op (CM already settled)
		session.handleRichUpdate("stale rich\n"); // queues trailing flush at this version

		// A raw edit now BUMPS the version (supersedes the queued rich→raw). It targets
		// PM only — it must not be what keeps CM from changing.
		session.handleRawUpdate("raw wins\n", false);

		vi.advanceTimersByTime(BRIDGE_THROTTLE_MS * 3);

		// The superseded rich→raw trailing flush is dropped as stale: CM must NOT have
		// been rewritten to the stale rich snapshot. Without the version guard, the
		// trailing flush would read live mdast and write "stale rich" into CM.
		expect(cm.state.doc.toString()).not.toBe("stale rich\n");
		expect(cm.state.doc.toString()).toBe("settled\n");
	});
});
