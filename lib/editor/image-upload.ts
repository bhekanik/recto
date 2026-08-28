import { toast } from "@/lib/ui/toast";

/** Whether a clipboard/drop item is an image we should upload. */
export function isImageFile(file: File | Blob): boolean {
	return file.type.startsWith("image/");
}

type UploadImageArgs = {
	file: File | Blob;
	/** Convex HTTP-actions origin (`NEXT_PUBLIC_CONVEX_SITE_URL`). */
	siteUrl: string;
	/** A Convex-templated Clerk JWT for the current user. */
	getToken: () => Promise<string | null>;
};

type UploadResponse = { storageId?: string; url?: string; error?: string };

/**
 * Upload an image to Convex and return a servable URL plus a derived alt text.
 *
 * One POST to the server-mediated `/upload-image` endpoint, which stores the
 * bytes AND records who owns them before answering (`convex/http.ts`). The
 * previous shape — ask for a signed URL, POST the bytes to storage, then call a
 * mutation to claim the result — left a file with no owner whenever anything
 * interrupted the second step, and an unowned file is one account deletion
 * cannot find.
 *
 * Errors surface a toast and rethrow so the caller can fall through to default
 * paste behavior.
 */
export async function uploadImage(
	args: UploadImageArgs,
): Promise<{ url: string; alt: string }> {
	try {
		const token = await args.getToken();
		if (!token) throw new Error("Not signed in");

		const res = await fetch(`${args.siteUrl}/upload-image`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": args.file.type || "application/octet-stream",
			},
			body: args.file,
		});
		const body = (await res.json().catch(() => ({}))) as UploadResponse;
		if (!res.ok || !body.url) {
			throw new Error(body.error ?? `Upload failed: ${res.status}`);
		}

		const alt =
			args.file instanceof File
				? args.file.name.replace(/\.[^.]+$/, "")
				: "image";
		return { url: body.url, alt };
	} catch (error) {
		toast("Image upload failed", "error");
		throw error;
	}
}
