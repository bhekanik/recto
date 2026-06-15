"use client";

import type { RefObject } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import {
	MilkdownEditor,
	type MilkdownEditorHandle,
} from "@/lib/editor/milkdown";

type EditorPaneProps = {
	editorRef: RefObject<MilkdownEditorHandle | null>;
	onChange: () => void;
	loading?: boolean;
};

export function EditorPane({ editorRef, onChange, loading }: EditorPaneProps) {
	return (
		<div className="recto-measure flex-1 py-[var(--space-7)]">
			{loading ? (
				<Skeleton
					className="min-h-[60vh] rounded-[var(--radius-lg)]"
					aria-hidden
				/>
			) : (
				<div className="recto-editor-body rounded-[var(--radius-lg)] bg-card px-[var(--space-5)] py-[var(--space-6)]">
					<MilkdownEditor
						ref={editorRef}
						onChange={onChange}
						className="milkdown min-h-[60vh]"
					/>
				</div>
			)}
		</div>
	);
}
