"use client";

import type { RefObject } from "react";
import { useEffect, useRef } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import {
	CodeMirrorEditor,
	type CodeMirrorEditorHandle,
} from "@/lib/editor/codemirror";
import type { EditorHandle } from "@/lib/editor/handle";
import {
	MilkdownEditor,
	type MilkdownEditorHandle,
} from "@/lib/editor/milkdown";
import { PreviewPane } from "@/lib/editor/preview";
import type { CaretPosition, Mode, VimSubMode } from "@/lib/modes/types";

type EditorPaneProps = {
	mode: Mode;
	markdown: string;
	pendingCaret: CaretPosition | null;
	onCaretApplied: () => void;
	richRef: RefObject<MilkdownEditorHandle | null>;
	cmRef: RefObject<CodeMirrorEditorHandle | null>;
	onChange: () => void;
	onVimModeChange?: (subMode: VimSubMode) => void;
	loading?: boolean;
};

export function EditorPane({
	mode,
	markdown,
	pendingCaret,
	onCaretApplied,
	richRef,
	cmRef,
	onChange,
	onVimModeChange,
	loading,
}: EditorPaneProps) {
	const seededModeRef = useRef<Mode | null>(null);

	useEffect(() => {
		if (loading) return;
		if (mode === "preview") {
			seededModeRef.current = mode;
			return;
		}

		const handle: EditorHandle | null =
			mode === "rich" ? richRef.current : cmRef.current;

		if (!handle) return;
		if (seededModeRef.current === mode && !pendingCaret) return;

		handle.seed(markdown, { programmatic: true });
		if (pendingCaret) {
			handle.importCaret(pendingCaret);
			onCaretApplied();
		}
		seededModeRef.current = mode;
	}, [mode, markdown, loading, pendingCaret, onCaretApplied, richRef, cmRef]);

	if (loading) {
		return (
			<div className="recto-measure flex-1 py-[var(--space-7)]">
				<Skeleton
					className="min-h-[60vh] rounded-[var(--radius-lg)]"
					aria-hidden
				/>
			</div>
		);
	}

	const surfaceClass =
		"recto-editor-body min-h-[60vh] rounded-[var(--radius-lg)] bg-card px-[var(--space-5)] py-[var(--space-6)]";

	return (
		<div className="recto-measure flex-1 py-[var(--space-7)]">
			{mode === "rich" && (
				<MilkdownEditor
					ref={richRef}
					onChange={onChange}
					className={`milkdown ${surfaceClass}`}
				/>
			)}

			{(mode === "raw" || mode === "vim") && (
				<CodeMirrorEditor
					ref={cmRef}
					vimEnabled={mode === "vim"}
					onChange={onChange}
					onVimModeChange={onVimModeChange}
					className={`codemirror ${surfaceClass} font-[family-name:var(--font-mono)] text-[length:var(--text-body)]`}
				/>
			)}

			{mode === "preview" && (
				<PreviewPane
					markdown={markdown}
					className={`recto-preview ${surfaceClass} font-[family-name:var(--font-reading)] text-[length:var(--text-body)] leading-[var(--leading-body)] text-[var(--color-ink-primary)]`}
				/>
			)}
		</div>
	);
}
