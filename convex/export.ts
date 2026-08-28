"use node";

import { v } from "convex/values";
import { renderDocx } from "../lib/export/docx-render";
import { safeFilename } from "../lib/export/filename";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action } from "./_generated/server";

/**
 * Server-side `.docx` rendering (plan 023 §4.1(6)).
 *
 * The native apps have no DOM, no `remark`, and no appetite for shipping a
 * second Markdown pipeline that would drift from the web's. They ask the server
 * instead, and the server runs the exact renderer the browser runs
 * (`lib/export/docx-render.ts`), so a Word file exported from a Mac and one
 * exported from a browser are the same document.
 *
 * `.md` and `.html` stay local on both platforms — they are string
 * transformations of text the client already holds, and a round trip would only
 * add latency and a failure mode.
 *
 * `"use node"` because remark-docx compiles OOXML through `docx`/`jszip`, which
 * the Convex default runtime does not carry.
 */

/**
 * How long a generated file stays fetchable. Long enough for a client to
 * download it (and retry once), short enough that the store does not fill with
 * exports nobody collected. A scheduled delete enforces it — Convex storage
 * URLs do not expire on their own.
 */
export const EXPORT_TTL_MS = 15 * 60 * 1000;

/**
 * Ceiling on the produced file. `documents.markdown` is already capped near
 * 1 MiB, but tables and footnotes expand, so the guard is on the output: a
 * client that cannot be handed a file should be told, not sent a URL to
 * something it will choke on.
 */
export const MAX_DOCX_BYTES = 20 * 1024 * 1024;

export const DOCX_TOO_LARGE_MESSAGE =
	"The generated Word file is too large to deliver (20 MiB limit).";

export const docx = action({
	args: {
		documentId: v.id("documents"),
		/**
		 * Origin for absolutizing root-relative links and images, so a file
		 * exported from a preview deployment does not point at production. The
		 * client sends its own origin; native clients omit it and get the default.
		 */
		origin: v.optional(v.string()),
	},
	handler: async (
		ctx,
		args,
		// Written out rather than inferred: an action that calls `ctx.runQuery`
		// on its own deployment infers a recursive type otherwise. Keeping
		// `Id<"_storage">` here means callers do not have to cast it back.
	): Promise<{
		storageId: Id<"_storage">;
		url: string;
		filename: string;
		bytes: number;
		expiresAt: number;
	}> => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw new Error("Unauthenticated");

		// The action cannot read the database; ownership is re-checked inside the
		// internal query against the subject from the verified JWT.
		const doc = await ctx.runQuery(internal.documents.forExport, {
			documentId: args.documentId,
			userId: identity.subject,
		});
		if (!doc) throw new Error("Document not found");

		// Exporting the SERVER's canonical markdown: a client with unsynced edits
		// must flush them (the native outbox drains before export) or it gets the
		// last text the server saw, which is the only text the server can vouch for.
		const bytes = await renderDocx(doc.markdown, doc.title, args.origin);
		if (bytes.byteLength > MAX_DOCX_BYTES) {
			throw new Error(DOCX_TOO_LARGE_MESSAGE);
		}

		const storageId = await ctx.storage.store(new Blob([bytes]));
		const url = await ctx.storage.getUrl(storageId);
		if (url === null) {
			// Storing succeeded but the file is unreadable; leaving it behind would
			// be an orphan the daily sweep only reaps after its 24h grace window.
			await ctx.runMutation(internal.files.deleteStoredFile, { storageId });
			throw new Error("Export failed: stored file could not be resolved");
		}

		await ctx.scheduler.runAfter(
			EXPORT_TTL_MS,
			internal.files.deleteStoredFile,
			{ storageId },
		);

		return {
			storageId,
			url,
			filename: `${safeFilename(doc.title)}.docx`,
			bytes: bytes.byteLength,
			expiresAt: Date.now() + EXPORT_TTL_MS,
		};
	},
});
