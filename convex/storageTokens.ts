/**
 * Finding the stored files a piece of Markdown points at.
 *
 * A served Convex file URL looks like `.../api/storage/<token>`, and the token
 * is NOT the `_storage` document id (verified live 2026-07-05; see the comment
 * on `files.orphanSweep`). The client inserts the served URL, so that segment is
 * what actually appears in a document; the raw id is matched too, belt and
 * braces, for any text that ever embedded one.
 *
 * Shared by the account purge's foreign-reference survey and by the blob-owner
 * backfill, which ask the same question from opposite directions.
 */

/**
 * `/api/storage/<token>` as it appears inside a Markdown link or image.
 *
 * The token is matched as "everything up to a Markdown or URL delimiter"
 * rather than a fixed alphabet. Production tokens are UUIDs, but Convex does
 * not promise that — convex-test issues base64, which `[A-Za-z0-9_-]+` silently
 * truncated at the first `+`, producing a token that matched nothing. Over-
 * capturing is harmless here: a token is only ever compared for equality
 * against a real file's segment.
 */
const SERVED_URL = /\/api\/storage\/([^\s)"'<>\]]+)/g;

/**
 * A bare Convex document id: 32 characters of the id alphabet, not touching a
 * word character on either side. Deliberately narrow — a looser pattern would
 * pull in ordinary words and inflate the token set until it hit its cap.
 */
const BARE_ID = /(?<![A-Za-z0-9_-])([a-z][a-z0-9]{31})(?![A-Za-z0-9_-])/g;

/** Every storage token this text could be referring to. */
export function extractStorageTokens(text: string): string[] {
	const tokens = new Set<string>();
	for (const match of text.matchAll(SERVED_URL)) {
		if (match[1]) tokens.add(match[1]);
	}
	for (const match of text.matchAll(BARE_ID)) {
		if (match[1]) tokens.add(match[1]);
	}
	return [...tokens];
}

/**
 * The tokens a stored file could be referred to by: whatever its served URL
 * carries, plus its raw `_storage` id.
 *
 * Deliberately the SAME extraction the document side uses. Deriving one side
 * with `new URL(url).pathname.split("/").pop()` and the other with this regex
 * looks equivalent and is not: a token containing `/` is truncated by the split
 * and kept whole by the regex, so the two never match.
 */
export function storageFileTokens(
	storageId: string,
	url: string | null,
): string[] {
	const tokens = [storageId];
	if (url !== null) tokens.push(...extractStorageTokens(url));
	return tokens;
}
