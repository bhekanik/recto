const DRAFT_PREFIX = "recto:draft:";
const ORIGIN_KEY = "recto:client-origin";

export type DraftRecord = {
	markdown: string;
	updatedAt: number;
	origin: string;
	/**
	 * Identifies the unsaved work this record holds. An acknowledgement may only
	 * retire a draft whose id it names: text equality cannot tell "the write I
	 * sent came back" from "someone else's write happened to carry the same
	 * words", and a stale host acknowledging an old commit would otherwise clear
	 * a draft written after it.
	 */
	projectionId?: string;
	/**
	 * What kind of unsaved work this record holds. Without it a pending
	 * POINTER move looked like plain markdown on reload, and recovery deleted
	 * it the moment the body matched the server — losing an undo the server
	 * had never accepted.
	 */
	projectionKind?: "draft" | "commit" | "pointer";
	/** For pointer work: the node the move was trying to reach. */
	pointerNodeId?: string;
};

/** Stable per-client origin id for last-writer guard. */
export function getClientOrigin(): string {
	if (typeof window === "undefined") return "server";
	let origin = localStorage.getItem(ORIGIN_KEY);
	if (!origin) {
		origin = crypto.randomUUID();
		localStorage.setItem(ORIGIN_KEY, origin);
	}
	return origin;
}

/** Persist a local draft copy for crash/offline recovery. */
export function saveDraft(
	documentId: string,
	markdown: string,
	projectionId?: string,
	projection?: {
		kind: "draft" | "commit" | "pointer";
		pointerNodeId?: string;
	},
): void {
	const record: DraftRecord = {
		markdown,
		updatedAt: Date.now(),
		origin: getClientOrigin(),
		projectionId,
		projectionKind: projection?.kind,
		pointerNodeId: projection?.pointerNodeId,
	};
	localStorage.setItem(`${DRAFT_PREFIX}${documentId}`, JSON.stringify(record));
}

/** Read stored draft if present. */
export function loadDraft(documentId: string): DraftRecord | null {
	const raw = localStorage.getItem(`${DRAFT_PREFIX}${documentId}`);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as DraftRecord;
		if (!parsed.origin) {
			return { ...parsed, origin: getClientOrigin() };
		}
		return parsed;
	} catch {
		return null;
	}
}

/** Clear draft after successful sync. */
export function clearDraft(documentId: string): void {
	localStorage.removeItem(`${DRAFT_PREFIX}${documentId}`);
}

/** Pick fresher content between server markdown and local draft. */
export function reconcileDraft(
	serverMarkdown: string,
	serverUpdatedAt: number,
	documentId: string,
	/** The head the server is on, so pointer work can be judged against it. */
	serverHeadNodeId?: string,
): {
	markdown: string;
	hadConflict: boolean;
	draftOrigin?: string;
	/** Pointer work still waiting: the node the writer was trying to reach. */
	pendingPointerNodeId?: string;
	/** Identity of the surviving work, so its acknowledgement can name it. */
	projectionId?: string;
	/** What kind of work survived, so a markdown write cannot retire it. */
	projectionKind?: "draft" | "commit" | "pointer";
} {
	const draft = loadDraft(documentId);
	if (!draft) {
		return { markdown: serverMarkdown, hadConflict: false };
	}

	// Pointer work is judged against the HEAD, not the body. A move changes no
	// text, so an identical body says nothing about whether it landed — deleting
	// it on that basis lost undos the server had never accepted.
	if (draft.projectionKind === "pointer" && draft.pointerNodeId) {
		if (serverHeadNodeId === draft.pointerNodeId) {
			// The head is where the move was going: it landed after all.
			clearDraft(documentId);
			return { markdown: serverMarkdown, hadConflict: false };
		}
		return {
			markdown: draft.markdown,
			hadConflict: draft.markdown !== serverMarkdown,
			draftOrigin: draft.origin,
			pendingPointerNodeId: draft.pointerNodeId,
			projectionId: draft.projectionId,
			projectionKind: "pointer",
		};
	}

	if (draft.markdown === serverMarkdown) {
		clearDraft(documentId);
		return { markdown: serverMarkdown, hadConflict: false };
	}

	if (draft.updatedAt > serverUpdatedAt) {
		return {
			markdown: draft.markdown,
			hadConflict: true,
			draftOrigin: draft.origin,
			projectionId: draft.projectionId,
			projectionKind: draft.projectionKind ?? "draft",
		};
	}

	clearDraft(documentId);
	return { markdown: serverMarkdown, hadConflict: false };
}

/** True when this client wrote the draft (not a remote device). */
export function isOwnDraftOrigin(draftOrigin: string | undefined): boolean {
	if (!draftOrigin) return false;
	return draftOrigin === getClientOrigin();
}

/** A fresh identity for a unit of unsaved work (S2). */
export function newProjectionId(): string {
	return crypto.randomUUID();
}
