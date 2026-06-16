"use client";

import { Fragment, useCallback } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

import { PaneEditor } from "@/components/workspace/pane-editor";
import { cn } from "@/lib/utils";
import { MIN_PANE_PERCENT, type PaneNode, paneKey } from "@/lib/workspace";
import { countPanes } from "@/lib/workspace/queries";
import type { PaneSplit } from "@/lib/workspace/types";
import { useWorkspace } from "@/lib/workspace/workspace-context";

type RenderPaneNodeProps = {
	node: PaneNode;
	onOpenSwitcher: () => void;
	onCreate: () => void;
};

function PaneSplitView({
	node,
	onOpenSwitcher,
	onCreate,
}: {
	node: PaneSplit;
	onOpenSwitcher: () => void;
	onCreate: () => void;
}) {
	const { actions } = useWorkspace();

	const onLayoutChanged = useCallback(
		(layout: Record<string, number>) => {
			const sizes = node.children.map((child, index) => {
				const id = paneKey(child);
				return layout[id] ?? node.sizes[index] ?? 100 / node.children.length;
			});
			actions.updateSplitSizes(node.splitId, sizes);
		},
		[actions, node.children, node.splitId, node.sizes],
	);

	return (
		<Group
			key={node.splitId}
			id={node.splitId}
			orientation={node.direction}
			onLayoutChanged={onLayoutChanged}
			className="h-full min-h-0"
		>
			{node.children.map((child, index) => (
				<Fragment key={paneKey(child)}>
					{index > 0 && (
						<Separator
							className={cn(
								"bg-border transition-colors hover:bg-[var(--color-accent)]/30",
								node.direction === "horizontal"
									? "w-px min-w-px"
									: "h-px min-h-px",
							)}
						/>
					)}
					<Panel
						id={paneKey(child)}
						defaultSize={`${node.sizes[index] ?? 100 / node.children.length}%`}
						minSize={`${MIN_PANE_PERCENT}%`}
						className="min-h-0 min-w-0"
					>
						<RenderPaneNode
							node={child}
							onOpenSwitcher={onOpenSwitcher}
							onCreate={onCreate}
						/>
					</Panel>
				</Fragment>
			))}
		</Group>
	);
}

/** Recursive pane tree renderer backed by react-resizable-panels. */
export function RenderPaneNode({
	node,
	onOpenSwitcher,
	onCreate,
}: RenderPaneNodeProps) {
	const { workspace, actions } = useWorkspace();
	const activePaneId = workspace?.activePaneId ?? "";

	if (node.type === "pane") {
		const canClose = workspace ? countPanes(workspace.paneTree) > 1 : false;
		return (
			<PaneEditor
				key={node.paneId}
				leaf={node}
				isActive={node.paneId === activePaneId}
				onFocus={() => actions.setActivePane(node.paneId)}
				onOpenSwitcher={onOpenSwitcher}
				onCreate={onCreate}
				canClose={canClose}
				onClose={() => actions.closePane(node.paneId)}
			/>
		);
	}

	return (
		<PaneSplitView
			node={node}
			onOpenSwitcher={onOpenSwitcher}
			onCreate={onCreate}
		/>
	);
}
