"use client";

import { Command } from "cmdk";
import { useMutation, useQuery } from "convex/react";
import { FilePlus, Pencil, Share2, Trash2, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ShareDialog } from "@/components/share-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { reconcileDeletedDocument } from "@/lib/workspace/operations";
import { openDocumentIdsFromTree } from "@/lib/workspace/queries";
import { useWorkspace } from "@/lib/workspace/workspace-context";

type DocumentSwitcherProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

export function DocumentSwitcher({
	open,
	onOpenChange,
}: DocumentSwitcherProps) {
	const { workspace, actions, registry } = useWorkspace();
	const documents = useQuery(api.documents.list, open ? {} : "skip");
	// Docs shared WITH the caller — a SEPARATE query (not merged into
	// documents.list) so the switcher's optimistic-update contract is untouched.
	const sharedWithMe = useQuery(
		api.review.listSharedWithMe,
		open ? {} : "skip",
	);
	const createDocument = useMutation(api.documents.create).withOptimisticUpdate(
		(localStore) => {
			const current = localStore.getQuery(api.documents.list, {});
			if (current === undefined) return;
			const now = Date.now();
			localStore.setQuery(api.documents.list, {}, [
				{
					_id: crypto.randomUUID() as Id<"documents">,
					title: "Untitled",
					wordCount: 0,
					updatedAt: now,
				},
				...current,
			]);
		},
	);
	const renameDocument = useMutation(api.documents.rename).withOptimisticUpdate(
		(localStore, args) => {
			const current = localStore.getQuery(api.documents.list, {});
			if (current === undefined) return;
			localStore.setQuery(
				api.documents.list,
				{},
				current.map((doc) =>
					doc._id === args.documentId
						? {
								...doc,
								title: args.title.trim() || "Untitled",
								updatedAt: Date.now(),
							}
						: doc,
				),
			);
		},
	);
	const removeDocument = useMutation(api.documents.remove).withOptimisticUpdate(
		(localStore, args) => {
			const current = localStore.getQuery(api.documents.list, {});
			if (current === undefined) return;
			localStore.setQuery(
				api.documents.list,
				{},
				current.filter((doc) => doc._id !== args.documentId),
			);
		},
	);

	const [renameId, setRenameId] = useState<Id<"documents"> | null>(null);
	const [renameValue, setRenameValue] = useState("");
	const [pending, setPending] = useState(false);
	const [selectedDocId, setSelectedDocId] = useState<Id<"documents"> | null>(
		null,
	);
	const [shareTarget, setShareTarget] = useState<{
		id: Id<"documents">;
		title: string;
	} | null>(null);

	const close = useCallback(() => onOpenChange(false), [onOpenChange]);
	const activePaneId = workspace?.activePaneId ?? "";

	const handleSwitch = useCallback(
		(documentId: Id<"documents">) => {
			if (!activePaneId) return;
			actions.setPaneDocument(activePaneId, documentId);
			close();
		},
		[actions, activePaneId, close],
	);

	const handleOpenInSplit = useCallback(
		(documentId: Id<"documents">) => {
			const result = actions.splitActivePane("horizontal");
			if (result) {
				actions.setPaneDocument(result.newPaneId, documentId);
			}
			close();
		},
		[actions, close],
	);

	const handleCreate = useCallback(async () => {
		setPending(true);
		try {
			const { documentId } = await createDocument({});
			if (activePaneId) {
				actions.setPaneDocument(activePaneId, documentId);
			}
			close();
		} finally {
			setPending(false);
		}
	}, [actions, activePaneId, close, createDocument]);

	const handleRename = useCallback(async () => {
		if (!renameId) return;
		setPending(true);
		try {
			await renameDocument({ documentId: renameId, title: renameValue });
			registry.markManualRename(renameId);
			setRenameId(null);
		} finally {
			setPending(false);
		}
	}, [registry, renameDocument, renameId, renameValue]);

	const handleDelete = useCallback(
		async (documentId: Id<"documents">, title: string) => {
			if (!workspace) return;
			if (
				!window.confirm(
					`Delete "${title}"? This permanently removes the document.`,
				)
			) {
				return;
			}
			setPending(true);
			try {
				await removeDocument({ documentId });
				const remaining = openDocumentIdsFromTree(workspace.paneTree).filter(
					(id) => id !== documentId,
				);
				const fallback = remaining[0] ?? null;
				const tree = reconcileDeletedDocument(
					workspace.paneTree,
					documentId,
					fallback,
				);
				actions.replaceWorkspace(tree, workspace.activePaneId);
			} finally {
				setPending(false);
			}
		},
		[actions, removeDocument, workspace],
	);

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				close();
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [open, close]);

	if (!open) return null;

	if (renameId) {
		return (
			<div
				className="recto-scrim fixed inset-0 z-[100] flex items-center justify-center p-[var(--space-4)]"
				role="dialog"
				aria-modal="true"
				aria-labelledby="recto-rename-title"
			>
				<div className="recto-panel w-full max-w-sm p-[var(--space-5)]">
					<h2
						id="recto-rename-title"
						className="text-[length:var(--text-ui)] font-[var(--font-reading)] text-[var(--color-ink-primary)]"
					>
						Rename document
					</h2>
					<Input
						className="mt-[var(--space-4)]"
						value={renameValue}
						onChange={(event) => setRenameValue(event.target.value)}
						autoFocus
					/>
					<div className="mt-[var(--space-5)] flex justify-end gap-[var(--space-2)]">
						<Button variant="ghost" onClick={() => setRenameId(null)}>
							Cancel
						</Button>
						<Button disabled={pending} onClick={() => void handleRename()}>
							Save
						</Button>
					</div>
				</div>
			</div>
		);
	}

	return (
		<>
			<div
				className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[min(20vh,8rem)]"
				role="dialog"
				aria-modal="true"
				aria-label="Document switcher"
			>
				<button
					type="button"
					className="recto-scrim absolute inset-0"
					aria-label="Close document switcher"
					onClick={close}
				/>
				<Command
					className="recto-panel relative z-10 w-full max-w-lg overflow-hidden"
					onMouseDown={(event) => event.stopPropagation()}
					onKeyDown={(event) => {
						if (event.key === "Enter" && event.shiftKey && selectedDocId) {
							event.preventDefault();
							handleOpenInSplit(selectedDocId);
						}
					}}
					loop
				>
					<div className="border-b border-[var(--color-line)] px-[var(--space-4)]">
						<Command.Input
							placeholder="Search documents…"
							autoFocus
							className="h-12 w-full bg-transparent text-[length:var(--text-ui)] text-[var(--color-ink-primary)] outline-none placeholder:text-[var(--color-ink-tertiary)]"
						/>
					</div>
					<Command.List className="max-h-80 overflow-y-auto p-[var(--space-2)]">
						<Command.Empty className="px-[var(--space-3)] py-[var(--space-6)] text-center text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
							No matching documents.
						</Command.Empty>

						<Command.Group heading="Actions">
							<Command.Item
								value="create new document"
								onSelect={() => void handleCreate()}
								className="recto-item flex cursor-pointer items-center gap-[var(--space-2)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)]"
							>
								<FilePlus
									aria-hidden
									className="size-4 text-[var(--color-ink-tertiary)]"
								/>
								<span>Create new document</span>
							</Command.Item>
						</Command.Group>

						<Command.Group heading="Documents">
							{documents?.map((doc) => (
								<Command.Item
									key={doc._id}
									value={`${doc.title} ${doc.wordCount}`}
									onSelect={() => handleSwitch(doc._id)}
									onPointerMove={() => setSelectedDocId(doc._id)}
									className="recto-item group flex cursor-pointer items-center gap-[var(--space-2)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-ui-sm)]"
								>
									<span className="min-w-0 flex-1 truncate text-[var(--color-ink-primary)]">
										{doc.title}
									</span>
									<span className="text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)] tabular-nums">
										{doc.wordCount.toLocaleString()} w
									</span>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										className="size-7 px-0 text-[var(--color-ink-tertiary)] opacity-0 transition-opacity duration-[var(--motion-fast)] group-hover:opacity-100 group-aria-selected:opacity-100"
										onClick={(event) => {
											event.stopPropagation();
											setRenameId(doc._id);
											setRenameValue(doc.title);
										}}
										aria-label={`Rename ${doc.title}`}
									>
										<Pencil aria-hidden className="size-3.5" />
									</Button>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										className="size-7 px-0 text-[var(--color-ink-tertiary)] opacity-0 transition-opacity duration-[var(--motion-fast)] group-hover:opacity-100 group-aria-selected:opacity-100"
										onClick={(event) => {
											event.stopPropagation();
											setShareTarget({ id: doc._id, title: doc.title });
										}}
										aria-label={`Share ${doc.title}`}
									>
										<Share2 aria-hidden className="size-3.5" />
									</Button>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										className="size-7 px-0 text-[var(--color-ink-tertiary)] opacity-0 transition-opacity duration-[var(--motion-fast)] hover:text-[var(--color-danger)] group-hover:opacity-100 group-aria-selected:opacity-100"
										onClick={(event) => {
											event.stopPropagation();
											void handleDelete(doc._id, doc.title);
										}}
										aria-label={`Delete ${doc.title}`}
									>
										<Trash2 aria-hidden className="size-3.5" />
									</Button>
								</Command.Item>
							))}
						</Command.Group>

						{sharedWithMe && sharedWithMe.length > 0 && (
							<Command.Group heading="Shared with you">
								{sharedWithMe.map((doc) => (
									<Command.Item
										key={doc._id}
										value={`shared ${doc.title}`}
										onSelect={() => handleSwitch(doc._id)}
										className="recto-item flex cursor-pointer items-center gap-[var(--space-2)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-ui-sm)]"
									>
										<Users
											aria-hidden
											className="size-3.5 shrink-0 text-[var(--color-ink-tertiary)]"
										/>
										<span className="min-w-0 flex-1 truncate text-[var(--color-ink-primary)]">
											{doc.title}
										</span>
										<span className="shrink-0 rounded-[var(--radius-sm)] bg-[var(--color-bg-hover)] px-[var(--space-2)] py-px text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
											{doc.role === "suggester" ? "Suggest" : "Comment"}
										</span>
									</Command.Item>
								))}
							</Command.Group>
						)}
					</Command.List>
					<div className="flex items-center gap-[var(--space-2)] border-t border-[var(--color-line)] px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
						<kbd className="recto-kbd">Enter</kbd>
						<span>switch</span>
						<span aria-hidden className="text-[var(--color-line-strong)]">
							·
						</span>
						<kbd className="recto-kbd">Shift+Enter</kbd>
						<span>open in split</span>
					</div>
				</Command>
			</div>
			<ShareDialog
				documentId={shareTarget?.id ?? null}
				title={shareTarget?.title ?? ""}
				open={shareTarget !== null}
				onOpenChange={(o) => {
					if (!o) setShareTarget(null);
				}}
			/>
		</>
	);
}
