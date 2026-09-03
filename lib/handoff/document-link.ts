/**
 * Shared document handoff between the web app and the macOS app.
 *
 * Web → Mac: `recto://document/<convexId>`
 * Mac → Web: `/?doc=<convexId>`
 */

export const DOC_QUERY_PARAM = "doc";
export const MAC_APP_SCHEME = "recto";

type NavigatorPlatform = {
	platform?: string;
	maxTouchPoints?: number;
	userAgentData?: { platform?: string };
};

export function isMacOSPlatform(
	nav: NavigatorPlatform | undefined = typeof navigator === "undefined"
		? undefined
		: navigator,
): boolean {
	if (!nav) return false;
	// Desktop-mode Safari on iPadOS reports platform "MacIntel" too; the Mac
	// app can't be there, and a touch screen is what tells the two apart.
	if ((nav.maxTouchPoints ?? 0) > 0) return false;
	if (nav.userAgentData?.platform === "macOS") return true;
	return typeof nav.platform === "string" && /Mac/.test(nav.platform);
}

export function parseDocSearchParam(search: string): string | null {
	const raw = search.startsWith("?") ? search.slice(1) : search;
	const value = new URLSearchParams(raw).get(DOC_QUERY_PARAM)?.trim() ?? "";
	return value.length > 0 ? value : null;
}

/** Path + search + hash with `doc` removed, for `history.replaceState`. */
export function stripDocSearchParam(href: string): string {
	const url = new URL(href);
	url.searchParams.delete(DOC_QUERY_PARAM);
	return `${url.pathname}${url.search}${url.hash}`;
}

export function macAppDocumentURL(documentId: string): string {
	return `${MAC_APP_SCHEME}://document/${documentId}`;
}

export function webDocumentURL(origin: string, documentId: string): string {
	const base = origin.replace(/\/+$/, "");
	const url = new URL(`${base}/`);
	url.searchParams.set(DOC_QUERY_PARAM, documentId);
	return url.toString();
}

/**
 * Convex document ids are opaque tokens. Reject values that cannot be a query
 * argument, so `?doc=../x` never hits the backend.
 */
export function isPlausibleDocumentId(value: string): boolean {
	return /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

export type DeepLinkResolution =
	| { kind: "wait" }
	| { kind: "open"; documentId: string }
	| { kind: "clear" };

/**
 * Decide what `?doc=` should do once the workspace and document list have
 * loaded. `access` is the share-state query: undefined still in flight, null
 * no access, object the signed-in user can open it (owner or grantee).
 */
export function resolveDocumentDeepLink(args: {
	param: string | null;
	listedIds: ReadonlySet<string>;
	access: { role: string } | null | undefined;
}): DeepLinkResolution {
	if (args.param === null || args.param.length === 0) return { kind: "clear" };
	if (!isPlausibleDocumentId(args.param)) return { kind: "clear" };
	if (args.listedIds.has(args.param)) {
		return { kind: "open", documentId: args.param };
	}
	if (args.access === undefined) return { kind: "wait" };
	if (args.access !== null) return { kind: "open", documentId: args.param };
	return { kind: "clear" };
}
