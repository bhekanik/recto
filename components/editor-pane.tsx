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
import { cn } from "@/lib/utils";

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

/**
 * Focus an editor, retrying once on the next frame so Milkdown (which mounts
 * asynchronously) reliably receives focus after a mode switch.
 */
function focusEditor(handle: EditorHandle): void {
	handle.focus();
	requestAnimationFrame(() => handle.focus());
}

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
	// Tracks the last mode we seeded/focused. `null` until the first run so we
	// can tell an initial mount apart from a user-initiated mode switch.
	const lastModeRef = useRef<Mode | null>(null);

	// Seeding policy:
	//  - Initial mount: the sync hook owns the first seed (it reconciles drafts +
	//    version state), so here we only focus.
	//  - Mode switch: seed the incoming editor from the snapshot captured at
	//    switch time, restore the caret, then focus.
	//  - Markdown-only change (autosave echo): do nothing — re-seeding would reset
	//    the caret while the user is typing.
	useEffect(() => {
		if (loading) return;

		const previousMode = lastModeRef.current;
		const isInitial = previousMode === null;
		const isModeSwitch = previousMode !== null && previousMode !== mode;
		if (!isInitial && !isModeSwitch) return;

		if (mode === "preview") {
			lastModeRef.current = mode;
			return;
		}

		let cancelled = false;

		const run = (): boolean => {
			if (cancelled) return true;

			const handle: EditorHandle | null =
				mode === "rich" ? richRef.current : cmRef.current;
			if (!handle) return false;

			if (isModeSwitch) {
				handle.seed(markdown, { programmatic: true });
				if (pendingCaret) {
					handle.importCaret(pendingCaret);
					onCaretApplied();
				}
			}

			focusEditor(handle);
			lastModeRef.current = mode;
			return true;
		};

		if (run()) return;

		const interval = window.setInterval(() => {
			if (run()) window.clearInterval(interval);
		}, 16);

		return () => {
			cancelled = true;
			window.clearInterval(interval);
		};
	}, [mode, markdown, pendingCaret, loading, onCaretApplied, richRef, cmRef]);

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
		"recto-editor-body h-full min-h-[60vh] rounded-[var(--radius-lg)] bg-card px-[var(--space-5)] py-[var(--space-6)]";

	const paneClass = (active: boolean) =>
		cn(
			"absolute inset-0 overflow-auto",
			active
				? "pointer-events-auto z-10 opacity-100"
				: "pointer-events-none z-0 opacity-0",
		);

	const isCode = mode === "raw" || mode === "vim";

	return (
		<div className="recto-measure flex-1 py-[var(--space-7)]">
			<div className="relative min-h-[60vh]">
				<div className={paneClass(mode === "rich")} inert={mode !== "rich"}>
					<MilkdownEditor
						ref={richRef}
						onChange={onChange}
						className={`milkdown ${surfaceClass}`}
					/>
				</div>

				<div className={paneClass(isCode)} inert={!isCode}>
					<CodeMirrorEditor
						ref={cmRef}
						vimEnabled={mode === "vim"}
						onChange={onChange}
						onVimModeChange={onVimModeChange}
						className={`codemirror ${surfaceClass} font-[family-name:var(--font-mono)] text-[length:var(--text-body)]`}
					/>
				</div>

				<div
					className={paneClass(mode === "preview")}
					inert={mode !== "preview"}
				>
					<PreviewPane
						markdown={markdown}
						className={`recto-preview ${surfaceClass} font-[family-name:var(--font-reading)] text-[length:var(--text-body)] leading-[var(--leading-body)] text-[var(--color-ink-primary)]`}
					/>
				</div>
			</div>
		</div>
	);
}
