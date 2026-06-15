"use client";

import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { EditorPane } from "@/components/editor-pane";
import { EmptyState } from "@/components/empty-state";
import { StatusBar } from "@/components/status-bar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { authClient } from "@/lib/auth-client";
import type { MilkdownEditorHandle } from "@/lib/editor/milkdown";
import { useDocumentSync } from "@/lib/sync/use-document-sync";

const ACTIVE_DOC_KEY = "recto:active-document";

export function StudioShell() {
	const router = useRouter();
	const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
	const editorRef = useRef<MilkdownEditorHandle>(null);

	const [documentId, setDocumentId] = useState<Id<"documents"> | null>(null);
	const [creating, setCreating] = useState(false);
	const [editorReady, setEditorReady] = useState(false);

	const documents = useQuery(api.documents.list, isAuthenticated ? {} : "skip");
	const createDocument = useMutation(api.documents.create);

	const document = useQuery(
		api.documents.get,
		documentId && isAuthenticated ? { documentId } : "skip",
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

	const sync = useDocumentSync({
		documentId,
		editorRef,
		serverMarkdown: document?.markdown,
		serverUpdatedAt: document?.updatedAt,
		enabled: editorReady && document !== undefined && document !== null,
	});

	const handleCreate = useCallback(async () => {
		setCreating(true);
		try {
			const { documentId: newId } = await createDocument({});
			setDocumentId(newId);
			localStorage.setItem(ACTIVE_DOC_KEY, newId);
			setEditorReady(false);
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

	return (
		<div className="flex min-h-dvh flex-col">
			<header className="flex h-10 shrink-0 items-center justify-between border-b border-border px-[var(--space-4)] text-[length:var(--text-ui)] text-[var(--color-ink-secondary)]">
				<span className="truncate">{document?.title ?? "Recto"}</span>
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

						{sync.needsRehydrate && (
							<Alert
								variant="destructive"
								className="mx-auto mt-[var(--space-4)] max-w-lg border-[var(--color-warning)] bg-[var(--color-bg-raised)] text-[var(--color-ink-secondary)]"
							>
								<AlertTitle>Newer version available</AlertTitle>
								<AlertDescription className="mt-[var(--space-3)]">
									<p>Another device saved changes to this document.</p>
									<div className="mt-[var(--space-3)] flex justify-center gap-[var(--space-3)]">
										<Button onClick={sync.confirmRehydrate}>
											Reload from cloud
										</Button>
										<Button variant="ghost" onClick={sync.dismissRehydrate}>
											Keep editing
										</Button>
									</div>
								</AlertDescription>
							</Alert>
						)}

						<EditorPane
							editorRef={editorRef}
							onChange={sync.handleEditorChange}
							loading={loadingDoc || !editorReady}
						/>
					</>
				)}
			</main>

			{!showEmpty && (
				<StatusBar wordCount={sync.wordCount} syncStatus={sync.syncStatus} />
			)}
		</div>
	);
}
