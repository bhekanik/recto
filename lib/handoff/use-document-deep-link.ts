"use client";

import { useQuery } from "convex/react";
import { useEffect, useRef } from "react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

import {
	isPlausibleDocumentId,
	parseDocSearchParam,
	resolveDocumentDeepLink,
	stripDocSearchParam,
} from "./document-link";

/**
 * Apply `/?doc=<id>` once the workspace has hydrated, then strip the param
 * with `history.replaceState` so a refresh does not re-apply it.
 */
export function useDocumentDeepLink(args: {
	enabled: boolean;
	documents: { _id: string }[] | undefined;
	activePaneId: string | undefined;
	setPaneDocument: (paneId: string, documentId: Id<"documents">) => void;
}): void {
	const applied = useRef(false);
	const param =
		typeof window === "undefined"
			? null
			: parseDocSearchParam(window.location.search);

	const listed =
		args.documents !== undefined && param !== null
			? args.documents.some((doc) => doc._id === param)
			: false;
	const needsAccessQuery =
		args.enabled &&
		args.documents !== undefined &&
		param !== null &&
		isPlausibleDocumentId(param) &&
		!listed;

	const access = useQuery(
		api.review.documentShareState,
		needsAccessQuery ? { documentId: param as Id<"documents"> } : "skip",
	);

	useEffect(() => {
		if (applied.current) return;
		if (!args.enabled || !args.activePaneId || args.documents === undefined) {
			return;
		}
		const current =
			typeof window === "undefined"
				? null
				: parseDocSearchParam(window.location.search);
		const listedIds = new Set(args.documents.map((doc) => doc._id));
		const resolution = resolveDocumentDeepLink({
			param: current,
			listedIds,
			access: listedIds.has(current ?? "")
				? { role: "owner" }
				: needsAccessQuery
					? access
					: current !== null && !isPlausibleDocumentId(current)
						? null
						: undefined,
		});
		if (resolution.kind === "wait") return;
		if (resolution.kind === "open") {
			args.setPaneDocument(
				args.activePaneId,
				resolution.documentId as Id<"documents">,
			);
		}
		window.history.replaceState(
			null,
			"",
			stripDocSearchParam(window.location.href),
		);
		applied.current = true;
	}, [
		args.enabled,
		args.activePaneId,
		args.documents,
		args.setPaneDocument,
		access,
		needsAccessQuery,
	]);
}
