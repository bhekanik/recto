import { describe, expect, it } from "vitest";

import {
	FOCUS_EDITOR_EVENT,
	FOCUS_PANE_EVENT,
	HISTORY_REDO_EVENT,
	HISTORY_UNDO_EVENT,
	LINT_COUNT_EVENT,
	SWITCH_MODE_EVENT,
} from "@/lib/events";

// These strings are the wire contract between each dispatcher and its listener
// (e.g. PaneEditor dispatches LINT_COUNT_EVENT, studio-shell listens for it). A
// drifting value silently no-ops the pair, so pin the exact names here.
describe("event-name constants", () => {
	it("keep their exact recto: wire names", () => {
		expect(LINT_COUNT_EVENT).toBe("recto:lint-count");
		expect(HISTORY_UNDO_EVENT).toBe("recto:history-undo");
		expect(HISTORY_REDO_EVENT).toBe("recto:history-redo");
		expect(SWITCH_MODE_EVENT).toBe("recto:switch-mode");
		expect(FOCUS_EDITOR_EVENT).toBe("recto:focus-editor");
		expect(FOCUS_PANE_EVENT).toBe("recto:focus-pane");
	});
});
