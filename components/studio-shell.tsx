"use client";

import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { CommandPalette } from "@/components/command-palette";
import { EditorPane } from "@/components/editor-pane";
import { EmptyState } from "@/components/empty-state";
import { ModeToolbar } from "@/components/mode-toolbar";
import { StatusBar } from "@/components/status-bar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { authClient } from "@/lib/auth-client";
import type { CodeMirrorEditorHandle } from "@/lib/editor/codemirror";
import { createPreviewHandle } from "@/lib/editor/handle";
import type { MilkdownEditorHandle } from "@/lib/editor/milkdown";
import { createAppShortcutHandler } from "@/lib/keyboard/app-shortcuts";
import {
	type CaretPosition,
	type Mode,
	modeToLabel,
	type VimSubMode,
} from "@/lib/modes/types";
import { useDocumentSync } from "@/lib/sync/use-document-sync";

const ACTIVE_DOC_KEY = "recto:active-document";

export function StudioShell() {
	const router = useRouter();
	const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
	const shellRef = useRef<HTMLDivElement>(null);

	const richRef = useRef<MilkdownEditorHandle>(null);
	const cmRef = useRef<CodeMirrorEditorHandle>(null);

	const [mode, setMode] = useState<Mode>("rich");
	const [vimSubMode, setVimSubMode] = useState<VimSubMode>("normal");
	const [documentId, setDocumentId] = useState<Id<"documents"> | null>(null);
	const [creating, setCreating] = useState(false);
	const [editorReady, setEditorReady] = useState(false);
	// Snapshot of canonical markdown captured at the last mode switch. `null`
	// means "no snapshot yet" — fall back to the server copy. An empty string is
	// a valid snapshot (the user cleared the document), so we must not use `||`.
	const [paneMarkdown, setPaneMarkdown] = useState<string | null>(null);
	const [pendingCaret, setPendingCaret] = useState<CaretPosition | null>(null);
	const [commandOpen, setCommandOpen] = useState(false);

	const modeRef = useRef(mode);
	modeRef.current = mode;

	const paneMarkdownRef = useRef<string | null>(paneMarkdown);
	paneMarkdownRef.current = paneMarkdown;

	const documents = useQuery(api.documents.list, isAuthenticated ? {} : "skip");
	const createDocument = useMutation(api.documents.create);

	const document = useQuery(
		api.documents.get,
		documentId && isAuthenticated ? { documentId } : "skip",
	);

	const getEditorHandle = useCallback(() => {
		if (modeRef.current === "rich") return richRef.current;
		if (modeRef.current === "raw" || modeRef.current === "vim") {
			return cmRef.current;
		}
		return createPreviewHandle(() => paneMarkdownRef.current ?? "");
	}, []);

	const sync = useDocumentSync({
		documentId,
		getEditorHandle,
		serverMarkdown: document?.markdown,
		serverUpdatedAt: document?.updatedAt,
		enabled: editorReady && document !== undefined && document !== null,
	});

	const { flushMarkdown, getCurrentMarkdown } = sync;

	const switchMode = useCallback(
		(to: Mode) => {
			if (to === modeRef.current) return;
			const outgoing = getEditorHandle();
			const liveMarkdown =
				outgoing?.getCanonicalMarkdown() ?? getCurrentMarkdown();
			const caret = outgoing?.exportCaret() ?? null;

			setPaneMarkdown(liveMarkdown);
			setPendingCaret(caret);
			setMode(to);

			void flushMarkdown(liveMarkdown);
		},
		[flushMarkdown, getCurrentMarkdown, getEditorHandle],
	);

	useEffect(() => {
		if (!isAuthenticated || documents === undefined) return;
		if (documentId) return;

		const stored = localStorage.getItem(ACTIVE_DOC_KEY);
		if (stored && documents.some((d) => d._id === stored)) {
			setDocumentId(stored as Id<"documents">);
			return;
		}

		if (documents.length > 0) {
			const first = documents[0];
			if (first) {
				setDocumentId(first._id);
				localStorage.setItem(ACTIVE_DOC_KEY, first._id);
			}
		}
	}, [isAuthenticated, documents, documentId]);

	useEffect(() => {
		if (!authLoading && !isAuthenticated) {
			router.replace("/login");
		}
	}, [authLoading, isAuthenticated, router]);

	useEffect(() => {
		if (document && documentId) {
			const t = setTimeout(() => setEditorReady(true), 50);
			return () => clearTimeout(t);
		}
		setEditorReady(false);
	}, [document, documentId]);

	useEffect(() => {
		const shell = shellRef.current;
		if (!shell) return;
		const handler = createAppShortcutHandler((action) => {
			if (action.type === "open-palette") {
				setCommandOpen(true);
				return;
			}
			void switchMode(action.mode);
		});
		shell.addEventListener("keydown", handler, true);
		return () => shell.removeEventListener("keydown", handler, true);
	}, [switchMode]);

	const handleCreate = useCallback(async () => {
		setCreating(true);
		try {
			const { documentId: newId } = await createDocument({});
			setDocumentId(newId);
			localStorage.setItem(ACTIVE_DOC_KEY, newId);
			setEditorReady(false);
			setPaneMarkdown(null);
			setPendingCaret(null);
			setMode("rich");
		} finally {
			setCreating(false);
		}
	}, [createDocument]);

	const handleSignOut = useCallback(async () => {
		await authClient.signOut();
		router.replace("/login");
		router.refresh();
	}, [router]);

	if (authLoading || !isAuthenticated) {
		return (
			<div className="flex min-h-dvh items-center justify-center">
				<Skeleton className="h-8 w-32 rounded-[var(--radius-md)]" />
			</div>
		);
	}

	const showEmpty = documents !== undefined && documents.length === 0;
	const loadingDoc = documentId !== null && document === undefined;
	const displayMarkdown = paneMarkdown ?? document?.markdown ?? "";

	return (
		<div ref={shellRef} className="flex min-h-dvh flex-col">
			<header className="flex h-10 shrink-0 items-center justify-between gap-[var(--space-3)] border-b border-border px-[var(--space-4)] text-[length:var(--text-ui)] text-[var(--color-ink-secondary)]">
				<span className="min-w-0 flex-1 truncate">
					{document?.title ?? "Recto"}
				</span>
				{!showEmpty && (
					<ModeToolbar
						mode={mode}
						vimSubMode={vimSubMode}
						onModeChange={(next) => void switchMode(next)}
						onOpenCommandPalette={() => setCommandOpen(true)}
					/>
				)}
				<Button variant="ghost" size="sm" onClick={handleSignOut}>
					Sign out
				</Button>
			</header>

			<main className="flex flex-1 flex-col bg-background">
				{showEmpty ? (
					<EmptyState onCreate={handleCreate} pending={creating} />
				) : (
					<>
						{sync.pendingConflict && (
							<Alert className="mx-auto mt-[var(--space-4)] max-w-lg">
								<AlertTitle>Local draft differs</AlertTitle>
								<AlertDescription className="mt-[var(--space-3)]">
									<p>Your offline copy doesn&apos;t match the cloud version.</p>
									<div className="mt-[var(--space-3)] flex justify-center gap-[var(--space-3)]">
										<Button onClick={sync.useDraft}>Use local draft</Button>
										<Button variant="ghost" onClick={sync.useServer}>
											Use cloud copy
										</Button>
									</div>
								</AlertDescription>
							</Alert>
						)}

						<EditorPane
							mode={mode}
							markdown={displayMarkdown}
							pendingCaret={pendingCaret}
							onCaretApplied={() => setPendingCaret(null)}
							richRef={richRef}
							cmRef={cmRef}
							onChange={sync.handleEditorChange}
							onVimModeChange={setVimSubMode}
							loading={loadingDoc || !editorReady}
						/>
					</>
				)}
			</main>

			{!showEmpty && (
				<StatusBar
					wordCount={sync.wordCount}
					modeLabel={modeToLabel(mode, vimSubMode)}
					syncStatus={sync.syncStatus}
				/>
			)}

			<CommandPalette
				open={commandOpen}
				onOpenChange={setCommandOpen}
				mode={mode}
				vimSubMode={vimSubMode}
				onSwitchMode={(next) => void switchMode(next)}
			/>
		</div>
	);
}
