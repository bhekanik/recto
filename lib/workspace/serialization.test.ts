import { describe, expect, it } from "vitest";
import { createDefaultWorkspace } from "./defaults";
import { serializeWorkspace, splitPane } from "./operations";
import { countPanes } from "./queries";
import { MAX_OPEN_PANES } from "./types";

describe("serializeWorkspace size guard", () => {
	it("realistic 2–6 pane layout stays well under 1 MiB", () => {
		let tree = createDefaultWorkspace().paneTree;
		while (countPanes(tree) < 6) {
			const leaves = countPanes(tree);
			const paneId =
				tree.type === "pane"
					? tree.paneId
					: tree.children[0]?.type === "pane"
						? tree.children[0].paneId
						: "missing";
			const result = splitPane(
				tree,
				paneId,
				leaves % 2 === 0 ? "vertical" : "horizontal",
			);
			if (!result) break;
			tree = result.tree;
		}

		const serialized = serializeWorkspace(tree);
		const totalBytes =
			serialized.paneTree.length +
			serialized.perPaneViewState.length +
			serialized.openDocumentIds.length * 20;

		expect(totalBytes).toBeLessThan(100_000);
	});

	it("adversarial max panes layout stays under 100KB serialized", () => {
		let tree = createDefaultWorkspace().paneTree;
		let guard = 0;
		while (countPanes(tree) < MAX_OPEN_PANES && guard < 20) {
			guard++;
			const firstLeaf =
				tree.type === "pane"
					? tree.paneId
					: tree.children.find((c) => c.type === "pane")?.paneId;
			if (!firstLeaf) break;
			const result = splitPane(tree, firstLeaf, "horizontal");
			if (!result) break;
			tree = result.tree;
		}

		const serialized = serializeWorkspace(tree);
		expect(serialized.paneTree.length).toBeLessThan(100_000);
	});
});
