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
): void {
	const record: DraftRecord = {
		markdown,
		updatedAt: Date.now(),
		origin: getClientOrigin(),
		projectionId,
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
): { markdown: string; hadConflict: boolean; draftOrigin?: string } {
	const draft = loadDraft(documentId);
	if (!draft) {
		return { markdown: serverMarkdown, hadConflict: false };
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
